'use strict';
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const deriv = require('./deriv');
const { computeSeries, snapshot, localScore } = require('./indicators');
const { askClaude } = require('./claude');
const catalogLib = require('./catalog');
const prob = require('./probability');

const TRADES_FILE = path.join(__dirname, '..', 'data', 'trades.json');
const SIGNALS_FILE = path.join(__dirname, '..', 'data', 'signals.json');
const GRANS = { '5m': 300, '15m': 900, '1h': 3600 };
const EXPIRIES = [5, 15];                      // minutos; independente do timeframe
const STRATEGY = 'indicadores-v1';
const SOURCE = 'Deriv API oficial (WebSocket público)';

class Engine extends EventEmitter {
  constructor() {
    super();
    this.creds = { token: '', appId: '' };
    this.accounts = [];
    this.account = null;          // { account_id, account_type, currency, balance }
    this.pub = null;              // socket público (velas)
    this.trade = null;            // socket de negociação da conta ativa
    this.symbol = 'R_100';
    this.tf = '5m';
    this.candles = [];
    this.subId = null;
    this.serverOffset = 0;        // segundos (hora Deriv - hora local)
    this.mode = 'manual';         // manual | auto | catalog
    this.running = false;
    this.cfg = { stake: 1, minConfidence: 0.7, maxLoss: 10, maxConsecLosses: 3, maxTrades: 20, windowPct: 0.1, expiryMin: 5, maxDataAgeSec: 20, minProb: 0.56, minSamples: 40 };
    this.hist = [];               // histórico longo de velas fechadas (Deriv)
    this.model = null;            // tabela de probabilidade
    this.prob = null;             // estimativa ao vivo
    this.tickLatencyMs = null;
    this._histKey = null;
    this.tradingEnabled = process.env.TRADING_ENABLED === '1'; // MVP: só análise, sem ordens
    this.lastTickAt = null;       // hora local do último dado recebido
    this.dataState = 'desconectado';
    this.blockReason = 'sem dados da fonte';
    this.signals = this._loadSignals();
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
  _loadSignals() { try { return JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8')); } catch { return []; } }
  _saveSignals() { fs.mkdirSync(path.dirname(SIGNALS_FILE), { recursive: true }); fs.writeFileSync(SIGNALS_FILE, JSON.stringify(this.signals.slice(-2000))); }
  _record(sig) { const i = this.signals.findIndex(x => x.uid === sig.uid); if (i >= 0) this.signals[i] = { ...sig }; else this.signals.push({ ...sig }); this._saveSignals(); }
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
      tradingEnabled: this.tradingEnabled, source: SOURCE, market: 'sintético Deriv (não OTC)',
      dataState: this.dataState, blockReason: this.blockReason,
      dataAgeMs: this.lastTickAt ? Date.now() - this.lastTickAt : null,
      lastPrice: this.candles.length ? this.candles[this.candles.length - 1].close : null,
      expiries: EXPIRIES, tfs: Object.keys(GRANS), prob: this.prob, tickLatencyMs: this.tickLatencyMs,
      model: this.model && { name: this.model.model, horizon: this.model.horizon, samples: this.model.samples, ties: this.model.ties, from: this.model.from, to: this.model.to },
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

  // Dados de mercado não exigem token: o gráfico e os sinais funcionam sem conta.
  async startPublic() {
    clearInterval(this._watch);
    this._watch = setInterval(() => this.checkFreshness(), 1000);
    if (this._watch.unref) this._watch.unref();
    try { await this._ensurePublic(); }
    catch (e) {
      if (this.pub) { this.pub.removeAllListeners(); this.pub.close(); this.pub = null; }
      this.log(`fonte indisponível (${e.message}); nova tentativa em 10 s`, 'warn');
      clearTimeout(this._retry);
      this._retry = setTimeout(() => this.startPublic().catch(() => {}), 10000);
      if (this._retry.unref) this._retry.unref();
      throw e;
    }
  }

  // Bloqueia sinais quando a fonte está desconectada ou atrasada.
  checkFreshness(nowMs = Date.now()) {
    const prev = this.dataState;
    const age = this.lastTickAt ? (nowMs - this.lastTickAt) / 1000 : Infinity;
    if (!this.pub || !this.lastTickAt) { this.dataState = 'desconectado'; this.blockReason = 'sem dados da fonte'; }
    else if (age > this.cfg.maxDataAgeSec) { this.dataState = 'desatualizado'; this.blockReason = `último dado há ${Math.round(age)} s (limite ${this.cfg.maxDataAgeSec} s)`; }
    else { this.dataState = 'ok'; this.blockReason = null; }
    if (this.dataState !== 'ok' && this.signal && this.signal.status === 'valido') this._invalidate('dados ' + this.dataState);
    if (this.signal && this.signal.status === 'valido' && this.now() >= this.signal.expiresAt) {
      this.signal.status = 'expirado'; this._record(this.signal); this.emit('signal', this.signal);
    }
    if (prev !== this.dataState) {
      this.log(`Fonte: ${this.dataState}${this.blockReason ? ' — ' + this.blockReason : ''}`, this.dataState === 'ok' ? 'ok' : 'warn');
      if (prev === 'ok' || this.dataState === 'ok') this.emit('notify', { kind: this.dataState === 'ok' ? 'retomada' : 'dados', text: this.dataState === 'ok' ? 'Dados restabelecidos' : 'Sinais suspensos: ' + this.blockReason });
      this.push();
    }
  }

  _invalidate(reason) {
    const s = this.signal; if (!s) return;
    s.status = 'invalidado'; s.invalidReason = reason; s.invalidAt = Date.now();
    this._record(s);
    this.emit('signal', s);
    this.emit('notify', { kind: 'invalidado', text: `Sinal ${s.direction} invalidado: ${reason}` });
  }

  // Resultado observado: compara o preço de referência com o fechamento da vela que termina na expiração.
  _evaluateSignals() {
    const g = this.gran(), byEpoch = new Map(this.candles.map(c => [c.epoch, c]));
    let changed = false;
    for (const s of this.signals) {
      if (s.outcome || s.symbol !== this.symbol || s.tf !== this.tf) continue;
      if (s.status === 'invalidado') { s.outcome = 'não avaliado (invalidado)'; changed = true; continue; }
      const end = s.candleOpen + s.expiryMin * 60;
      if ((s.expiryMin * 60) % g) { s.outcome = 'não avaliável neste timeframe'; changed = true; continue; }
      const closeCandle = byEpoch.get(end - g);
      const last = this.candles[this.candles.length - 1];
      if (!closeCandle || !last || last.epoch < end) continue; // vela de expiração ainda não fechou
      const diff = closeCandle.close - s.price;
      s.outcome = diff === 0 ? 'empate' : (diff > 0) === (s.direction === 'CALL') ? 'favorável' : 'desfavorável';
      s.exitPrice = closeCandle.close; changed = true;
    }
    if (changed) this._saveSignals();
  }

  signalStats() {
    const done = this.signals.filter(s => ['favorável', 'desfavorável', 'empate'].includes(s.outcome));
    const fav = done.filter(s => s.outcome === 'favorável').length;
    return { total: this.signals.length, avaliados: done.length, favoraveis: fav, taxa: done.length ? fav / done.length : null,
      invalidados: this.signals.filter(s => s.status === 'invalidado').length };
  }

  horizon() { const h = this.cfg.expiryMin * 60 / this.gran(); return Number.isInteger(h) && h >= 1 ? h : null; }

  rebuildModel() {
    const h = this.horizon();
    if (!h) { this.model = null; this.prob = { stage: 'indisponível', reason: `expiração de ${this.cfg.expiryMin} min não é múltipla do gráfico ${this.tf}` }; return; }
    const closed = this.hist.length ? this.hist : this.candles.slice(0, -1);
    const t = Date.now();
    this.model = prob.buildModel(closed, h);
    this.log(`Modelo de probabilidade: ${this.model.samples} amostras, horizonte ${h} vela(s), ${Date.now() - t} ms`);
  }

  // Baixa até 10.000 velas da Deriv para o modelo (em segundo plano; o gráfico já está ativo).
  async loadHistory() {
    const key = this.symbol + '|' + this.gran(); this._histKey = key;
    try {
      const h = await catalogLib.fetchHistory(this.pub, this.symbol, this.gran(), 2, () => {}, 10000);
      if (this._histKey !== key) return;          // mercado mudou no meio do download
      const live = this.candles.slice(0, -1);
      const m = new Map(h.concat(live).map(c => [c.epoch, c]));
      const formingEpoch = this.candles.at(-1) && this.candles.at(-1).epoch;
      this.hist = [...m.values()].filter(c => c.epoch !== formingEpoch).sort((a, b) => a.epoch - b.epoch);
      this.rebuildModel(); this.push();
    } catch (e) { this.log('histórico para o modelo falhou: ' + e.message, 'warn'); }
  }

  // Estimativa ao vivo sobre a vela em formação (preliminar), no máximo 1x por segundo.
  _liveProb(force = false) {
    const nowMs = Date.now();
    if (!force && this._lastLive && nowMs - this._lastLive < 1000) return;
    this._lastLive = nowMs;
    if (!this.model) return;
    const i = this.candles.length - 1, c = this.candles[i];
    const e = prob.estimate(this.model, this.candles, i, this.cfg.minSamples);
    if (!e) { this.prob = { stage: 'AGUARDAR', reason: 'indicadores insuficientes' }; return this.emit('prob', this.prob); }
    const pass = this._passes(e);
    this.prob = { ...e, stage: pass.ok ? 'preliminar' : 'AGUARDAR', reason: pass.reason, candle: c.epoch, at: nowMs };
    const elapsed = (this.now() - c.epoch) / this.gran();
    if (pass.ok && elapsed >= 0.5 && this._prelimFor !== c.epoch) {
      this._prelimFor = c.epoch;
      this.emit('notify', { kind: 'preliminar', text: `Preliminar ${e.direction} ${(e.p * 100).toFixed(1)}% · ${this.symbol} · confirma no fechamento da vela` });
    }
    this.emit('prob', this.prob);
  }

  _passes(e) {
    if (this.dataState !== 'ok') return { ok: false, reason: 'dados ' + this.dataState };
    if (e.n < this.cfg.minSamples) return { ok: false, reason: `amostra pequena (${e.n})` };
    if (e.p < this.cfg.minProb) return { ok: false, reason: `probabilidade ${(e.p * 100).toFixed(1)}% < mínimo ${(this.cfg.minProb * 100).toFixed(0)}%` };
    if (e.lo <= 0.5) return { ok: false, reason: `intervalo de confiança inclui 50% (${(e.lo * 100).toFixed(1)}–${(e.hi * 100).toFixed(1)}%)` };
    return { ok: true, reason: `${e.n} casos semelhantes (${e.level}); IC95% ${(e.lo * 100).toFixed(1)}–${(e.hi * 100).toFixed(1)}%` };
  }

  async _ensurePublic() {
    if (this.pub) return;
    this.pub = deriv.publicSocket();
    this.pub.on('message', m => this._onPublic(m));
    this.pub.on('latency', () => this.push());
    this.pub.on('close', () => { this.lastTickAt = null; this.checkFreshness(); });
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
    this.lastTickAt = Date.now();
    this.hist = []; this.prob = null; this.rebuildModel(); this.loadHistory();
    this.catalog = catalogLib.load(this.symbol, this.gran());
    if (this.signal && this.signal.status === 'valido') this._invalidate('ativo ou timeframe alterado');
    this.signal = null;
    this.emit('candles', { symbol: this.symbol, tf: this.tf, candles: this.candles });
    this.push();
  }

  async setMarket(symbol, tf) {
    if (this.open) throw new Error('há operação aberta');
    if (this.running) this.stop('mercado alterado');
    if (symbol) this.symbol = symbol;
    if (tf && !GRANS[tf]) throw new Error('timeframe inválido');
    if (tf) this.tf = tf;
    await this.subscribeCandles();
  }

  _onPublic(m) {
    if (!m.ohlc) return;
    const o = m.ohlc;
    this.lastTickAt = Date.now();
    if (o.epoch) this.tickLatencyMs = Math.max(0, Math.round(this.lastTickAt - (+o.epoch - this.serverOffset) * 1000));
    if (o.granularity && o.granularity !== this.gran()) return;
    if (o.symbol && o.symbol !== this.symbol) return;
    const c = { epoch: +o.open_time, open: +o.open, high: +o.high, low: +o.low, close: +o.close };
    const last = this.candles[this.candles.length - 1];
    if (last && last.epoch === c.epoch) {
      this.candles[this.candles.length - 1] = c;
      this.emit('candle', c);
      this._liveProb();
      return;
    }
    if (last && c.epoch > last.epoch) {
      this.candles.push(c);
      if (this.candles.length > 600) this.candles.shift();
      this.feedDelayMs = Math.round((this.now() - c.epoch) * 1000);
      this.emit('candle', c);
      const closed = this.candles[this.candles.length - 2];
      if (this.hist.length && closed.epoch > this.hist.at(-1).epoch) { this.hist.push(closed); if (this.hist.length > 12000) this.hist.shift(); }
      this.rebuildModel();
      this._evaluateSignals();
      this._onCandleClosed(this.candles.length - 2, c).catch(e => this.log('sinal: ' + e.message, 'error'));
      this.push();
    }
  }

  // ---------- sinais ----------
  async _onCandleClosed(i, newCandle) {
    const candles = this.candles;
    if (i < 35) return;
    if (this.signal && this.signal.status === 'valido') { this.signal.status = 'expirado'; this._record(this.signal); }
    this.signal = null;
    this.emit('signal', null);
    this.checkFreshness();
    if (this.dataState !== 'ok') return;       // AGUARDAR: fonte sem validade
    if (this.mode === 'manual') return this._probSignal(i, newCandle);

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
    const decidedAt = Date.now();
    this.signal = {
      uid: `${newCandle.epoch}-${this.symbol}-${this.tf}-${direction}`, status: 'valido',
      symbol: this.symbol, tf: this.tf, expiryMin: this.cfg.expiryMin, strategy: STRATEGY, source: SOURCE,
      createdAt: decidedAt, lastDataAt: this.lastTickAt, dataAgeMs: decidedAt - this.lastTickAt,
      id: ++this.signalSeq, direction, kind: this.mode === 'catalog' ? 'catalogo' : 'indicadores',
      confidence: ai ? ai.confidence : null, reason: ai ? ai.reason : local.reasons.join(', '),
      ai: !!ai, rule: rule ? { key: rule.key, rate: rule.testRate, n: rule.testN } : null,
      candleOpen: newCandle.epoch, expiresAt: newCandle.epoch + window, price: newCandle.open,
      basePrice: candles[i].close,
    };
    this._record(this.signal);
    this.emit('signal', this.signal);
    this.emit('notify', { kind: 'sinal', text: `${direction === 'CALL' ? 'CALL ▲' : 'PUT ▼'} ${this.symbol} · ${this.tf} · exp. ${this.cfg.expiryMin} min` });
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

  // Sinal confirmado: vela i acabou de fechar; entrada na abertura da vela seguinte.
  _probSignal(i, newCandle) {
    const e = prob.estimate(this.model, this.candles, i, this.cfg.minSamples);
    const pass = e ? this._passes(e) : { ok: false, reason: this.model ? 'indicadores insuficientes' : (this.prob && this.prob.reason) || 'modelo indisponível' };
    if (!e || !pass.ok) {
      this.prob = { ...(e || {}), stage: 'AGUARDAR', reason: pass.reason, candle: newCandle.epoch, at: Date.now() };
      this.emit('prob', this.prob); this.push(); return;
    }
    const decidedAt = Date.now();
    this.signal = {
      uid: `${newCandle.epoch}-${this.symbol}-${this.tf}-${e.direction}`, status: 'valido', stage: 'confirmado',
      symbol: this.symbol, tf: this.tf, expiryMin: this.cfg.expiryMin, strategy: e.model, source: SOURCE,
      createdAt: decidedAt, lastDataAt: this.lastTickAt, dataAgeMs: decidedAt - this.lastTickAt,
      id: ++this.signalSeq, direction: e.direction, kind: 'probabilidade',
      confidence: e.p, pCall: e.pCall, pPut: e.pPut, lo: e.lo, hi: e.hi, n: e.n, level: e.level, state: e.state,
      reason: pass.reason, ai: false, rule: null,
      candleOpen: newCandle.epoch, expiresAt: newCandle.epoch + Math.round(this.gran() * this.cfg.windowPct),
      price: newCandle.open, basePrice: this.candles[i].close,
    };
    this.prob = { ...e, stage: 'confirmado', reason: pass.reason, candle: newCandle.epoch, at: decidedAt };
    this._record(this.signal);
    this.emit('signal', this.signal); this.emit('prob', this.prob);
    this.emit('notify', { kind: 'sinal', text: `ENTRE AGORA ${e.direction === 'CALL' ? 'CALL ▲' : 'PUT ▼'} ${(e.p * 100).toFixed(1)}% · ${this.symbol} ${this.tf} · exp. ${this.cfg.expiryMin} min · janela ${Math.round(this.gran() * this.cfg.windowPct)} s` });
    this.push();
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
    if (!this.tradingEnabled) throw new Error('MVP em modo só análise: execução de ordens desativada (TRADING_ENABLED=1 para habilitar)');
    if (!this.trade || !this.account) throw new Error('conta não conectada');
    if (this.open || this.busy) throw new Error('já existe uma operação em andamento');
    if (!['CALL', 'PUT'].includes(direction)) throw new Error('direção inválida');
    const block = this.riskBlock();
    if (block) { if (source === 'bot') this.stop(block); throw new Error(block); }
    const stake = Number(this.cfg.stake);
    if (!(stake >= 0.35)) throw new Error('valor de entrada inválido (mínimo 0,35)');
    if (this.account.balance < stake) throw new Error('saldo insuficiente');

    const candleOpen = this.candles[this.candles.length - 1].epoch;
    const expiry = candleOpen + this.cfg.expiryMin * 60;
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
    if (!this.tradingEnabled) throw new Error('MVP em modo só análise: robô desativado');
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
    if (c.expiryMin != null && !EXPIRIES.includes(Number(c.expiryMin))) throw new Error('expiração inválida (5 ou 15 min)');
    if (c.maxDataAgeSec != null && !(Number(c.maxDataAgeSec) >= 3 && Number(c.maxDataAgeSec) <= 300)) throw new Error('idade máxima do dado entre 3 e 300 s');
    if (c.minProb != null && !(Number(c.minProb) >= 0.5 && Number(c.minProb) <= 0.95)) throw new Error('probabilidade mínima entre 50% e 95%');
    if (c.minSamples != null && !(Number(c.minSamples) >= 10)) throw new Error('amostra mínima ≥ 10');
    const oldExp = this.cfg.expiryMin;
    for (const k of Object.keys(this.cfg)) if (c[k] != null && !Number.isNaN(Number(c[k]))) this.cfg[k] = Number(c[k]);
    if (this.cfg.expiryMin !== oldExp && this.candles.length) {
      if (this.signal && this.signal.status === 'valido') this._invalidate('expiração alterada');
      this.rebuildModel(); this._liveProb(true);
    }
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

module.exports = { Engine, GRANS, EXPIRIES };
