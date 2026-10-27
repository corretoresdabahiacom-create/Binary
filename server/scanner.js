'use strict';
// Scanner multi-mercado: acompanha vários ativos × gráficos × expirações em paralelo, com o MESMO
// modelo e os MESMOS filtros do painel principal, e avisa onde há probabilidade de entrada.
// Usa um WebSocket público próprio (a Deriv recusa assinaturas duplicadas na mesma conexão).
const EventEmitter = require('events');
const deriv = require('./deriv');
const catalogLib = require('./catalog');
const { fetchHistory } = catalogLib;
const { computeSeries } = require('./indicators');
const { Worker } = require('worker_threads');
const path = require('path');

// Uma única thread auxiliar para os catálogos (fila); se worker_threads falhar, cai para a thread principal.
let worker = null, seq = 0; const waiting = new Map();
function catalogAsync(candles, opts) {
  try {
    if (!worker) {
      worker = new Worker(path.join(__dirname, 'catalogWorker.js'));
      worker.unref();
      worker.on('message', m => { const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id); m.error ? w.rej(new Error(m.error)) : w.res(m.cat); });
      worker.on('error', e => { for (const w of waiting.values()) w.rej(e); waiting.clear(); worker = null; });
    }
    const id = ++seq;
    return new Promise((res, rej) => { waiting.set(id, { res, rej }); worker.postMessage({ id, candles, opts }); });
  } catch { return Promise.resolve().then(() => catalogLib.buildCatalog(candles, opts)); }
}
const prob = require('./probability');
const research = require('./research');

// Foco em forex: índices Volatility (sorteio aleatório) foram retirados — sem vantagem possível (backtest v2).
const DEFAULT_SYMBOLS = ['frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDUSD', 'frxUSDCAD', 'frxUSDCHF', 'frxNZDUSD', 'frxEURGBP', 'frxEURJPY', 'frxGBPJPY'];
const NAMES = { frxEURUSD: 'EUR/USD', frxGBPUSD: 'GBP/USD', frxUSDJPY: 'USD/JPY', frxAUDUSD: 'AUD/USD', frxUSDCAD: 'USD/CAD',
  frxUSDCHF: 'USD/CHF', frxNZDUSD: 'NZD/USD', frxEURGBP: 'EUR/GBP', frxEURJPY: 'EUR/JPY', frxGBPJPY: 'GBP/JPY' };
const TFS = { '15m': 900, '1h': 3600 };
const EXPIRIES = [5, 15];
const HIST = 10000, LIVE = 300;

class Scanner extends EventEmitter {
  // getCfg(): { minProb, minSamples, maxDataAgeSec, windowPct }; isActive(sym, tf, exp): combinação aberta no painel
  constructor({ getCfg, isActive = () => false, symbols = DEFAULT_SYMBOLS, tfs = Object.keys(TFS), record = () => {} } = {}) {
    super();
    this.getCfg = getCfg; this.isActive = isActive; this.record = record;
    this.streams = new Map();
    for (const sym of symbols) for (const tf of tfs) this.streams.set(`${sym}|${tf}`, { sym, tf, gran: TFS[tf], candles: [], hist: [], models: {}, lastTick: null, loaded: false, last: {}, notified: {} });
    this.serverOffset = 0;
    this.pending = [];        // sinais confirmados aguardando resultado
    this.sock = null;
  }

  now() { return Date.now() / 1000 + this.serverOffset; }
  name(sym) { return NAMES[sym] || sym; }

  async start() {
    this.sock = deriv.publicSocket();
    this.sock.label = 'scanner';
    this.sock.on('message', m => m.ohlc && this._onOhlc(m.ohlc));
    this.sock.on('reconnected', () => this._subscribeAll().catch(() => {}));
    this.sock.on('warn', w => this.emit('log', w));
    await this.sock.connect();
    try { const t = await this.sock.send({ time: 1 }); this.serverOffset = t.time - Date.now() / 1000; } catch {}
    await this._subscribeAll();
  }

  stop() { if (this.sock) { this.sock.removeAllListeners(); this.sock.close(); this.sock = null; } }

  async _subscribeAll() {
    for (const st of this.streams.values()) {          // sequencial: respeita limites da Deriv
      try { await this._load(st); } catch (e) { st.error = e.message; this.emit('log', `scanner ${st.sym} ${st.tf}: ${e.message}`); }
    }
  }

