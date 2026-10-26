'use strict';
// Scanner multi-mercado: acompanha vários ativos × gráficos × expirações em paralelo, com o MESMO
// modelo e os MESMOS filtros do painel principal, e avisa onde há probabilidade de entrada.
// Usa um WebSocket público próprio (a Deriv recusa assinaturas duplicadas na mesma conexão).
const EventEmitter = require('events');
const deriv = require('./deriv');
const { fetchHistory } = require('./catalog');
const prob = require('./probability');

const DEFAULT_SYMBOLS = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDUSD', 'frxEURGBP'];
const NAMES = { R_10: 'Volatility 10', R_25: 'Volatility 25', R_50: 'Volatility 50', R_75: 'Volatility 75', R_100: 'Volatility 100',
  frxEURUSD: 'EUR/USD', frxGBPUSD: 'GBP/USD', frxUSDJPY: 'USD/JPY', frxAUDUSD: 'AUD/USD', frxEURGBP: 'EUR/GBP' };
const TFS = { '5m': 300, '15m': 900 };
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
    for (const exp of EXPIRIES) {
      const hz = exp * 60 / st.gran;
      if (Number.isInteger(hz) && hz >= 1) st.models[exp] = prob.buildModel(st.hist, hz);
    }
    st.loaded = true;
    this.emit('loaded', { sym: st.sym, tf: st.tf, samples: st.hist.length });
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

  _passes(e, st) {
    const cfg = this.getCfg();
    if (!this.fresh(st)) return { ok: false, reason: 'dados atrasados' };
    if (e.n < cfg.minSamples) return { ok: false, reason: `amostra pequena (${e.n})` };
    if (e.p < cfg.minProb) return { ok: false, reason: `${(e.p * 100).toFixed(1)}% < ${(cfg.minProb * 100).toFixed(0)}%` };
    if (e.lo <= 0.5) return { ok: false, reason: 'IC95% inclui 50%' };
    return { ok: true, reason: `${e.n} casos (${e.level}); IC95% ${(e.lo * 100).toFixed(1)}–${(e.hi * 100).toFixed(1)}%` };
  }

  // Vela em formação: estimativa preliminar, no máx. 1x/s por stream.
  _live(st) {
    const t = Date.now();
    if (!st.loaded || (st._at && t - st._at < 1000)) return;
    st._at = t;
    const cfg = this.getCfg(), i = st.candles.length - 1, c = st.candles[i];
    for (const [exp, m] of Object.entries(st.models)) {
      const e = prob.estimate(m, st.candles, i, cfg.minSamples);
      const pass = e ? this._passes(e, st) : { ok: false, reason: 'indicadores insuficientes' };
      st.last[exp] = e ? { pCall: e.pCall, p: e.p, direction: e.direction, n: e.n, ok: pass.ok, reason: pass.reason, stage: pass.ok ? 'preliminar' : 'AGUARDAR' } : { ok: false, reason: pass.reason, stage: 'AGUARDAR' };
      const elapsed = (this.now() - c.epoch) / st.gran;
      const key = `${c.epoch}|${exp}`;
      if (pass.ok && elapsed >= 0.5 && st.notified[exp] !== key && !this.isActive(st.sym, st.tf, +exp)) {
        st.notified[exp] = key;
        this.emit('opportunity', { stage: 'preliminar', symbol: st.sym, name: this.name(st.sym), tf: st.tf, expiryMin: +exp,
          direction: e.direction, p: e.p, n: e.n, lo: e.lo, hi: e.hi, closeAt: c.epoch + st.gran, reason: pass.reason });
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
      const pass = this._passes(e, st);
      st.last[exp] = { pCall: e.pCall, p: e.p, direction: e.direction, n: e.n, ok: pass.ok, reason: pass.reason, stage: pass.ok ? 'confirmado' : 'AGUARDAR' };
      if (!pass.ok || this.isActive(st.sym, st.tf, +exp)) continue; // combinação aberta no painel: o painel confirma e registra
      const sig = { uid: `${newCandle.epoch}-${st.sym}-${st.tf}-${e.direction}-x${exp}`, status: 'valido', stage: 'confirmado', origin: 'scanner',
        symbol: st.sym, tf: st.tf, expiryMin: +exp, strategy: e.model, source: 'Deriv API oficial (scanner)', createdAt: Date.now(),
        direction: e.direction, confidence: e.p, pCall: e.pCall, pPut: e.pPut, lo: e.lo, hi: e.hi, n: e.n, level: e.level,
        reason: pass.reason, candleOpen: newCandle.epoch, expiresAt: newCandle.epoch + Math.round(st.gran * cfg.windowPct), price: newCandle.open };
      this.pending.push(sig); this.record(sig);
      if (!this.isActive(st.sym, st.tf, +exp))
        this.emit('opportunity', { stage: 'confirmado', symbol: st.sym, name: this.name(st.sym), tf: st.tf, expiryMin: +exp,
          direction: e.direction, p: e.p, n: e.n, lo: e.lo, hi: e.hi, entryUntil: sig.expiresAt, candleOpen: newCandle.epoch, reason: pass.reason });
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
      s.exitPrice = cc.close; s.status = 'expirado'; this.record(s);
      return false;
    });
  }

  view() {
    const nowMs = Date.now(), out = [];
    for (const st of this.streams.values()) for (const exp of EXPIRIES) {
      const hz = exp * 60 / st.gran; if (!Number.isInteger(hz) || hz < 1) continue;
      const l = st.last[exp] || {};
      out.push({ symbol: st.sym, name: this.name(st.sym), tf: st.tf, expiryMin: exp, loaded: st.loaded, fresh: !!this.fresh(st, nowMs),
        error: st.error || null, pCall: l.pCall ?? null, p: l.p ?? null, direction: l.direction || null, n: l.n ?? null, ok: !!l.ok, stage: l.stage || (st.loaded ? 'AGUARDAR' : 'carregando'), reason: l.reason || null });
    }
    return out;
  }
}

module.exports = { Scanner, DEFAULT_SYMBOLS, NAMES, TFS, EXPIRIES };
