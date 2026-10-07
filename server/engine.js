'use strict';
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const deriv = require('./deriv');
const { computeSeries, snapshot, localScore } = require('./indicators');
const { askClaude } = require('./claude');
const catalogLib = require('./catalog');

const TRADES_FILE = path.join(__dirname, '..', 'data', 'trades.json');
const GRANS = { '15m': 900, '1h': 3600 };

class Engine extends EventEmitter {
  constructor() {
    super();
    this.creds = { token: '', appId: '' };
    this.accounts = [];
    this.account = null;          // { account_id, account_type, currency, balance }
    this.pub = null;              // socket público (velas)
    this.trade = null;            // socket de negociação da conta ativa
    this.symbol = 'R_100';
    this.tf = '15m';
    this.candles = [];
    this.subId = null;
    this.serverOffset = 0;        // segundos (hora Deriv - hora local)
    this.mode = 'manual';         // manual | auto | catalog
    this.running = false;
    this.cfg = { stake: 1, minConfidence: 0.7, maxLoss: 10, maxConsecLosses: 3, maxTrades: 20, windowPct: 0.1 };
    this.signal = null;
    this.open = null;             // operação aberta
    this.session = this._newSession();
    this.trades = this._loadTrades();
    this.catalog = null;
    this.signalSeq = 0;
    this.feedDelayMs = null;
    this.busy = false;
  }

  // ---------- util ----------
  now() { return Date.now() / 1000 + this.serverOffset; }
  gran() { return GRANS[this.tf]; }
  log(msg, level = 'info') { this.emit('log', { t: Date.now(), level, msg }); }
  _newSession() { return { pnl: 0, trades: 0, wins: 0, losses: 0, consec: 0 }; }
  _loadTrades() { try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch { return []; } }
  _saveTrades() { fs.mkdirSync(path.dirname(TRADES_FILE), { recursive: true }); fs.writeFileSync(TRADES_FILE, JSON.stringify(this.trades.slice(-2000))); }

  publicState() {
    return {
      connected: !!this.account,
      accounts: this.accounts.map(a => ({ id: a.account_id, type: a.account_type, currency: a.currency, balance: a.balance })),
      account: this.account && { id: this.account.account_id, type: this.account.account_type, currency: this.account.currency, balance: this.account.balance },
      symbol: this.symbol, tf: this.tf, mode: this.mode, running: this.running, cfg: this.cfg,
      session: this.session, latency: this.trade ? this.trade.latencyMs : (this.pub ? this.pub.latencyMs : null),
      feedDelayMs: this.feedDelayMs, serverNow: this.now(),
      catalog: this.catalog && { validated: this.catalog.validated, rulesTested: this.catalog.rulesTested, candles: this.catalog.candles, createdAt: this.catalog.createdAt },
      hasClaude: !!process.env.ANTHROPIC_API_KEY,
      open: this.open && this._openView(),
      signal: this.signal,
    };
  }
  push() { this.emit('state', this.publicState()); }

  // ---------- conexão ----------
  async connect(token, appId) {
    this.creds = { token, appId };
    this.accounts = await deriv.listAccounts(token, appId);
    if (!this.accounts.length) throw new Error('nenhuma conta de opções encontrada para este token');
    await this._ensurePublic();
    await this.selectAccount((this.accounts.find(a => a.account_type === 'demo') || this.accounts[0]).account_id);
  }

  async _ensurePublic() {
    if (this.pub) return;
    this.pub = deriv.publicSocket();
    this.pub.on('message', m => this._onPublic(m));
    this.pub.on('latency', () => this.push());
    this.pub.on('reconnected', () => this.subscribeCandles().catch(e => this.log(e.message, 'error')));
    this.pub.on('warn', m => this.log(m, 'warn'));
    await this.pub.connect();
    try { const t = await this.pub.send({ time: 1 }); this.serverOffset = t.time - Date.now() / 1000; } catch {}
    await this.subscribeCandles();
  }

  async selectAccount(id) {
    if (this.open) throw new Error('feche a operação aberta antes de trocar de conta');
    const acc = this.accounts.find(a => a.account_id === id);
    if (!acc) throw new Error('conta inválida');
    if (this.running) this.stop('troca de conta');
    if (this.trade) { this.trade.removeAllListeners(); this.trade.close(); this.trade = null; }
    this.trade = deriv.tradingSocket(this.creds.token, this.creds.appId, id);
    this.trade.on('message', m => this._onTrade(m));
    this.trade.on('latency', () => this.push());
    this.trade.on('warn', m => this.log(m, 'warn'));
    this.trade.on('reconnected', () => {
      if (this.open) this.trade.send({ proposal_open_contract: 1, contract_id: this.open.id }, { subscribe: true }).catch(() => {});
    });
    await this.trade.connect();
    this.account = acc;
    this.session = this._newSession();
    this.log(`Conta ${acc.account_type === 'demo' ? 'DEMO' : 'REAL'} ${id} conectada`);
    this.push();
  }