  async _load(st) {
    const res = await this.sock.send({ ticks_history: st.sym, style: 'candles', granularity: st.gran, count: LIVE, end: 'latest' }, { subscribe: true, timeoutMs: 30000 });
    st.candles = (res.candles || []).map(c => ({ epoch: c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
    st.lastTick = Date.now(); st.error = null;
    const h = await fetchHistory(this.sock, st.sym, st.gran, 2, () => {}, HIST);
    const forming = st.candles.at(-1) && st.candles.at(-1).epoch;
    const m = new Map(h.concat(st.candles.slice(0, -1)).map(c => [c.epoch, c]));
    st.hist = [...m.values()].filter(c => c.epoch !== forming).sort((a, b) => a.epoch - b.epoch);
    st.models = {};
    for (const exp of research.contractRules(st.sym).expiries) {
      const hz = exp * 60 / st.gran;
      if (Number.isInteger(hz) && hz >= 1) st.models[exp] = prob.buildModel(st.hist, hz);
    }
    st.loaded = true;
    st.catalogs = st.catalogs || {};
    this._catTimer(st);
    this.emit('loaded', { sym: st.sym, tf: st.tf, samples: st.hist.length });
  }

  // ---------- catalogador em segundo plano ----------
  // Para cada expiração: regras (hora, dia, padrão de vela, indicadores) achadas em 70% do histórico e
  // conferidas nos 30% restantes, com correção de Bonferroni. Refeito a cada 6 h, espaçado entre mercados.
  _catTimer(st) {
    const order = [...this.streams.values()].indexOf(st);
    clearTimeout(st._catT);
    st._catT = setTimeout(() => this._buildCatalogs(st), 3000 * (order + 1) + 1000);
    if (st._catT.unref) st._catT.unref();
  }
  async _buildCatalogs(st) {
    for (const [exp, m] of Object.entries(st.models)) {
      try { st.catalogs[exp] = await catalogAsync(st.hist.slice(-10000), { horizon: m.horizon, breakeven: 1 / 1.95 }); }
      catch (e) { st.catalogs[exp] = null; }
    }
    this.emit('catalog', { sym: st.sym, tf: st.tf, validated: Object.fromEntries(Object.entries(st.catalogs).map(([k, c]) => [k, c ? c.validated : 0])) });
    clearTimeout(st._catT);
    st._catT = setTimeout(() => this._buildCatalogs(st), 6 * 3600 * 1000);
    if (st._catT.unref) st._catT.unref();
  }
  // Concordância do catálogo com uma direção na vela i de `candles`.
  agreement(sym, tf, exp, candles, i, dir) {
    const st = this.streams.get(`${sym}|${tf}`), cat = st && st.catalogs && st.catalogs[exp];
    if (!cat) return { status: 'catálogo ainda não montado', rules: 0 };
    const win = candles.slice(Math.max(0, i - 150), i + 1);
    const m = catalogLib.matchRules(cat, win, computeSeries(win), win.length - 1);
    if (!m.length) return { status: 'sem regra validada', rules: 0, validated: cat.validated };
    const agree = m.filter(r => r.direction === dir), dis = m.filter(r => r.direction !== dir);
    const best = (agree[0] || dis[0]);
    return { status: dis.length && !agree.length ? 'discorda' : agree.length && !dis.length ? 'concorda' : 'dividido', rules: m.length,
      best: best && { regra: best.key, direcao: best.direction, acertoTeste: best.testRate, casos: best.testN } };
  }
  _catalogGate(st, exp, i, pass) {
    if (!pass.ok || !pass.direction) return pass;
    const a = this.agreement(st.sym, st.tf, exp, st.candles, i, pass.direction), f = +this.getCfg().catalogFilter || 0;
    const out = { ...pass, catalog: a };
    if (f >= 1 && (a.status === 'discorda' || a.status === 'dividido')) return { ...out, ok: false, reason: `catálogo ${a.status}` };
    if (f >= 2 && a.status !== 'concorda') return { ...out, ok: false, reason: `catálogo não confirma (${a.status})` };
    return out;
  }

  fresh(st, nowMs = Date.now()) { return st.lastTick && (nowMs - st.lastTick) / 1000 <= this.getCfg().maxDataAgeSec; }

  _onOhlc(o) {
    const st = this.streams.get(`${o.symbol}|${Object.keys(TFS).find(k => TFS[k] === +o.granularity)}`);
    if (!st || !st.candles.length) return;
    st.lastTick = Date.now();
    const c = { epoch: +o.open_time, open: +o.open, high: +o.high, low: +o.low, close: +o.close };
    const last = st.candles.at(-1);
    if (last.epoch === c.epoch) { st.candles[st.candles.length - 1] = c; this._live(st); return; }
    if (c.epoch < last.epoch) return;
    st.candles.push(c); if (st.candles.length > LIVE + 50) st.candles.shift();
    const closed = st.candles[st.candles.length - 2];
    if (st.loaded && (!st.hist.length || closed.epoch > st.hist.at(-1).epoch)) {
      st.hist.push(closed); if (st.hist.length > HIST + 2000) st.hist.shift();
      for (const m of Object.values(st.models)) prob.addSample(m, st.hist, st.hist.length - 1 - m.horizon); // incremental, sem dados futuros
    }
    this._evaluate(st);
    this._confirm(st, c);
  }

  _passes(e, st, i, exp) {
    return this._catalogGate(st, exp, i, research.liveDecision(st.candles, i, e, { symbol: st.sym, tf: st.tf, expiryMin: +exp }, this.getCfg(), this.fresh(st)));
  }

  // Vela em formação: estimativa preliminar, no máx. 1x/s por stream.
  _live(st) {
    const t = Date.now();
    if (!st.loaded || (st._at && t - st._at < 1000)) return;
    st._at = t;
    const cfg = this.getCfg(), i = st.candles.length - 1, c = st.candles[i];
    for (const [exp, m] of Object.entries(st.models)) {
      const e = prob.estimate(m, st.candles, i, cfg.minSamples);
      const pass = e ? this._passes(e, st, i, exp) : { ok: false, reason: 'indicadores insuficientes' };
      st.last[exp] = e ? { pCall: e.pCall, p: pass.p ?? e.p, direction: pass.direction || e.direction, approved: pass.approved, version: pass.version, n: e.n, ok: pass.ok, reason: pass.reason, stage: pass.ok ? 'preliminar' : 'AGUARDAR' } : { ok: false, reason: pass.reason, stage: 'AGUARDAR' };
      const elapsed = (this.now() - c.epoch) / st.gran;
      const key = `${c.epoch}|${exp}`;
      if (pass.ok && elapsed >= 0.5 && st.notified[exp] !== key && !this.isActive(st.sym, st.tf, +exp)) {
        st.notified[exp] = key;
        this.emit('opportunity', { stage: 'preliminar', symbol: st.sym, name: this.name(st.sym), tf: st.tf, expiryMin: +exp,
          direction: pass.direction, p: pass.p, ev: pass.ev, approved: pass.approved, catalog: pass.catalog && pass.catalog.status, n: e.n, lo: e.lo, hi: e.hi, closeAt: c.epoch + st.gran, reason: pass.reason });
      }
    }
  }

  // Vela fechou: confirma (ou não) com a vela fechada; entrada na abertura da vela nova.
  _confirm(st, newCandle) {
    if (!st.loaded) return;
    const cfg = this.getCfg(), i = st.candles.length - 2;
    for (const [exp, m] of Object.entries(st.models)) {
      const e = prob.estimate(m, st.candles, i, cfg.minSamples);
      if (!e) continue;
      const pass = this._passes(e, st, i, exp);
      st.last[exp] = { pCall: e.pCall, p: pass.p ?? e.p, direction: pass.direction || e.direction, approved: pass.approved, version: pass.version, n: e.n, ok: pass.ok, reason: pass.reason, stage: pass.ok ? 'confirmado' : 'AGUARDAR' };
      if (!pass.ok && pass.blocks && pass.direction && !this.isActive(st.sym, st.tf, +exp)) {   // bloqueado: registra para medir o custo do filtro
        const bs = { uid: `${newCandle.epoch}-${st.sym}-${st.tf}-${pass.direction}-x${exp}-b`, status: 'bloqueado', stage: 'bloqueado', origin: 'scanner',
          symbol: st.sym, tf: st.tf, expiryMin: +exp, strategy: e.model, createdAt: Date.now(), direction: pass.direction, confidence: pass.p,
          version: pass.version, reason: pass.reason, blocks: pass.blocks, analysis: pass.analysis, candleOpen: newCandle.epoch, expiresAt: newCandle.epoch, price: newCandle.open };
        this.pending.push(bs); this.record(bs);
      }
      if (!pass.ok && /não aprovada/.test(pass.reason || '')) {      // teste ao vivo das combinações reprovadas: registra, nunca avisa
        const sh = research.liveDecision(st.candles, i, e, { symbol: st.sym, tf: st.tf, expiryMin: +exp }, { ...cfg, allowUnapproved: 1 }, this.fresh(st));
        if (sh.ok) {
          const ss = { uid: `${newCandle.epoch}-${st.sym}-${st.tf}-${sh.direction}-x${exp}-s`, status: 'sombra', stage: 'sombra', origin: 'scanner',
            symbol: st.sym, tf: st.tf, expiryMin: +exp, strategy: e.model, createdAt: Date.now(), direction: sh.direction, confidence: sh.p, ev: sh.ev,
            version: sh.version, reason: 'não aprovada (teste ao vivo)', analysis: sh.analysis, candleOpen: newCandle.epoch, expiresAt: newCandle.epoch, price: newCandle.open };
          this.pending.push(ss); this.record(ss);
        }
      }
      if (!pass.ok || this.isActive(st.sym, st.tf, +exp)) continue; // combinação aberta no painel: o painel confirma e registra
      const sig = { uid: `${newCandle.epoch}-${st.sym}-${st.tf}-${pass.direction}-x${exp}`, status: 'valido', stage: 'confirmado', origin: 'scanner',
        symbol: st.sym, tf: st.tf, expiryMin: +exp, strategy: e.model, source: 'Deriv API oficial (scanner)', createdAt: Date.now(),
        direction: pass.direction, confidence: pass.p, ev: pass.ev, version: pass.version, catalog: pass.catalog, analysis: pass.analysis, pCall: e.pCall, pPut: e.pPut, lo: e.lo, hi: e.hi, n: e.n, level: e.level,
        reason: pass.reason, candleOpen: newCandle.epoch, expiresAt: newCandle.epoch + Math.round(st.gran * cfg.windowPct), price: newCandle.open };
      this.pending.push(sig); this.record(sig);
      if (!this.isActive(st.sym, st.tf, +exp))
        this.emit('opportunity', { stage: 'confirmado', symbol: st.sym, name: this.name(st.sym), tf: st.tf, expiryMin: +exp,
          direction: pass.direction, p: pass.p, ev: pass.ev, approved: pass.approved, catalog: pass.catalog && pass.catalog.status, n: e.n, lo: e.lo, hi: e.hi, entryUntil: sig.expiresAt, candleOpen: newCandle.epoch, reason: pass.reason });
    }
  }

  // Resultado observado (mesma regra do painel): fechamento da vela de expiração vs. preço de abertura do sinal.
  _evaluate(st) {
    const by = new Map(st.hist.map(c => [c.epoch, c]));
    this.pending = this.pending.filter(s => {
      if (s.symbol !== st.sym || s.tf !== st.tf) return true;
      const end = s.candleOpen + s.expiryMin * 60, cc = by.get(end - st.gran);
      if (!cc) return !(st.hist.length && st.hist.at(-1).epoch >= end); // aguardando; descarta se houve lacuna
      const d = cc.close - s.price;
      s.outcome = d === 0 ? 'empate' : (d > 0) === (s.direction === 'CALL') ? 'favorável' : 'desfavorável';
      s.exitPrice = cc.close; if (s.status !== 'bloqueado' && s.status !== 'sombra') s.status = 'expirado'; this.record(s);
      return false;
    });
  }

  view() {
    const nowMs = Date.now(), out = [];
    for (const st of this.streams.values()) for (const exp of research.contractRules(st.sym).expiries) {
      const hz = exp * 60 / st.gran; if (!Number.isInteger(hz) || hz < 1) continue;
      const l = st.last[exp] || {};
      out.push({ symbol: st.sym, name: this.name(st.sym), tf: st.tf, expiryMin: exp, loaded: st.loaded, fresh: !!this.fresh(st, nowMs),
        error: st.error || null, pCall: l.pCall ?? null, p: l.p ?? null, direction: l.direction || null, n: l.n ?? null, approved: l.approved ?? null, version: l.version || null, ok: !!l.ok, stage: l.stage || (st.loaded ? 'AGUARDAR' : 'carregando'), reason: l.reason || null });
    }
    return out;
  }
}

module.exports = { Scanner, DEFAULT_SYMBOLS, NAMES, TFS, EXPIRIES };
