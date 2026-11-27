'use strict';
// Contextos de local da vela (número redondo, faixa do dia anterior, faixa de 96 velas, médias, sessão, volatilidade) × sequência. Só usa o passado.
const wil = (w, n) => { if (!n) return 0; const z = 1.645, p = w / n, d = 1 + z * z / n; return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d; };
function atr(cs) { const a = new Array(cs.length).fill(null); let s = 0; for (let i = 1; i < cs.length; i++) { const tr = Math.max(cs[i].high - cs[i].low, Math.abs(cs[i].high - cs[i - 1].close), Math.abs(cs[i].low - cs[i - 1].close)); if (i <= 14) { s += tr; if (i === 14) a[i] = s / 14; } else a[i] = (a[i - 1] * 13 + tr) / 14; } return a; }
const b5 = d => d <= -1 ? 0 : d < -0.3 ? 1 : d <= 0.3 ? 2 : d <= 1 ? 3 : 4;
const sg = c => Math.sign(c.close - c.open);
function features(cs) {                                         // para cada vela i: dicionário de contextos (só passado)
  const A = atr(cs), L = cs.length, out = new Array(L).fill(null);
  const day = e => Math.floor(e / 86400), dh = {}, dl = {};
  for (const c of cs) { const d = day(c.epoch); dh[d] = Math.max(dh[d] ?? -1e9, c.high); dl[d] = Math.min(dl[d] ?? 1e9, c.low); }
  const sma = (i, n) => { let s = 0; for (let j = i - n + 1; j <= i; j++) s += cs[j].close; return s / n; };
  for (let i = 100; i < L; i++) {
    if (A[i] == null) continue; const c = cs[i], a = A[i], d = day(c.epoch), hr = new Date(c.epoch * 1000).getUTCHours();
    const f = {};
    f.r50 = b5((c.close - Math.round(c.close * 2) / 2) / a);
    f.r100 = b5((c.close - Math.round(c.close)) / a);
    const ph = dh[d - 1] ?? dh[d - 3], pl = dl[d - 1] ?? dl[d - 3];          // dia anterior (ou sexta)
    if (ph != null) { const p = (c.close - pl) / (ph - pl); f.pd = p < 0 ? 0 : p < .25 ? 1 : p < .5 ? 2 : p < .75 ? 3 : p <= 1 ? 4 : 5; }
    let hi = -1e9, lo = 1e9; for (let j = i - 96; j < i; j++) { hi = Math.max(hi, cs[j].high); lo = Math.min(lo, cs[j].low); }
    const q = (c.close - lo) / (hi - lo); f.rg = q < 0 ? 0 : q < .2 ? 1 : q < .4 ? 2 : q < .6 ? 3 : q < .8 ? 4 : q <= 1 ? 5 : 6;
    f.t4 = b5((c.close - sma(i, 16)) / a); f.t24 = b5((c.close - sma(i, 96)) / a);
    f.ses = hr < 7 ? 0 : hr < 12 ? 1 : hr < 16 ? 2 : hr < 21 ? 3 : 4;
    const ws = A.slice(i - 99, i + 1).slice().sort((x, y) => x - y), med = ws[50], v = a / med; f.vol = v < .8 ? 0 : v < 1.2 ? 1 : 2;
    const b = Math.abs(c.close - c.open) / a, rg = (c.high - c.low) || 1e-12;
    f.cand = (b < .3 ? 0 : b < .8 ? 1 : 2) * 9 + ((c.high - Math.max(c.open, c.close)) / rg > .4 ? 1 : 0) * 3 + ((Math.min(c.open, c.close) - c.low) / rg > .4 ? 1 : 0);
    f.s1 = sg(c) + 1; f.s2 = f.s1 * 3 + sg(cs[i - 1]) + 1; f.s3 = f.s2 * 3 + sg(cs[i - 2]) + 1;
    out[i] = f;
  }
  return out;
}
const FAMS = []; for (const loc of [['r50'], ['r100'], ['pd'], ['rg'], ['t4'], ['t24'], ['ses'], ['vol'], ['cand'], ['t24', 'rg'], ['r50', 'rg'], ['ses', 't24'], []]) for (const s of ['s1', 's2', 's3']) { if (!loc.length && s === 's1') continue; FAMS.push({ loc, s, id: (loc.join('+') || 'só-sequência') + '|' + s }); }
const keyOf = (f, fam) => { for (const k of fam.loc) if (f[k] == null) return null; return fam.id + ':' + fam.loc.map(k => f[k]).join(',') + ':' + f[fam.s]; };
module.exports = { features, FAMS, keyOf, wil, atr };
