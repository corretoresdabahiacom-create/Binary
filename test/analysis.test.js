'use strict';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'tac-test-')); // testes nunca tocam data/ real
const test = require('node:test');
const assert = require('node:assert');
const { analyze, gates } = require('../server/analysis');
const R = require('../server/research');

const G = 300;
function rng(seed) { let x = seed; return () => (x = (x * 16807) % 2147483647) / 2147483647; }
function walk(n, seed = 3, step = (r) => r() - 0.5) { const r = rng(seed); let p = 100; return Array.from({ length: n }, (_, i) => { const o = p; p = o + step(r, i); return { epoch: 1e9 + i * G, open: o, high: Math.max(o, p) + 0.05, low: Math.min(o, p) - 0.05, close: p }; }); }
const trend = n => walk(n, 5, (r) => 0.25 + (r() - 0.5) * 0.3);
const flat = n => { const r = rng(7); let prev = 100; return Array.from({ length: n }, (_, i) => { const o = prev, cl = 100 + (i % 2 ? 0.05 : -0.05) + (r() - 0.5) * 0.04 + (i % 37 === 0 ? 0.2 : 0); prev = cl; return { epoch: 1e9 + i * G, open: o, high: Math.max(o, cl) + 0.03 + r() * 0.05, low: Math.min(o, cl) - 0.03 - r() * 0.05, close: cl }; }); }; // oscila em torno de 100

test('anatomia da vela', () => {
  const c = walk(80); c[79] = { epoch: c[79].epoch, open: 10, high: 12, low: 9, close: 11 };
  const a = analyze(c, 79, { gran: G }).anatomy;
  assert.strictEqual(a.corpo, 1); assert.strictEqual(a.pavioSup, 1); assert.strictEqual(a.pavioInf, 1); assert.strictEqual(a.amplitude, 3);
  assert.strictEqual(a.posFechamento, 0.667); assert.strictEqual(a.corpoPct, 0.333);
});

test('regimes: tendência de alta = continuação (C); série plana = lateral (E)', () => {
  const t = analyze(trend(300), 299, { gran: G });
  assert.strictEqual(t.regime, 'C', t.regimeMotivo); assert.ok(t.indicators.adx14 > 20 && t.indicators.ema200 != null);
  const f = analyze(flat(300), 299, { gran: G });
  assert.strictEqual(f.regime, 'E', f.regimeMotivo);
});

test('bloqueios: conflito, estendido, lateral e histórico insuficiente', () => {
  const t = analyze(trend(300), 299, { gran: G });
  assert.ok(gates(t, 'PUT').blocks.some(b => /conflito/.test(b)), 'PUT contra continuação de alta');
  const c = trend(300); for (let j = 293; j < 300; j++) { const o = c[j - 1].close; c[j] = { epoch: c[j].epoch, open: o, close: o + 0.6, high: o + 0.65, low: o - 0.01 }; }
  assert.ok(gates(analyze(c, 299, { gran: G }), 'CALL').blocks.some(b => /estendido/.test(b)), 'CALL tardio após 7 velas verdes');
  const f = analyze(flat(300), 299, { gran: G });
  assert.ok(gates(f, 'CALL').blocks.some(b => /lateral/.test(b)));
  assert.ok(gates(f, 'CALL', { lateral: 0, espaco: 0, baixaVol: 0 }).blocks.every(b => !/lateral/.test(b)), 'filtro desligável');
  assert.ok(gates(analyze(walk(40), 39, { gran: G }), 'CALL').blocks[0].includes('histórico insuficiente'));
});

test('integridade: duplicada, OHLC inválido e lacuna intradiária bloqueiam; fim de semana não', () => {
  const dup = walk(120); dup[110].epoch = dup[109].epoch;
  assert.ok(gates(analyze(dup, 119, { gran: G }), 'CALL').blocks.some(b => /duplicada/.test(b)));
  const bad = walk(120); bad[115] = { ...bad[115], high: bad[115].low - 1 };
  assert.ok(gates(analyze(bad, 119, { gran: G }), 'CALL').blocks.some(b => /OHLC/.test(b)));
  const gap = walk(120).map((c, j) => (j >= 110 ? { ...c, epoch: c.epoch + 3600 } : c));
  assert.ok(gates(analyze(gap, 119, { gran: G }), 'CALL').blocks.some(b => /lacuna/.test(b)));
  const wk = walk(120).map((c, j) => (j >= 110 ? { ...c, epoch: c.epoch + 2 * 86400 } : c));
  assert.ok(!gates(analyze(wk, 119, { gran: G }), 'CALL').blocks.some(b => /lacuna/.test(b)));
});

test('rejeição com pavio inferior em suporte é reconhecida', () => {
  const c = walk(300, 11, (r, i) => Math.sin(i / 5) * 0.6 + (r() - 0.5) * 0.05);
  const zs = analyze(c, 298, { gran: G }).zones.filter(z => z.tipo === 'suporte');
  assert.ok(zs.length, 'há suporte'); const z = zs[0], o = z.ate + 0.3;
  c[299] = { epoch: c[299].epoch, open: o, close: o + 0.05, high: o + 0.08, low: z.preco - 0.02 };
  const a = analyze(c, 299, { gran: G });
  assert.ok(a.patterns.some(p => p.name === 'rejeicao_inferior_em_suporte'), JSON.stringify(a.patterns));
  assert.ok(a.zones.some(x => x.tipo === 'suporte' && x.estado === 'rejeitando'));
});

test('sem dados futuros: análise da vela i não muda com velas posteriores', () => {
  const c = walk(400);
  assert.deepStrictEqual(analyze(c.slice(0, 301), 300, { gran: G }), analyze(c, 300, { gran: G }));
});

test('decisão ao vivo: bloqueio do motor vira AGUARDAR com motivo e auditoria', () => {
  const c = trend(300);
  const est = { pCall: 0.3, pPut: 0.7, p: 0.7, direction: 'PUT', n: 200, lo: 0.62, hi: 0.77, level: 'estado completo' };
  const d = R.liveDecision(c, 299, est, { symbol: 'R_10', tf: '5m', expiryMin: 5 }, { minProb: 0.56, minSamples: 40 }, true);
  assert.strictEqual(d.ok, false); assert.match(d.reason, /^bloqueio: conflito/);
  assert.strictEqual(d.analysis.regime, 'C'); assert.ok(Array.isArray(d.analysis.contra) && d.analysis.indicadores.adx14 > 0);
  const off = R.liveDecision(c, 299, est, { symbol: 'R_10', tf: '5m', expiryMin: 5 }, { minProb: 0.56, minSamples: 40, analise: 0 }, true);
  assert.strictEqual(off.ok, true, 'motor desligável por configuração');
});
