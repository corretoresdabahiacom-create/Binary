'use strict';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'tac-test-')); // testes nunca tocam data/ real
const test = require('node:test');
const assert = require('node:assert');
const { levels, room } = require('../server/levels');
const catalogLib = require('../server/catalog');
const { Scanner } = require('../server/scanner');

// Oscila entre 100 e 110: resistência ~110, suporte ~100
function range(n) { return Array.from({ length: n }, (_, i) => { const p = 105 + 5 * Math.sin(i / 4); return { epoch: i * 300, open: p - 0.2, high: p + 0.3, low: p - 0.3, close: p }; }); }

test('suporte e resistência: acha os níveis do canal com vários toques', () => {
  const lv = levels(range(300));
  const r = lv.levels.find(l => l.type === 'resistencia'), s = lv.levels.find(l => l.type === 'suporte');
  assert.ok(r && Math.abs(r.price - 110.3) < 0.5 && r.touches >= 3, JSON.stringify(r));
  assert.ok(s && Math.abs(s.price - 99.7) < 0.5 && s.touches >= 3, JSON.stringify(s));
  assert.ok(room(lv, 'CALL') >= 0 && room(lv, 'CALL') <= 3);
});

test('suporte e resistência: sem dados futuros (resultado na vela i não muda com velas depois)', () => {
  const c = range(400);
  const a = levels(c.slice(0, 301), 300), b = levels(c, 300);
  assert.deepStrictEqual(a.levels, b.levels);
});

test('catálogo usa o mesmo horizonte da expiração', () => {
  // padrão plantado: depois de vela verde o preço sobe nas 3 velas seguintes
  let p = 100, x = 5; const r = () => (x = (x * 16807) % 2147483647) / 2147483647, c = [];
  let boost = 0;
  for (let i = 0; i < 4000; i++) { const o = p; p = o + (r() - 0.5) + (boost > 0 ? 0.35 : 0); boost--; if (p > o && boost < 0 && r() < 0.5) boost = 3; c.push({ epoch: i * 300, open: o, high: Math.max(o, p), low: Math.min(o, p), close: p }); }
  const cat = catalogLib.buildCatalog(c, { horizon: 3 });
  assert.strictEqual(cat.horizon, 3);
  assert.ok(cat.rules.length > 0);
});

test('catalogador: concorda / discorda / sem regra', () => {
  const sc = new Scanner({ getCfg: () => ({ catalogFilter: 1, maxDataAgeSec: 20 }), symbols: ['frxEURUSD'], tfs: ['5m'] });
  const st = sc.streams.get('frxEURUSD|5m');
  st.candles = range(200);
  const f = catalogLib.features(st.candles.slice(-151), require('../server/indicators').computeSeries(st.candles.slice(-151)), 150);
  const key = [f.hora, f.dia].join('&');
  st.catalogs = { 15: { validated: 1, rules: [{ keys: ['hora', 'dia'], key, direction: 'CALL', validated: true, testRate: 0.6, testN: 50 }] } };
  assert.strictEqual(sc.agreement('frxEURUSD', '5m', 15, st.candles, 199, 'CALL').status, 'concorda');
  assert.strictEqual(sc.agreement('frxEURUSD', '5m', 15, st.candles, 199, 'PUT').status, 'discorda');
  const g = sc._catalogGate(st, 15, 199, { ok: true, direction: 'PUT', reason: 'x' });
  assert.strictEqual(g.ok, false, 'filtro 1 bloqueia discordância');
  st.catalogs = { 15: { validated: 0, rules: [] } };
  assert.strictEqual(sc.agreement('frxEURUSD', '5m', 15, st.candles, 199, 'CALL').status, 'sem regra validada');
});

test('suporte e resistência: funciona com máximas/mínimas repetidas (passeio aleatório)', () => {
  let x = 9; const r = () => (x = (x * 16807) % 2147483647) / 2147483647; let p = 1000; const c = [];
  for (let i = 0; i < 500; i++) { const o = p; p += r() - 0.5; c.push({ epoch: i * 900, open: o, high: Math.max(o, p) + 0.1, low: Math.min(o, p) - 0.1, close: p }); }
  const lv = levels(c);
  assert.ok(lv.levels.length >= 2, `níveis encontrados: ${lv.levels.length}`);
  for (const l of lv.levels) assert.ok(l.touches >= 2);
});
