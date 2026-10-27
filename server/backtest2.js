'use strict';
// Backtest v2 de UMA combinação (ativo × gráfico × expiração), sem rede — testável com dados sintéticos.
// Walk-forward em janelas de FOLD velas. Em cada janela:
//   treino = velas até (início − embargo); dentro do treino: 70% → modelo A; 30% → previsões FORA da amostra
//   de A, usadas para ajustar a calibração isotônica e o meta-modelo; modelo primário final = treino inteiro.
//   teste = a janela; operações sem sobreposição (após uma entrada, pula até a expiração).
const { buildModel, estimate, wilson } = require('./probability');
const R = require('./research');
const AN = require('./analysis');

function trainArtifacts(c, trainEnd, h, minSamples) {
  const split = Math.floor(trainEnd * 0.7);
  const A = buildModel(c.slice(0, split + 1), h);
  const xs = [], ys = [], rows = [];
  for (let j = split + h + 1; j + h <= trainEnd; j++) {       // rótulos de B só usam velas ≤ trainEnd
    const e = estimate(A, c, j, minSamples); if (!e) continue;
    const d = c[j + h].close - c[j].close; if (d === 0) continue;
    xs.push(e.pCall); ys.push(d > 0 ? 1 : 0); rows.push({ j, e, up: d > 0 });
  }
  const iso = R.fitIsotonic(xs, ys);
  // B1 (60%) treina o meta-modelo; B2 (40%) recalibra a saída dele. Se o meta não acerta em B2, a saída vira ~50%.
  const cut = Math.floor(rows.length * 0.6), X = [], y = [];
  for (const r of rows.slice(0, cut)) {                    // simétrico: uma linha para CALL e outra para PUT
    const pc = R.applyIsotonic(iso, r.e.pCall);
    X.push(R.features(c, r.j, r.e, pc, 'CALL')); y.push(r.up ? 1 : 0);
    X.push(R.features(c, r.j, r.e, 1 - pc, 'PUT')); y.push(r.up ? 0 : 1);
  }
  const meta = R.fitLogistic(X, y);
  let qcal = null;
  if (meta) {
    const qs = [], ok = [];
    for (const r of rows.slice(cut)) {
      const d = R.decide(c, r.j, r.e, { iso, meta, payout: 0.95, approved: true }, { edgeMargin: -1 });
      qs.push(d.q); ok.push((d.direction === 'CALL') === r.up ? 1 : 0);
    }
    qcal = R.fitIsotonic(qs, ok);
    if (meta) meta.qcal = qcal;
  }
  return { iso, meta, model: buildModel(c.slice(0, trainEnd + 1), h), calibSamples: xs.length };
}

function stats(tr, payout) {
  const n = tr.length, w = tr.filter(t => t.win).length, be = 1 / (1 + payout);
  const [lo, hi] = wilson(w, n);
  return { n, wins: w, rate: n ? w / n : null, ic95: n ? [lo, hi] : null, evPerTrade: n ? (w * payout - (n - w)) / n : null,
    pValue: R.binomTailP(w, n, be) };
}

