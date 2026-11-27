'use strict';
// TESTE EM FRENTE nº 2 (somente registro; nunca vira sinal nem abre ordem). Congelado em 2026-11-27.
// Três famílias de contexto escolhidas no backtest fora da amostra de 27/11 (as de maior limite inferior; NENHUMA passou na correção FDR):
//   r50+rg|s2 : distância do número redondo .50 + posição na faixa de 96 velas + cor das 2 últimas velas
//   t4|s2     : distância da média de 4h + cor das 2 últimas velas
//   r50|s3    : distância do número redondo .50 + cor das 3 últimas velas
// USD/JPY 15m, expiração 1 vela. Entra se o contexto já apareceu ≥ 50 vezes e a maioria histórica ≥ 56% (a favor ou contra a última vela).
// Registra também o payout de cada entrada, para separar depois "payout alto" de "payout baixo".
const fs = require('fs'), path = require('path');
const { features, FAMS, keyOf, wil } = require('./ctx');

const RULES = Object.freeze(['r50+rg|s2', 't4|s2', 'r50|s3'].map(id => Object.freeze({ id: 'usdjpy-ctx-' + id, famId: id, symbol: 'frxUSDJPY', gran: 900, minN: 50, thr: 0.56, frozenAt: '2026-11-27' })));
const TAIL = 700;                                                   // janela p/ calcular contexto da última vela (cobre dia anterior/sexta)

class ForwardCtx {
  constructor({ dir, payoutFn } = {}) {
    this.file = path.join(dir || process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'forward-ctx.jsonl');
    this.payoutFn = payoutFn || null; this.rows = []; this.seeded = false; this.histEnd = 0;
    this.st = RULES.map(r => ({ r, fam: FAMS.find(f => f.id === r.famId), mem: new Map(), pending: null, lastDecided: 0 }));
    try { for (const l of fs.readFileSync(this.file, 'utf8').split('\n')) if (l) this.rows.push(JSON.parse(l)); } catch {}
    for (const s of this.st) {
      const mine = this.rows.filter(x => x.rule === s.r.id);
      for (const x of mine) if (x.event === 'pred') s.lastDecided = Math.max(s.lastDecided, x.candle);
      const lp = [...mine].reverse().find(x => x.event === 'pred');
      if (lp && !mine.some(x => x.event === 'result' && x.candle === lp.candle)) { const py = [...mine].reverse().find(x => x.event === 'payout' && x.candle === lp.candle); s.pending = { candle: lp.candle, entryEpoch: lp.candle - s.r.gran, dir: lp.dir, entry: lp.entry, payout: py ? py.payout : null }; }
    }
  }
  _log(o) { this.rows.push(o); try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.appendFileSync(this.file, JSON.stringify(o) + '\n'); } catch {} }
  _learnAll(F, cs, i, nxt, only) {
    if (!F[i]) return; const y = Math.sign(nxt.close - cs[i].close); if (!y) return;
    for (const s of this.st) { if (only && s !== only) continue; const k = keyOf(F[i], s.fam); if (k == null) continue; const m = s.mem.get(k) || [0, 0]; m[y > 0 ? 0 : 1]++; s.mem.set(k, m); }
  }
  seed(hist) {
    for (const s of this.st) s.mem = new Map();
    const F = features(hist); for (let i = 100; i < hist.length - 1; i++) this._learnAll(F, hist, i, hist[i + 1]);
    this.seeded = true; this.histEnd = hist.at(-1).epoch;
  }
  onClosed(hist) {
    if (!this.seeded) return;
    const k = hist.length - 1, cl = hist[k]; if (k < 120 || cl.epoch <= this.histEnd) return;
    const prev = hist[k - 1], gap = prev.epoch !== this.histEnd;
    const tail = hist.slice(-TAIL), F = features(tail), n = tail.length;
    for (const s of this.st) {
      const p = s.pending;
      if (p && p.entryEpoch === prev.epoch) { const y = Math.sign(cl.close - prev.close); this._log({ event: 'result', candle: p.candle, symbol: s.r.symbol, rule: s.r.id, dir: p.dir, entry: p.entry, exit: cl.close, outcome: y === 0 ? 'empate' : (y === p.dir ? 'win' : 'loss'), payout: p.payout, closedAt: cl.epoch + s.r.gran }); }
      s.pending = null;
    }
    if (gap) this.seed(hist); else this._learnAll(F, tail, n - 2, cl);
    this.histEnd = cl.epoch;
    const f = F[n - 1]; if (!f) return;
    for (const s of this.st) {
      const key = keyOf(f, s.fam), m = key == null ? null : s.mem.get(key); if (!m) continue;
      const t = m[0] + m[1]; if (t < s.r.minN) continue;
      const sh = m[0] / t, dir = sh >= s.r.thr ? 1 : (1 - sh) >= s.r.thr ? -1 : 0; if (!dir) continue;
      const candle = cl.epoch + s.r.gran; if (candle <= s.lastDecided) continue; s.lastDecided = candle;
      const last = Math.sign(cl.close - cl.open), pd = { candle, entryEpoch: cl.epoch, dir, entry: cl.close, payout: null }; s.pending = pd;
      this._log({ event: 'pred', candle, symbol: s.r.symbol, rule: s.r.id, dir, vsLast: last ? (dir === last ? 'a favor' : 'contra') : 'neutra', share: +sh.toFixed(3), seen: t, entry: cl.close });
      if (this.payoutFn) Promise.resolve().then(this.payoutFn).then(v => { if (v > 0) { pd.payout = v; this._log({ event: 'payout', rule: s.r.id, candle, payout: v }); } }).catch(() => {});
    }
  }
  summary() {
    const out = RULES.map(r => {
      const mine = this.rows.filter(x => x.rule === r.id), pay = c => (mine.find(x => x.event === 'payout' && x.candle === c) || {}).payout;
      const dec = mine.filter(x => x.event === 'result' && x.outcome !== 'empate').map(x => ({ ...x, payout: x.payout || pay(x.candle) }));
      const agg = a => { const n = a.length, w = a.filter(x => x.outcome === 'win').length, ps = a.map(x => x.payout).filter(x => x > 0), mp = ps.length ? ps.reduce((u, v) => u + v, 0) / ps.length : null;
        return { n, wins: w, rate: n ? w / n : null, ci90Low: n ? wil(w, n) : null, meanPayout: mp, breakEven: mp ? 1 / (1 + mp) : null, evPerUnit: ps.length === n && n ? a.reduce((u, x) => u + (x.outcome === 'win' ? x.payout : -1), 0) / n : null }; };
      return { rule: r.id, predictions: mine.filter(x => x.event === 'pred').length, todas: agg(dec), payoutAlto: agg(dec.filter(x => x.payout >= 0.85)), payoutBaixo: agg(dec.filter(x => x.payout > 0 && x.payout < 0.85)) };
    });
    return { status: 'EXPERIMENTAL — teste em frente, não é sinal operacional', rules: out, minSampleSuggested: 300, note: 'Três regras escolhidas no mesmo backtest; nenhuma passou FDR. Conclua só com ~300 operações por regra e compare o limite inferior com o break-even do payout medido.' };
  }
}
module.exports = { ForwardCtx, RULES };
