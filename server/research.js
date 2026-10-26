'use strict';
// Camada de qualidade (backtest v2 e decisão ao vivo usam ESTAS MESMAS funções):
//  - calibração isotônica (PAV) da probabilidade do modelo primário            (item 4)
//  - features de regime: sessão do câmbio (UTC) e percentil de volatilidade    (item 6)
//  - meta-modelo (regressão logística L2) que filtra sinais do primário        (item 8)
//  - decisão por valor esperado com payout real                                (item 3)
//  - teste binomial + Benjamini-Hochberg entre combinações                     (item 2)
//  - sinais sem sobreposição e embargo                                         (item 1)
//  - whitelist: só combinações aprovadas notificam                            (item 7)
const fs = require('fs');
const path = require('path');
const { computeSeries, snapshot } = require('./indicators');

const DATA_DIR = () => process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const RESEARCH_FILE = () => path.join(DATA_DIR(), 'research.json');
const LEVELS = ['estado completo', 'RSI+EMA+MACD', 'RSI+EMA', 'taxa base'];

// ---------- calibração isotônica (Pool Adjacent Violators) ----------
// Blocos de tamanho mínimo (quantis) + PAV + encolhimento para 50% (prior de k amostras): estável com pouca amostra.
function fitIsotonic(xs, ys, { minN = 200, prior = 30 } = {}) {
  if (xs.length < minN) return null;                      // pouca amostra: sem calibração
  const idx = xs.map((x, i) => i).sort((a, b) => xs[a] - xs[b]);
  const size = Math.max(50, Math.ceil(xs.length / 25)), blocks = [];
  for (let s = 0; s < idx.length; s += size) {
    const part = idx.slice(s, s + size);
    blocks.push({ x: part.reduce((a, i) => a + xs[i], 0) / part.length, sum: part.reduce((a, i) => a + ys[i], 0), n: part.length });
  }
  const out = [];
  for (const b of blocks) {
    out.push({ ...b });
    while (out.length > 1 && out[out.length - 2].sum / out[out.length - 2].n >= out.at(-1).sum / out.at(-1).n) {
      const q = out.pop(), a = out.at(-1);
      a.x = (a.x * a.n + q.x * q.n) / (a.n + q.n); a.sum += q.sum; a.n += q.n;
    }
  }
  return { x: out.map(b => b.x), y: out.map(b => (b.sum + prior * 0.5) / (b.n + prior)) };
}
function applyIsotonic(iso, x) {
  if (!iso || !iso.x.length) return x;
  const { x: X, y: Y } = iso;
  if (x <= X[0]) return Y[0];
  if (x >= X.at(-1)) return Y.at(-1);
  let lo = 0, hi = X.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (X[m] <= x) lo = m; else hi = m; }
  const t = (x - X[lo]) / (X[hi] - X[lo] || 1);
  return Y[lo] + t * (Y[hi] - Y[lo]);
}

// ---------- regime ----------
// Sessões em UTC: Ásia 0–7, Londres 7–12, sobreposição Londres/NY 12–16, NY 16–21, fora 21–24
function session(epoch) {
  const h = new Date(epoch * 1000).getUTCHours();
  return h < 7 ? 'asia' : h < 12 ? 'londres' : h < 16 ? 'sobreposicao' : h < 21 ? 'ny' : 'fora';
}
const SESSIONS = ['asia', 'londres', 'sobreposicao', 'ny', 'fora'];

