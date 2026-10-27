'use strict';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'tac-test-')); // testes nunca tocam data/ real
const test = require('node:test');
const assert = require('node:assert');
const R = require('../server/research');
const { evaluateCombo, approve } = require('../server/backtest2');

function rng(seed) { let x = seed; return () => (x = (x * 16807) % 2147483647) / 2147483647; }
function walk(n, seed, drift = () => 0, g = 300) {
  const r = rng(seed); let p = 1000; const t0 = 1790000000 - (1790000000 % 86400);
  return Array.from({ length: n }, (_, i) => { const e = t0 + i * g, o = p; p = o + (r() - 0.5) + drift(e); return { epoch: e, open: o, high: Math.max(o, p) + 0.1, low: Math.min(o, p) - 0.1, close: p }; });
}

test('isotônica: monótona e corrige probabilidades exageradas', () => {
  const r = rng(3), xs = [], ys = [];
  for (let i = 0; i < 3000; i++) { const x = r(); xs.push(x); ys.push(r() < 0.5 + (x - 0.5) * 0.3 ? 1 : 0); } // verdade: bem menos extremo que x
  const iso = R.fitIsotonic(xs, ys);
  for (let i = 1; i < iso.y.length; i++) assert.ok(iso.y[i] >= iso.y[i - 1] - 1e-12);
  assert.ok(Math.abs(R.applyIsotonic(iso, 0.9) - 0.62) < 0.06, 'previsão de 90% vira ~62%');
  assert.strictEqual(R.fitIsotonic([0.6], [1]), null, 'pouca amostra → sem calibração');
});

test('logística: aprende o fator relevante e ignora ruído', () => {
  const r = rng(5), X = [], y = [];
  for (let i = 0; i < 4000; i++) { const a = r(), b = r(); X.push([a, b]); y.push(r() < 0.3 + 0.4 * a ? 1 : 0); }
  const m = R.fitLogistic(X, y);
  assert.ok(m.w[0] > 0.3 && Math.abs(m.w[1]) < 0.1, JSON.stringify(m.w));
  assert.ok(R.predictLogistic(m, [0.9, 0.5]) > 0.6 && R.predictLogistic(m, [0.1, 0.5]) < 0.4);
});

test('estatística: cauda binomial e Benjamini-Hochberg', () => {
  assert.ok(Math.abs(R.binomTailP(60, 100, 0.5) - 0.0284) < 0.001);
  const ok = R.benjaminiHochberg([0.001, 0.008, 0.039, 0.041, 0.6], 0.05);
  assert.deepStrictEqual([...ok].sort(), [0, 1]);
});

test('sessão do câmbio por hora UTC', () => {
  assert.strictEqual(R.session(Date.UTC(2026, 9, 26, 13) / 1000), 'sobreposicao');
  assert.strictEqual(R.session(Date.UTC(2026, 9, 26, 3) / 1000), 'asia');
});

test('backtest v2: ruído puro não aprova nenhuma combinação', () => {
  const res = {};
  for (const s of [11, 12, 13]) res['r' + s] = evaluateCombo(walk(6000, s), { gran: 300, expiryMin: 5 });
  approve(res);
  for (const r of Object.values(res)) {
    assert.strictEqual(r.approved, false);
    assert.ok(r.v2.pValue > 0.05, `ruído não é significativo (p=${r.v2.pValue})`);
    assert.ok(r.v2.rate == null || Math.abs(r.v2.rate - 0.5) < 0.04, `acerto ~50% (${r.v2.rate})`);
  }
});

test('backtest v2: efeito real de horário é descoberto fora da amostra (meta-modelo)', () => {
  const drift = e => (R.session(e) === 'sobreposicao' ? 0.12 : 0);    // ~ 57% de alta só no horário Londres/NY
  const r = evaluateCombo(walk(7000, 21, drift), { gran: 300, expiryMin: 5 });
  assert.ok(r.v2.n >= 40, `operou o efeito (${r.v2.n})`);
  assert.ok(r.v2.rate > 0.54, `acerto v2 ${r.v2.rate}`);
  assert.ok(r.v2.n > r.v1.n, 'v2 encontra mais operações que v1 com qualidade semelhante');
  assert.ok(r.v2.pValue < 0.01, `significativo (p=${r.v2.pValue})`);
  const sess = r.art.meta.w[5];                                        // peso de sess_sobrep × direção
  assert.ok(sess > 0 && sess === Math.max(...r.art.meta.w.map(Math.abs)), 'sessão é o fator mais forte do meta-modelo');
  assert.ok(approve({ x: r }).x.approved, 'aprovado (FDR, VE>0)');
});