function evaluateCombo(c, { filters = {}, symbol = '', gran, expiryMin, payout = 0.95, minProb = 0.56, minSamples = 40, edgeMargin = 0.02, start = 3000, fold = 1000 } = {}) {
  const h = expiryMin * 60 / gran;
  if (!Number.isInteger(h) || h < 1) return null;
  const emb = h + 2;
  const raw = [], v2 = [], v3 = [], base = [], calib = {}, bySession = {}, byRegime = {}, byFold = [], blockCount = {};
  let nextRaw = -1, nextV2 = -1, nextV3 = -1, nextBase = -1, folds = 0;
  for (let t0 = start; t0 + h < c.length - 1; t0 += fold) {
    const art = trainArtifacts(c, t0 - emb, h, minSamples); folds++;
    const fr = { inicio: c[t0].epoch, v2: [], v3: [] };   // resultados desta janela (estabilidade)
    for (let t = t0; t < Math.min(t0 + fold, c.length - 1 - h); t++) {
      const e = estimate(art.model, c, t, minSamples); if (!e) continue;
      const d = c[t + h].close - c[t].close; if (d === 0) continue;
      const up = d > 0;
      if (!R.tradeable(symbol, c[t].epoch + gran)) continue;          // horário sem negociação na Deriv
      if (t >= nextBase) {                                             // referência simples: segue a cor da última vela
        const bdir = c[t].close >= c[t].open ? 'CALL' : 'PUT'; base.push({ t, win: (bdir === 'CALL') === up }); nextBase = t + h;
      }
      if (t >= nextRaw && e.n >= minSamples && e.p >= minProb && e.lo > 0.5) {       // regra v1 (atual)
        const win = (e.direction === 'CALL') === up; raw.push({ t, win }); nextRaw = t + h;
        const s = R.session(c[t].epoch); (bySession[s] = bySession[s] || []).push({ win });
      }
      const dc = R.decide(c, t, e, { iso: art.iso, meta: art.meta, payout, approved: true }, { edgeMargin });
      const bin = Math.min(0.7, Math.max(0.4, Math.floor(dc.q * 20) / 20)).toFixed(2);  // curva de calibração (fora da amostra)
      const cb = calib[bin] = calib[bin] || { n: 0, w: 0, sumQ: 0 }; cb.n++; cb.sumQ += dc.q; if ((dc.direction === 'CALL') === up) cb.w++;
      if (dc.ok && t >= nextV2) {
        const win = (dc.direction === 'CALL') === up;
        v2.push({ t, win, q: dc.q }); fr.v2.push({ win }); nextV2 = t + h;
        const an = AN.analyze(c, t, { gran, cfg: filters }), g = AN.gates(an, dc.direction, filters);
        (byRegime[an.regime || '?'] = byRegime[an.regime || '?'] || []).push({ win });
        for (const b of g.blocks) { const k = b.split(':')[0].split('(')[0].trim(); blockCount[k] = blockCount[k] || { n: 0, w: 0 }; blockCount[k].n++; if (win) blockCount[k].w++; }
        if (!g.blocks.length && t >= nextV3) { v3.push({ t, win }); fr.v3.push({ win }); nextV3 = t + h; }
      }
    }
    byFold.push({ inicio: fr.inicio, v2: stats(fr.v2, payout), v3: stats(fr.v3, payout) });
  }
  const final = trainArtifacts(c, c.length - 1, h, minSamples);   // artefatos para uso ao vivo (todo o histórico)
  return {
    horizon: h, folds, testCandles: Math.max(0, c.length - start), payout, breakeven: 1 / (1 + payout),
    v1: stats(raw, payout), v2: stats(v2, payout), v3: stats(v3, payout), referencia: stats(base, payout),
    v2PorRegime: Object.fromEntries(Object.entries(byRegime).map(([k, t]) => [k, stats(t, payout)])),
    bloqueadosPorMotivo: Object.fromEntries(Object.entries(blockCount).map(([k, x]) => [k, { n: x.n, acertoSeOperasse: x.n ? x.w / x.n : null }])),
    estabilidade: byFold,
    calibration: Object.entries(calib).sort().map(([b, x]) => ({ faixa: b, n: x.n, previsto: x.sumQ / x.n, observado: x.w / x.n })),
    v1PorSessao: Object.fromEntries(Object.entries(bySession).map(([s, t]) => [s, stats(t, payout)])),
    art: { iso: final.iso, meta: final.meta, payout },
  };
}

// Marca aprovadas: BH (FDR 10%) sobre os p-valores do v2, VE > 0 e amostra mínima de operações independentes.
function approve(results, { fdr = 0.1, minTrades = 30 } = {}) {
  // aprova pela regra que vai ao vivo: v3 (v2 + bloqueios do motor de análise)
  const keys = Object.keys(results).filter(k => results[k] && results[k].v3 && results[k].v3.n > 0);
  const ok = R.benjaminiHochberg(keys.map(k => results[k].v3.pValue), fdr);
  for (const k of Object.keys(results)) if (results[k]) results[k].approved = false;
  keys.forEach((k, i) => { const r = results[k]; r.approved = ok.has(i) && r.v3.evPerTrade > 0 && r.v3.n >= minTrades; });
  return results;
}