// ---------- features do meta-modelo (orientadas a favor da direção proposta) ----------
function features(candles, i, est, pDir, dir) {
  const win = candles.slice(Math.max(0, i - 120), i + 1);
  const ser = computeSeries(win), k = win.length - 1, s = snapshot(win, ser, k);
  const atrs = ser.atr14.slice(-100).filter(v => v != null);
  const atr = ser.atr14[k];
  const atrPct = atr != null && atrs.length ? atrs.filter(v => v <= atr).length / atrs.length : 0.5;
  const sgn = dir === 'CALL' ? 1 : -1;
  const ret3 = i >= 3 && atr ? (candles[i].close - candles[i - 3].close) / atr : 0;
  const sess = session(candles[i].epoch);
  const fav = x => (x == null ? 0.5 : dir === 'CALL' ? x : 1 - x);
  return [
    pDir,                                                     // prob. calibrada da direção
    Math.log(1 + est.n) / 8,                                  // tamanho da evidência
    LEVELS.indexOf(est.level) / 3,                            // nível de recuo
    ...SESSIONS.slice(0, 4).map(x => (x === sess ? sgn : 0)), // sessão × direção (+1 CALL, −1 PUT)
    atrPct,                                                   // regime de volatilidade
    fav(s.rsi == null ? null : s.rsi / 100),
    fav(s.bbPos == null ? null : Math.min(1, Math.max(0, s.bbPos))),
    s.macdHist != null && s.macdHistPrev != null ? Math.sign(s.macdHist - s.macdHistPrev) * sgn : 0,
    Math.max(-3, Math.min(3, ret3 * sgn)),                    // impulso recente a favor
  ];
}
const FEATURE_NAMES = ['prob_calibrada', 'log_n', 'nivel', 'sess_asia', 'sess_londres', 'sess_sobrep', 'sess_ny', 'atr_percentil', 'rsi_favor', 'bb_favor', 'macd_favor', 'impulso_favor'];

// ---------- regressão logística L2 ----------
const sigmoid = z => 1 / (1 + Math.exp(-z));
function fitLogistic(X, y, { l2 = 0.05, iters = 400, lr = 0.3 } = {}) {
  if (X.length < 300) return null;
  const d = X[0].length, mean = Array(d).fill(0), std = Array(d).fill(0);
  for (const r of X) r.forEach((v, j) => (mean[j] += v / X.length));
  for (const r of X) r.forEach((v, j) => (std[j] += (v - mean[j]) ** 2 / X.length));
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  const Z = X.map(r => r.map((v, j) => (v - mean[j]) / std[j]));
  const w = Array(d).fill(0); let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = Array(d).fill(0); let gb = 0;
    for (let n = 0; n < Z.length; n++) {
      const e = sigmoid(b + Z[n].reduce((a, v, j) => a + v * w[j], 0)) - y[n];
      gb += e; for (let j = 0; j < d; j++) gw[j] += e * Z[n][j];
    }
    b -= lr * gb / Z.length;
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / Z.length + l2 * w[j]);   // L2 forte: resiste a decorar ruído
  }
  return { w, b, mean, std };
}
function predictLogistic(m, x) { return m ? sigmoid(m.b + x.reduce((a, v, j) => a + ((v - m.mean[j]) / m.std[j]) * m.w[j], 0)) : null; }

// ---------- decisão (idêntica no backtest e ao vivo) ----------
// art = { iso, meta, payout, approved }; cfg = { edgeMargin, allowUnapproved }
function decide(candles, i, est, art, cfg = {}) {
  if (!est) return { ok: false, reason: 'sem estimativa' };
  const payout = (art && art.payout) || 0.95;
  const be = 1 / (1 + payout);
  const pCallCal = applyIsotonic(art && art.iso, est.pCall);
  // avalia as duas direções e fica com a de maior probabilidade final
  let dir = pCallCal >= 0.5 ? 'CALL' : 'PUT', pDir = Math.max(pCallCal, 1 - pCallCal), q = pDir;
  if (art && art.meta) {
    const qc = predictLogistic(art.meta, features(candles, i, est, pCallCal, 'CALL'));
    const qp = predictLogistic(art.meta, features(candles, i, est, 1 - pCallCal, 'PUT'));
    if (qc >= qp) { dir = 'CALL'; pDir = pCallCal; q = qc; } else { dir = 'PUT'; pDir = 1 - pCallCal; q = qp; }
    if (art.meta.qcal) q = applyIsotonic(art.meta.qcal, q);  // 2ª calibração (fora da amostra do meta)
  }
  const ev = q * payout - (1 - q);
  const margin = cfg.edgeMargin != null ? cfg.edgeMargin : 0.02;
  const base = { direction: dir, pCal: pDir, q, ev, be, payout };
  if (q < be + margin) return { ...base, ok: false, reason: `prob. final ${(q * 100).toFixed(1)}% < empate ${(be * 100).toFixed(1)}% + margem ${(margin * 100).toFixed(0)} p.p.` };
  if (art && !art.approved && !cfg.allowUnapproved) return { ...base, ok: false, reason: 'combinação não aprovada no backtest v2' };
  return { ...base, ok: true, reason: `prob. final ${(q * 100).toFixed(1)}% · VE ${(ev * 100).toFixed(1)}% por operação` };
}