test('decisão ao vivo: sem research usa v1; não aprovada bloqueia; liberar permite', () => {
  const c = walk(400, 7);
  const est = { pCall: 0.62, pPut: 0.38, p: 0.62, direction: 'CALL', n: 200, lo: 0.55, hi: 0.69, level: 'estado completo' };
  const cfg = { minProb: 0.56, minSamples: 40, edgeMargin: 0.02, allowUnapproved: 0, analise: 0 };
  const v1 = R.liveDecision(c, 399, est, { symbol: 'R_10', tf: '5m', expiryMin: 5 }, cfg, true);
  assert.strictEqual(v1.version, 'v1'); assert.ok(v1.ok);
  R.saveResearch({ combos: { 'R_10|5m|5': { approved: false, iso: null, meta: null, payout: 0.95 } } });
  const v2 = R.liveDecision(c, 399, est, { symbol: 'R_10', tf: '5m', expiryMin: 5 }, cfg, true);
  assert.strictEqual(v2.version, 'v2'); assert.strictEqual(v2.ok, false); assert.match(v2.reason, /não aprovada/);
  const lib = R.liveDecision(c, 399, est, { symbol: 'R_10', tf: '5m', expiryMin: 5 }, { ...cfg, allowUnapproved: 1 }, true);
  assert.ok(lib.ok && Math.abs(lib.ev - (0.62 * 0.95 - 0.38)) < 1e-9);
  assert.strictEqual(R.liveDecision(c, 399, est, { symbol: 'R_10', tf: '5m', expiryMin: 5 }, cfg, false).ok, false, 'dado atrasado');
  require('fs').unlinkSync(R.RESEARCH_FILE());
});

test('regras da Deriv para forex: só 15 min e sem negociação 20:50–22:00 UTC', () => {
  assert.deepStrictEqual(R.contractRules('frxEURUSD').expiries, [15]);
  assert.strictEqual(R.tradeable('frxEURUSD', Date.UTC(2026, 9, 26, 21, 0) / 1000), false);
  assert.strictEqual(R.tradeable('frxEURUSD', Date.UTC(2026, 9, 26, 13, 0) / 1000), true);
  const est = { pCall: 0.7, pPut: 0.3, p: 0.7, direction: 'CALL', n: 200, lo: 0.6, hi: 0.8, level: 'estado completo' };
  const d = R.liveDecision([], 0, est, { symbol: 'frxEURUSD', tf: '5m', expiryMin: 5 }, { minSamples: 40, minProb: 0.56 }, true);
  assert.strictEqual(d.ok, false); assert.match(d.reason, /mínimo 15/);
});

test('barreiras: eventos complementares e k=0 = Rise/Fall do dia', () => {
  const { barrierEvents } = require('../server/backtest2');
  const c = walk(400, 31);
  const e = barrierEvents(c, 1);
  e.ONETOUCH_alta.forEach((x, i) => assert.strictEqual(x, !e.NOTOUCH_alta[i]));
  e.RANGE.forEach((x, i) => assert.strictEqual(x, !e.UPORDOWN[i]));
  e.EXPIRYRANGE.forEach((x, i) => assert.strictEqual(x, !e.EXPIRYMISS[i]));
  const z = barrierEvents(c, 0); assert.deepStrictEqual(z.HIGHER, c.slice(15).map(x => x.close > x.open));
});

test('multiplicadores: no ruído o resultado médio fica perto de −comissão (sem vantagem)', () => {
  const { evaluateMultiplier } = require('../server/backtest2');
  const c = walk(6000, 41).map(x => ({ ...x, open: x.open + 1000, high: x.high + 1000, low: x.low + 1000, close: x.close + 1000 }));
  const r = evaluateMultiplier(c, { gran: 300, hold: 3, mult: 50, commission: 0.01 });
  assert.ok(r.modelo.n > 50);
  assert.ok(Math.abs(r.modelo.mediaPorOp + 0.01) < 0.03, `média ${r.modelo.mediaPorOp}`);
  assert.ok(r.modelo.pValue > 0.05);
});

test('barreira "1 dia" fiel à Deriv: janela da hora H até o fim do dia seguinte', () => {
  const { barrierEventsHourly } = require('../server/backtest2');
  const t0 = Date.UTC(2026, 0, 5) / 1000;                       // segunda-feira 00:00 UTC
  const hc = Array.from({ length: 24 * 40 }, (_, i) => ({ epoch: t0 + i * 3600, open: 100, high: 100.5, low: 99.5, close: 100 }));
  // pico às 20h do dia seguinte à compra (dentro da janela) e às 01h de d+2 (fora)
  const d = 20, buy = t0 + d * 86400 + 10 * 3600;
  hc.find(c => c.epoch === t0 + (d + 1) * 86400 + 20 * 3600).high = 110;
  hc.find(c => c.epoch === t0 + (d + 2) * 86400 + 1 * 3600).low = 90;
  const { ev } = barrierEventsHourly(hc, 1.5, 10);
  const idx = Math.floor((buy - t0) / 86400) - 15;              // posição do dia d nos eventos (a partir do dia 15)
  assert.strictEqual(ev.ONETOUCH_alta[idx], true, 'toque no dia seguinte conta');
  assert.strictEqual(ev.ONETOUCH_baixa[idx], false, 'toque depois do fim do dia seguinte não conta');
});