// ---------- Multiplicadores ----------
// Direção pelo mesmo modelo (calibração + meta, treinados só no passado); mantém h velas; resultado em
// múltiplos do valor investido: mult × movimento − comissão, limitado a −1 (stop-out da Deriv). Sem sobreposição.
function evaluateMultiplier(c, { gran, hold, mult, commission, minSamples = 40, edgeMargin = 0.02, start = 3000, fold = 1000 } = {}) {
  const emb = hold + 2, tr = [], longOnly = [];
  let next = -1, nextL = -1;
  for (let t0 = start; t0 + hold < c.length - 1; t0 += fold) {
    const art = trainArtifacts(c, t0 - emb, hold, minSamples);
    for (let t = t0; t < Math.min(t0 + fold, c.length - 1 - hold); t++) {
      const e = estimate(art.model, c, t, minSamples); if (!e) continue;
      const pnl = sgn => {
        const entry = c[t].close; let worst = 0;
        for (let j = t + 1; j <= t + hold; j++) worst = Math.min(worst, sgn * ((sgn > 0 ? c[j].low : c[j].high) - entry) / entry);
        if (mult * worst <= -1) return -1;                     // stop-out
        return Math.max(-1, mult * sgn * (c[t + hold].close - entry) / entry) - commission;
      };
      if (t >= nextL) { longOnly.push(pnl(1)); nextL = t + hold; }
      if (t < next) continue;
      const d = R.decide(c, t, e, { iso: art.iso, meta: art.meta, payout: 1, approved: true }, { edgeMargin });
      if (!d.ok) continue;
      tr.push(pnl(d.direction === 'CALL' ? 1 : -1)); next = t + hold;
    }
  }
  const st = a => { const n = a.length; if (!n) return { n: 0 }; const m = a.reduce((x, y) => x + y, 0) / n; const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, n - 1));
    const tstat = sd ? m / (sd / Math.sqrt(n)) : 0; const p = 0.5 * (1 - erf(tstat / Math.SQRT2));
    return { n, mediaPorOp: m, acerto: a.filter(x => x > 0).length / n, stopOuts: a.filter(x => x <= -1).length, t: tstat, pValue: p }; };
  return { hold, mult, commission, modelo: st(tr), sempreCompra: st(longOnly) };
}
function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }

// ---------- Contratos com barreira (estático) ----------
// Compara a probabilidade embutida no preço da Deriv (valor investido ÷ payout) com a frequência histórica
// do evento, com a barreira à mesma distância em ATRs diárias. Entrada na abertura do dia; toque pela máxima/
// mínima do dia; término pelo fechamento.
function barrierEvents(c, k) {
  const { atr } = require('./indicators'); const A = atr(c, 14);
  const ev = { ONETOUCH_alta: [], ONETOUCH_baixa: [], NOTOUCH_alta: [], NOTOUCH_baixa: [], HIGHER: [], LOWER: [], EXPIRYRANGE: [], EXPIRYMISS: [], RANGE: [], UPORDOWN: [] };
  for (let i = 15; i < c.length; i++) {
    const a = A[i - 1]; if (!a) continue;                    // ATR conhecido antes do dia i
    const o = c[i].open, hi = c[i].high, lo = c[i].low, cl = c[i].close, up = o + k * a, dn = o - k * a;
    ev.ONETOUCH_alta.push(hi >= up); ev.NOTOUCH_alta.push(hi < up);
    ev.ONETOUCH_baixa.push(lo <= dn); ev.NOTOUCH_baixa.push(lo > dn);
    ev.HIGHER.push(cl > up); ev.LOWER.push(cl < dn);
    ev.EXPIRYRANGE.push(cl > dn && cl < up); ev.EXPIRYMISS.push(cl >= up || cl <= dn);
    ev.RANGE.push(hi < up && lo > dn); ev.UPORDOWN.push(hi >= up || lo <= dn);
  }
  return ev;
}

module.exports = { evaluateCombo, approve, trainArtifacts, evaluateMultiplier, barrierEvents };