// ---------- estatística ----------
function logChoose(n, k) { let s = 0; for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i); return s; }
function binomTailP(k, n, p) {                           // P(X >= k), X ~ Bin(n, p)
  if (n === 0) return 1;
  let s = 0;
  for (let j = k; j <= n; j++) s += Math.exp(logChoose(n, j) + j * Math.log(p) + (n - j) * Math.log(1 - p));
  return Math.min(1, s);
}
function benjaminiHochberg(ps, q = 0.1) {                 // devolve índices aprovados
  const idx = ps.map((p, i) => i).sort((a, b) => ps[a] - ps[b]);
  let kmax = -1;
  idx.forEach((i, r) => { if (ps[i] <= ((r + 1) / ps.length) * q) kmax = r; });
  return new Set(idx.slice(0, kmax + 1));
}

// ---------- artefatos ----------
let cache = null, cacheMtime = 0;
function loadResearch() {
  try {
    const st = fs.statSync(RESEARCH_FILE());
    if (!cache || st.mtimeMs !== cacheMtime) { cache = JSON.parse(fs.readFileSync(RESEARCH_FILE(), 'utf8')); cacheMtime = st.mtimeMs; }
    return cache;
  } catch { return null; }
}
function artifact(sym, tf, exp) { const r = loadResearch(); return r && r.combos ? r.combos[`${sym}|${tf}|${exp}`] || null : null; }
function saveResearch(obj) { fs.mkdirSync(DATA_DIR(), { recursive: true }); fs.writeFileSync(RESEARCH_FILE(), JSON.stringify(obj)); cache = null; }

// Regra ao vivo: v2 (calibração + meta + VE + aprovação) quando há data/research.json; senão a regra v1.
function liveDecision(candles, i, est, combo, cfg, fresh) {
  if (!fresh) return { ok: false, reason: 'dados atrasados' };
  if (!est) return { ok: false, reason: 'indicadores insuficientes' };
  if (est.n < cfg.minSamples) return { ok: false, reason: `amostra pequena (${est.n})`, direction: est.direction, p: est.p };
  if (!loadResearch()) {
    const v1 = est.p < cfg.minProb ? `probabilidade ${(est.p * 100).toFixed(1)}% < mínimo ${(cfg.minProb * 100).toFixed(0)}%`
      : est.lo <= 0.5 ? `intervalo de confiança inclui 50% (${(est.lo * 100).toFixed(1)}–${(est.hi * 100).toFixed(1)}%)` : null;
    return { ok: !v1, version: 'v1', direction: est.direction, p: est.p, reason: (v1 || `${est.n} casos (${est.level}); IC95% ${(est.lo * 100).toFixed(1)}–${(est.hi * 100).toFixed(1)}%`) + ' · regra v1 (rode o backtest v2)' };
  }
  const art = artifact(combo.symbol, combo.tf, combo.expiryMin) || { approved: false, payout: 0.95 };
  const d = decide(candles, i, est, art, cfg);
  return { ok: d.ok, version: 'v2', approved: !!art.approved, direction: d.direction, p: d.q, ev: d.ev, be: d.be, reason: d.reason };
}

module.exports = { liveDecision, fitIsotonic, applyIsotonic, session, SESSIONS, features, FEATURE_NAMES, fitLogistic, predictLogistic, sigmoid,
  decide, binomTailP, benjaminiHochberg, loadResearch, artifact, saveResearch, RESEARCH_FILE };