  // ---------- velas ----------
  async subscribeCandles() {
    if (this.subId) { this.pub.send({ forget: this.subId }).catch(() => {}); this.subId = null; }
    const res = await this.pub.send({ ticks_history: this.symbol, style: 'candles', granularity: this.gran(), count: 500, end: 'latest' }, { subscribe: true, timeoutMs: 30000 });
    this.subId = res.subscription && res.subscription.id;
    this.candles = (res.candles || []).map(c => ({ epoch: c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
    this.catalog = catalogLib.load(this.symbol, this.gran());
    this.signal = null;
    this.emit('candles', { symbol: this.symbol, tf: this.tf, candles: this.candles });
    this.push();
  }

  async setMarket(symbol, tf) {
    if (this.open) throw new Error('há operação aberta');
    if (this.running) this.stop('mercado alterado');
    if (symbol) this.symbol = symbol;
    if (tf && GRANS[tf]) this.tf = tf;
    await this.subscribeCandles();
  }

  _onPublic(m) {
    if (!m.ohlc) return;
    const o = m.ohlc;
    if (o.granularity && o.granularity !== this.gran()) return;
    if (o.symbol && o.symbol !== this.symbol) return;
    const c = { epoch: +o.open_time, open: +o.open, high: +o.high, low: +o.low, close: +o.close };
    const last = this.candles[this.candles.length - 1];
    if (last && last.epoch === c.epoch) {
      this.candles[this.candles.length - 1] = c;
      this.emit('candle', c);
      return;
    }
    if (last && c.epoch > last.epoch) {
      this.candles.push(c);
      if (this.candles.length > 600) this.candles.shift();
      this.feedDelayMs = Math.round((this.now() - c.epoch) * 1000);
      this.emit('candle', c);
      this._onCandleClosed(this.candles.length - 2, c).catch(e => this.log('sinal: ' + e.message, 'error'));
      this.push();
    }
  }

  // ---------- sinais ----------
  async _onCandleClosed(i, newCandle) {
    const candles = this.candles;
    if (i < 35) return;
    this.signal = null;
    this.emit('signal', null);

    const series = computeSeries(candles);
    const snap = snapshot(candles, series, i);
    const local = localScore(snap);
    const matches = catalogLib.matchRules(this.catalog, candles, series, i);
    let rule = null;
    if (matches.length) rule = matches.sort((a, b) => b.testWilson - a.testWilson)[0];

    let direction = local.direction;
    if (this.mode === 'catalog') {
      if (!rule) return;              // modo catálogo só opera quando há regra validada
      direction = rule.direction;
    } else if (!direction || Math.abs(local.score) < 20) {
      return;                         // sem confluência mínima: nenhum sinal
    }

    let ai = null;
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        ai = await askClaude({
          ativo: this.symbol, timeframe: this.tf,
          proposta_local: direction, pontuacao_local: local.score, motivos_locais: local.reasons,
          ultima_vela_fechada: candles[i],
          indicadores: { rsi: snap.rsi, tendencia_ema: snap.emaTrend, macd_hist: snap.macdHist, macd_hist_anterior: snap.macdHistPrev, posicao_bollinger_0a1: snap.bbPos, atr: snap.atr },
          padroes: snap.patterns,
          regra_catalogo: rule ? { condicoes: rule.key, direcao: rule.direction, taxa_fora_da_amostra: rule.testRate, amostras: rule.testN } : null,
          ultimas_velas: candles.slice(i - 11, i + 1),
        });
      } catch (e) { this.log('Claude indisponível: ' + e.message, 'warn'); }
    }
    if (ai) {
      if (ai.direction === 'NONE' || ai.direction !== direction) return; // IA discorda ou sem vantagem
    } else if (this.mode !== 'manual') {
      return; // bots exigem a validação da IA
    }

    const window = Math.round(this.gran() * this.cfg.windowPct);
    this.signal = {
      id: ++this.signalSeq, direction, kind: this.mode === 'catalog' ? 'catalogo' : 'indicadores',
      confidence: ai ? ai.confidence : null, reason: ai ? ai.reason : local.reasons.join(', '),
      ai: !!ai, rule: rule ? { key: rule.key, rate: rule.testRate, n: rule.testN } : null,
      candleOpen: newCandle.epoch, expiresAt: newCandle.epoch + window, price: newCandle.open,
      basePrice: candles[i].close,
    };
    this.emit('signal', this.signal);
    this.push();

    if (this.running && this.mode !== 'manual') {
      let prob = this.signal.confidence || 0;
      if (rule) prob = Math.min(prob, rule.testRate);
      if (prob >= this.cfg.minConfidence) {
        await this.placeTrade(direction, 'bot').catch(e => this.log('entrada do bot falhou: ' + e.message, 'error'));
      } else {
        this.log(`Sinal ${direction} ignorado: probabilidade ${(prob * 100).toFixed(0)}% < ${(this.cfg.minConfidence * 100).toFixed(0)}%`);
      }
    }
  }

  // ---------- risco ----------
  riskBlock() {
    const s = this.session, c = this.cfg;
    if (c.maxLoss > 0 && -s.pnl >= c.maxLoss) return `limite de perda atingido (${(-s.pnl).toFixed(2)})`;
    if (c.maxConsecLosses > 0 && s.consec >= c.maxConsecLosses) return `${s.consec} perdas seguidas`;
    if (c.maxTrades > 0 && s.trades >= c.maxTrades) return `limite de ${c.maxTrades} operações`;
    return null;
  }

  // ---------- operações ----------
  async placeTrade(direction, source = 'manual') {
    if (!this.trade || !this.account) throw new Error('conta não conectada');
    if (this.open || this.busy) throw new Error('já existe uma operação em andamento');
    if (!['CALL', 'PUT'].includes(direction)) throw new Error('direção inválida');
    const block = this.riskBlock();
    if (block) { if (source === 'bot') this.stop(block); throw new Error(block); }
    const stake = Number(this.cfg.stake);
    if (!(stake >= 0.35)) throw new Error('valor de entrada inválido (mínimo 0,35)');
    if (this.account.balance < stake) throw new Error('saldo insuficiente');

    const candleOpen = this.candles[this.candles.length - 1].epoch;
    const expiry = candleOpen + this.gran();
    if (expiry - this.now() < 60) throw new Error('vela quase fechando; aguarde a próxima');

    this.busy = true;
    const t = { decisionAt: Date.now(), decisionPrice: this.candles[this.candles.length - 1].close };
    try {
      const prop = await this.trade.send({
        proposal: 1, contract_type: direction, underlying_symbol: this.symbol,
        currency: this.account.currency, amount: stake, basis: 'stake', date_expiry: expiry,
      });
      t.proposalAt = Date.now();
      const p = prop.proposal;
      const buy = await this.trade.send({ buy: p.id, price: Math.max(stake, +p.ask_price) });
      t.buyAt = Date.now();
      const b = buy.buy;
      this.account.balance = b.balance_after;
      this.open = {
        id: b.contract_id, direction, source, symbol: this.symbol, tf: this.tf, account: this.account.account_id,
        accountType: this.account.account_type, stake: b.buy_price, payout: b.payout,
        startTime: b.start_time, expiry, candleOpen, longcode: b.longcode,
        decisionPrice: t.decisionPrice, entrySpot: null, current: null, lat: {
          proposalMs: t.proposalAt - t.decisionAt, buyMs: t.buyAt - t.proposalAt, totalMs: t.buyAt - t.decisionAt,
          pingMs: this.trade.latencyMs,
        },
      };
      this.session.trades++;
      this.log(`Entrada ${direction} ${this.account.account_type === 'demo' ? 'DEMO' : 'REAL'} ${stake} · ${t.buyAt - t.decisionAt} ms`);
      this.trade.send({ proposal_open_contract: 1, contract_id: b.contract_id }, { subscribe: true }).catch(e => this.log(e.message, 'error'));
      this.push();
      this.emit('trade_open', this._openView());
    } finally { this.busy = false; }
  }

  _openView() { const o = this.open; return o && { ...o, now: this.now() }; }

  async sellEarly() {
    if (!this.open) throw new Error('nenhuma operação aberta');
    await this.trade.send({ sell: this.open.id, price: 0 });
  }

  _onTrade(m) {
    if (m.balance && m.balance.balance != null && this.account) { this.account.balance = m.balance.balance; }
    const poc = m.proposal_open_contract;
    if (!poc || !this.open || poc.contract_id !== this.open.id) return;
    const o = this.open;
    if (poc.entry_spot != null && o.entrySpot == null) {
      o.entrySpot = +poc.entry_spot;
      o.slip = (o.direction === 'CALL' ? o.entrySpot - o.decisionPrice : o.decisionPrice - o.entrySpot); // >0 = a favor
    }
    o.current = poc.current_spot != null ? +poc.current_spot : o.current;
    o.profit = poc.profit != null ? +poc.profit : o.profit;
    o.canSell = !!poc.is_valid_to_sell;
    if (poc.is_sold || poc.status === 'won' || poc.status === 'lost') this._closeTrade(poc);
    else this.emit('trade_update', this._openView());
  }

  _closeTrade(poc) {
    const o = this.open; this.open = null;
    const profit = +poc.profit;
    const exit = poc.exit_tick != null ? +poc.exit_tick : poc.sell_spot != null ? +poc.sell_spot : o.current;
    const win = profit > 0;
    const rec = { ...o, exitSpot: exit, profit, win, closedAt: Date.now(), earlyExit: poc.exit_tick == null && poc.date_expiry && poc.sell_time && poc.sell_time < poc.date_expiry };
    this.trades.push(rec); this._saveTrades();
    const s = this.session;
    s.pnl += profit; if (win) { s.wins++; s.consec = 0; } else { s.losses++; s.consec++; }
    this.log(`${win ? 'GANHOU' : 'PERDEU'} ${profit.toFixed(2)} · saldo ${this.account.balance}`, win ? 'ok' : 'warn');
    this.emit('trade_closed', rec);
    const block = this.running ? this.riskBlock() : null;
    if (block) this.stop(block);
    this.refreshBalance();
    this.push();
  }

  async refreshBalance() {
    try {
      this.accounts = await deriv.listAccounts(this.creds.token, this.creds.appId);
      const a = this.accounts.find(x => x.account_id === this.account.account_id);
      if (a) { this.account = a; this.push(); }
    } catch {}
  }

  // ---------- bot ----------
  start(mode) {
    if (!['auto', 'catalog'].includes(mode)) throw new Error('modo inválido');
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('configure a chave da Claude para usar o bot');
    if (mode === 'catalog' && !(this.catalog && this.catalog.validated)) throw new Error('catálogo sem regras validadas para este ativo/tempo');
    this.mode = mode; this.running = true; this.session = this._newSession();
    this.log(`Bot ${mode === 'auto' ? 'automático' : 'por catálogo'} iniciado (${this.account.account_type === 'demo' ? 'DEMO' : 'REAL'})`);
    this.push();
  }
  stop(reason = 'parado pelo usuário') {
    if (!this.running) return;
    this.running = false;
    this.mode = 'manual';
    this.log(`Bot parado: ${reason}`, 'warn');
    this.emit('alert', { reason });
    this.push();
  }

  setConfig(c) {
    for (const k of Object.keys(this.cfg)) if (c[k] != null && !Number.isNaN(Number(c[k]))) this.cfg[k] = Number(c[k]);
    this.push();
  }

  // ---------- catálogo ----------
  async buildCatalog(pages = 4) {
    const sym = this.symbol, gran = this.gran();
    const hist = await catalogLib.fetchHistory(this.pub, sym, gran, pages, p => this.emit('catalog_progress', p));
    const payouts = this.trades.filter(t => t.payout && t.stake).map(t => t.stake / t.payout);
    const breakeven = payouts.length ? payouts.reduce((a, b) => a + b, 0) / payouts.length : 0.52;
    const cat = catalogLib.buildCatalog(hist, { breakeven });
    catalogLib.save(sym, gran, cat);
    if (sym === this.symbol && gran === this.gran()) this.catalog = cat;
    this.emit('catalog', cat);
    this.push();
    return cat;
  }

  // ---------- diagnóstico (mede, não presume) ----------
  diagnostics(accountType) {
    const ts = this.trades.filter(t => !accountType || t.accountType === accountType);
    const n = ts.length;
    if (!n) return { n: 0 };
    const wins = ts.filter(t => t.win).length;
    const be = ts.reduce((a, t) => a + t.stake / t.payout, 0) / n;
    const sd = Math.sqrt(n * be * (1 - be));
    const z = sd ? (wins - n * be) / sd : 0;
    const withSlip = ts.filter(t => t.slip != null);
    const adverse = withSlip.filter(t => t.slip < 0).length;
    const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    return {
      n, wins, winRate: wins / n, breakEven: be, z,
      pnl: ts.reduce((a, t) => a + t.profit, 0),
      avgTotalMs: avg(ts.map(t => t.lat && t.lat.totalMs).filter(Number.isFinite)),
      avgPingMs: avg(ts.map(t => t.lat && t.lat.pingMs).filter(Number.isFinite)),
      slipSamples: withSlip.length, adverseShare: withSlip.length ? adverse / withSlip.length : null,
      avgSlip: avg(withSlip.map(t => t.slip)),
    };
  }
}

module.exports = { Engine, GRANS };
