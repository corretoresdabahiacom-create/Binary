'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildModel, estimate, wilson } = require('../server/probability');

function series(n, step, seed = 1) {
  let x = seed, p = 1000; const out = [];
  const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < n; i++) { const o = p; p = o + step(rnd, i); out.push({ epoch: i * 300, open: o, high: Math.max(o, p) + 0.1, low: Math.min(o, p) - 0.1, close: p }); }
  return out;
}

test('ruído puro (passeio aleatório): probabilidade perto de 50% e IC inclui 50%', () => {
  const c = series(6000, r => r() - 0.5);
  const m = buildModel(c, 1);
  let passes = 0, tried = 0;
  for (let i = 5000; i < 6000; i += 10) { const e = estimate(m, c, i, 40); if (!e) continue; tried++; if (e.lo > 0.5 && e.p >= 0.56) passes++; }
  assert.ok(tried > 50);
  assert.ok(passes / tried < 0.1, `falsos sinais demais: ${passes}/${tried}`);
});

test('padrão real (reversão à média): o modelo encontra a direção certa', () => {
  // depois de queda forte o preço tende a subir e vice-versa
  const c = series(6000, (r, i) => 0, 3);
  let p = 1000, x = 7; const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < c.length; i++) {
    const prev = i ? c[i - 1].close - (i > 1 ? c[i - 2].close : c[i - 1].close) : 0;
    const o = p; p = o + (rnd() - 0.5) - 0.6 * prev;
    c[i] = { epoch: i * 300, open: o, high: Math.max(o, p) + 0.1, low: Math.min(o, p) - 0.1, close: p };
  }
  const m = buildModel(c.slice(0, 5000), 1);
  let ok = 0, n = 0;
  for (let i = 5000; i < 5999; i++) {
    const e = estimate(m, c, i, 40); if (!e || e.lo <= 0.5) continue;
    n++; if ((c[i + 1].close > c[i].close) === (e.direction === 'CALL')) ok++;
  }
  assert.ok(n > 30, 'emitiu sinais com vantagem real');
  assert.ok(ok / n > 0.55, `acerto fora da amostra ${(ok / n).toFixed(2)}`);
});

test('sem dados futuros: o modelo ignora velas cujo resultado ainda não existe', () => {
  const c = series(500, r => r() - 0.5);
  const a = buildModel(c.slice(0, 300), 3);
  const b = buildModel(c.slice(0, 300).concat(c.slice(300).map(x => ({ ...x, close: x.close + 1e6 }))), 3);
  const keyA = [...a.table.entries()].filter(([k]) => k === 'base')[0][1];
  assert.strictEqual(a.samples + a.ties, 300 - 35 - 3, 'última vela usada é a 296 (resultado em 299)');
  assert.ok(b.samples > a.samples);
  assert.ok(keyA.n === a.samples);
});

test('wilson: intervalo correto', () => {
  const [lo, hi] = wilson(60, 100);
  assert.ok(Math.abs(lo - 0.502) < 0.002 && Math.abs(hi - 0.691) < 0.002);
});
