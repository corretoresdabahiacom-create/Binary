'use strict';
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { ForwardCtx, RULES } = require('../server/forward2');
const { features, FAMS, keyOf } = require('../server/ctx');
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fw2-'));
function walk(n, seed = 3, rev = false) { let s = seed, r = () => (s = (s * 16807) % 2147483647) / 2147483647, p = 150, t = 1700000000, o = [], prevUp = 0; for (let i = 0; i < n; i++) { const op = p; let up = r() > 0.5; if (rev && prevUp !== 0 && r() < 0.35) up = prevUp < 0; const cl = op + (up ? 1 : -1) * (0.02 + r() * 0.05); o.push({ epoch: t += 900, open: op, high: Math.max(op, cl) + r() * 0.02, low: Math.min(op, cl) - r() * 0.02, close: cl }); prevUp = up ? 1 : -1; p = cl; } return o; }
test('contexto da cauda == contexto da série inteira (sem depender do futuro)', () => {
  const cs = walk(2500), Ff = features(cs); let same = 0, tot = 0;
  for (let i = 1500; i < 2500; i += 7) { const Ft = features(cs.slice(0, i + 1).slice(-700)), a = Ft.at(-1), b = Ff[i]; for (const fam of FAMS.filter(f => RULES.some(r => r.famId === f.id))) { tot++; if (keyOf(a, fam) === keyOf(b, fam)) same++; } }
  assert.ok(same / tot > 0.9, 'consistência ' + same / tot);
});
test('registra previsões, resolve sem vazamento e sobrevive a reinício', () => {
  const d = dir(), all = walk(3200, 5, true); let f = new ForwardCtx({ dir: d }); f.seed(all.slice(0, 2400));
  for (let k = 2400; k < 3000; k++) f.onClosed(all.slice(0, k + 1));
  const preds = f.rows.filter(r => r.event === 'pred'), res = f.rows.filter(r => r.event === 'result');
  assert.ok(preds.length > 0 && res.length > 0); for (const r of res) assert.ok(r.closedAt > r.candle);
  const n = f.rows.length; f = new ForwardCtx({ dir: d }); assert.strictEqual(f.rows.length, n);
  f.seed(all.slice(0, 3000)); f.onClosed(all.slice(0, 3000)); assert.strictEqual(f.rows.length, n);
  const s = f.summary(); assert.match(s.status, /EXPERIMENTAL/); assert.strictEqual(s.rules.length, 3);
});
test('em ruído puro o resumo não declara vantagem', () => {
  const all = walk(3000, 9), f = new ForwardCtx({ dir: dir() }); f.seed(all.slice(0, 2000)); for (let k = 2000; k < 3000; k++) f.onClosed(all.slice(0, k + 1));
  for (const r of f.summary().rules) if (r.todas.n >= 100) assert.ok(r.todas.ci90Low < 0.55, 'sem vantagem em ruído');
});
