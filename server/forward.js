'use strict';
// TESTE EM FRENTE (somente registro; nunca vira sinal operacional nem abre ordem).
// Regra CONGELADA em 2026-11-27, escolhida no backtest de 25/11 e por isso ainda NÃO validada fora da amostra:
//   USD/JPY, velas de 15 min, expiração 15 min (1 vela), memória exata das últimas 3 velas por COR,
//   entra só se o padrão já apareceu ≥ 40 vezes e a maioria histórica ≥ 56% (a favor OU contra a última vela, conforme o histórico).
// A memória aprende vela a vela, sem usar a vela seguinte antes de ela fechar. Cada previsão e seu resultado vão para data/forward.jsonl,
// com o payout medido na hora (se a Deriv responder). Quando houver amostra suficiente, compara-se com o empate do payout real.
const fs = require('fs'), path = require('path');

const RULE = Object.freeze({ id: 'usdjpy-mem3cor-v1', symbol: 'frxUSDJPY', tf: '15m', gran: 900, N: 3, minN: 40, thr: 0.56, frozenAt: '2026-11-27' });
const sgn = c => Math.sign(c.close - c.open);
const keyAt = (cs, i) => { let k = 0; for (let j = RULE.N - 1; j >= 0; j--) k = k * 3 + (sgn(cs[i - j]) + 1); return k; };
const wilsonLo = (w, n, z = 1.645) => { if (!n) return null; const p = w / n, d = 1 + z * z / n; return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d; };

class Forward {
  constructor({ dir, payoutFn } = {}) {
    this.file = path.join(dir || process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'forward.jsonl');
    this.payoutFn = payoutFn || null;
    this.mem = new Map(); this.pending = null; this.lastDecided = 0; this.rows = []; this.seeded = false;
    try { for (const l of fs.readFileSync(this.file, 'utf8').split('\n')) if (l) this.rows.push(JSON.parse(l)); } catch {}
    for (const r of this.rows) if (r.event === 'pred') this.lastDecided = Math.max(this.lastDecided, r.candle);
    const lp = [...this.rows].reverse().find(r => r.event === 'pred');             // previsão aberta antes de um reinício: ainda pode ser resolvida
    if (lp && !this.rows.some(r => r.event === 'result' && r.candle === lp.candle)) { const py = [...this.rows].reverse().find(r => r.event === 'payout' && r.candle === lp.candle); this.pending = { candle: lp.candle, entryEpoch: lp.candle - RULE.gran, dir: lp.dir, entry: lp.entry, payout: py ? py.payout : null }; }
  }
  _log(o) { this.rows.push(o); try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.appendFileSync(this.file, JSON.stringify(o) + '\n'); } catch {} }
  _learn(cs, i, nxt) { if (i < RULE.N - 1) return; const y = Math.sign(nxt.close - cs[i].close); if (!y) return; const k = keyAt(cs, i), m = this.mem.get(k) || [0, 0]; if (y > 0) m[0]++; else m[1]++; this.mem.set(k, m); }
  // Reconstrói a memória só com velas FECHADAS do histórico (sem a vela em formação).
  seed(hist) {
    this.mem = new Map();
    for (let i = RULE.N - 1; i < hist.length - 1; i++) this._learn(hist, i, hist[i + 1]);
    this.seeded = true; this.histEnd = hist.at(-1).epoch;
  }
  // Chamado quando uma nova vela fecha (hist termina na vela recém-fechada).
  onClosed(hist) {
    if (!this.seeded) return;
    const k = hist.length - 1, cl = hist[k]; if (k < RULE.N + 1 || cl.epoch <= this.histEnd) return;
    const prev = hist[k - 1];
    // 1) resolve a previsão pendente (feita no fechamento da vela anterior)
    if (this.pending && this.pending.entryEpoch === prev.epoch) {
      const y = Math.sign(cl.close - prev.close), p = this.pending;
      this._log({ event: 'result', candle: p.candle, symbol: RULE.symbol, rule: RULE.id, dir: p.dir, entry: p.entry, exit: cl.close, outcome: y === 0 ? 'empate' : (y === p.dir ? 'win' : 'loss'), payout: p.payout, closedAt: cl.epoch + RULE.gran });
    }
    this.pending = null;
    // 2) aprende com o resultado da vela anterior (agora conhecido); se houve lacuna, reconstrói a memória
    if (prev.epoch === this.histEnd) this._learn(hist, k - 1, cl); else this.seed(hist);
    this.histEnd = cl.epoch;
    // 3) decide para a PRÓXIMA vela, só com memória até aqui
    const m = this.mem.get(keyAt(hist, k)); if (!m) return;
    const t = m[0] + m[1]; if (t < RULE.minN) return;
    const sh = m[0] / t, dir = sh >= RULE.thr ? 1 : (1 - sh) >= RULE.thr ? -1 : 0; if (!dir) return;
    const candle = cl.epoch + RULE.gran;
    if (candle <= this.lastDecided) return;                        // não repete após reinício
    this.lastDecided = candle;
    const last = sgn(cl), p = { candle, entryEpoch: cl.epoch, dir, entry: cl.close, payout: null };
    this.pending = p;
    this._log({ event: 'pred', candle, symbol: RULE.symbol, rule: RULE.id, dir, vsLast: last ? (dir === last ? 'a favor' : 'contra') : 'neutra', share: +sh.toFixed(3), seen: t, entry: cl.close });
    if (this.payoutFn) Promise.resolve().then(this.payoutFn).then(v => { if (v > 0) { p.payout = v; this._log({ event: 'payout', candle, payout: v }); } }).catch(() => {});
  }
  summary() {
    const res = this.rows.filter(r => r.event === 'result'), dec = res.filter(r => r.outcome !== 'empate');
    const payoutOf = c => { const r = [...this.rows].reverse().find(x => x.event === 'payout' && x.candle === c); return r ? r.payout : null; };
    const w = dec.filter(r => r.outcome === 'win').length, n = dec.length;
    const pays = dec.map(r => r.payout || payoutOf(r.candle)).filter(x => x > 0);
    const meanPay = pays.length ? pays.reduce((a, b) => a + b, 0) / pays.length : null;
    let ev = null; if (pays.length === n && n) ev = dec.reduce((a, r) => a + (r.outcome === 'win' ? (r.payout || payoutOf(r.candle)) : -1), 0) / n;
    return { rule: RULE, status: 'EXPERIMENTAL — teste em frente, não é sinal operacional', since: this.rows.find(r => r.event === 'pred')?.candle || null,
      predictions: this.rows.filter(r => r.event === 'pred').length, resolved: n, wins: w, rate: n ? w / n : null, ci90Low: wilsonLo(w, n),
      meanPayout: meanPay, breakEven: meanPay ? 1 / (1 + meanPay) : null, evPerUnit: ev, minSampleSuggested: 300,
      note: n < 300 ? `amostra pequena (${n}); não tire conclusão antes de ~300 operações` : 'amostra mínima atingida; compare o limite inferior com o empate' };
  }
}
module.exports = { Forward, RULE, keyAt };
