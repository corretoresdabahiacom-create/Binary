'use strict';
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Forward, RULE } = require('../server/forward');
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fw-'));
// velas com padrão plantado: após 3 velas de alta, a próxima SEMPRE cai (contra a última vela)
function candles(n, rule) { let p = 100, t = 1700000000; const o = []; let run = 0; for (let i = 0; i < n; i++) { const up = rule(i, run); const op = p, cl = p + (up ? 0.1 : -0.1); o.push({ epoch: t, open: op, high: Math.max(op, cl), low: Math.min(op, cl), close: cl }); run = up ? run + 1 : 0; p = cl; t += RULE.gran; } return o; }
const planted = (i, run) => (run >= 3 ? false : (i % 7 === 0 ? false : true));

test('aprende o padrão plantado, entra CONTRA a última vela e resolve com win', () => {
  const all = candles(400, planted), f = new Forward({ dir: dir() });
  f.seed(all.slice(0, 300));
  for (let k = 300; k < all.length; k++) f.onClosed(all.slice(0, k + 1));
  const s = f.summary();
  assert.ok(s.predictions > 0 && s.resolved > 0);
  assert.ok(f.rows.some(r => r.event === 'pred' && r.vsLast === 'contra'));
  assert.ok(s.rate >= 0.9, 'padrão determinístico deve acertar: ' + s.rate);
});
test('sem vazamento: a previsão da vela k usa só velas até k-1 e o resultado só aparece depois que a vela fecha', () => {
  const all = candles(400, planted), f = new Forward({ dir: dir() });
  f.seed(all.slice(0, 300));
  f.onClosed(all.slice(0, 302));                                   // pula 1 vela → lacuna: só reconstrói
  for (let k = 302; k < 380; k++) { const before = f.rows.filter(r => r.event === 'result').length; f.onClosed(all.slice(0, k + 1)); const preds = f.rows.filter(r => r.event === 'pred'); const last = preds.at(-1); if (last && last.candle === all[k].epoch + RULE.gran) assert.ok(!f.rows.some(r => r.event === 'result' && r.candle === last.candle)); }
  for (const r of f.rows.filter(r => r.event === 'result')) assert.ok(r.closedAt > r.candle);
});
test('persistência: reinício não repete previsão e mantém o histórico', () => {
  const d = dir(), all = candles(400, planted); let f = new Forward({ dir: d });
  f.seed(all.slice(0, 300)); for (let k = 300; k < 340; k++) f.onClosed(all.slice(0, k + 1));
  const n = f.rows.length; assert.ok(n > 0);
  f = new Forward({ dir: d }); assert.strictEqual(f.rows.length, n);
  f.seed(all.slice(0, 340)); f.onClosed(all.slice(0, 340));        // mesma vela de novo: ignora
  assert.strictEqual(f.rows.length, n);
});
test('em ruído puro não declara vantagem e avisa amostra pequena', () => {
  let s = 5; const r = () => (s = (s * 16807) % 2147483647) / 2147483647; const all = candles(900, () => r() > 0.5), f = new Forward({ dir: dir() });
  f.seed(all.slice(0, 600)); for (let k = 600; k < all.length; k++) f.onClosed(all.slice(0, k + 1));
  const x = f.summary(); assert.match(x.status, /EXPERIMENTAL/); if (x.resolved < 300) assert.match(x.note, /amostra pequena/);
});
