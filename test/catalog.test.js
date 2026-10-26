'use strict';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'tac-test-')); // testes nunca tocam data/ real
const test = require('node:test');
const assert = require('node:assert');
const { rsi, ema, macd, bollinger, atr, detectPatterns } = require('../server/indicators');
const { buildCatalog, wilsonLower, binomPValue } = require('../server/catalog');

function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }

function walk(n, seed, plant = false) {
  const r = rng(seed);
  const out = []; let price = 1000; const t0 = 1_700_000_000 - (1_700_000_000 % 900);
  let prevPatternBull = false;
  for (let i = 0; i < n; i++) {
    const o = price;
    // padrão plantado: depois de vela vermelha às 10h UTC, a próxima sobe 80% das vezes
    const hour = new Date((t0 + i * 900) * 1000).getUTCHours();
    let up = r() < 0.5;
    if (plant && hour === 10 && prevPatternBull) up = r() < 0.8;
    const move = (0.5 + r()) * 2;
    const c = o + (up ? move : -move);
    out.push({ epoch: t0 + i * 900, open: o, high: Math.max(o, c) + r(), low: Math.min(o, c) - r(), close: c });
    prevPatternBull = c < o; // vela vermelha
    price = c;
  }
  return out;
}

test('indicadores: valores conhecidos', () => {
  const up = Array.from({ length: 30 }, (_, i) => i + 1);
  assert.strictEqual(Math.round(rsi(up, 14).at(-1)), 100);
  assert.ok(Math.abs(ema([1, 2, 3, 4, 5], 5)[4] - 3) < 1e-9);
  const b = bollinger(Array(25).fill(5), 20);
  assert.strictEqual(b.upper[24], 5);
  const m = macd(Array.from({ length: 80 }, (_, i) => i));
  assert.ok(m.line.at(-1) > 0);
  assert.strictEqual(atr([{ high: 2, low: 1, close: 1.5 }, ...Array(20).fill({ high: 2, low: 1, close: 1.5 })], 14).at(-1), 1);
});

test('padrões de vela', () => {
  const c = [
    { open: 10, high: 10.1, low: 8.9, close: 9 },
    { open: 8.9, high: 10.6, low: 8.8, close: 10.5 },
  ];
  assert.ok(detectPatterns(c, 1).some(p => p.name === 'engolfo_alta'));
  const hammer = [{ open: 10, high: 10.22, low: 9, close: 10.2 }];
  assert.ok(detectPatterns(hammer, 0).some(p => p.name === 'martelo'));
});

test('wilson e p-valor', () => {
  assert.ok(wilsonLower(90, 100) < 0.9 && wilsonLower(90, 100) > 0.8);
  assert.ok(binomPValue(50, 100, 0.5) > 0.4);
  assert.ok(binomPValue(70, 100, 0.5) < 0.001);
});

test('ruído puro: o catálogo NÃO valida regras (sem falsos padrões)', () => {
  let totalValidated = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const cat = buildCatalog(walk(20000, seed));
    totalValidated += cat.validated;
  }
  assert.strictEqual(totalValidated, 0, 'ruído não deve gerar regras validadas após correção de Bonferroni');
});

test('padrão plantado é encontrado e validado fora da amostra', () => {
  const cat = buildCatalog(walk(40000, 7, true));
  const hit = cat.rules.find(r => r.validated && r.key.includes('hora:10') && r.direction === 'CALL');
  assert.ok(hit, 'deveria achar a regra plantada (hora 10 após vela vermelha)');
  assert.ok(hit.testRate > 0.65);
});

test('histórico: pagina quando a Deriv devolve só 1.000 velas por pedido', async () => {
  const { fetchHistory } = require('../server/catalog');
  const sock = { send: async q => { const end = q.end === 'latest' ? 100000 : +q.end; const n = Math.min(1000, Math.floor(end / 60)); return { candles: Array.from({ length: n }, (_, i) => ({ epoch: end - (n - i) * 60, open: 1, high: 1, low: 1, close: 1 })) }; } };
  const h = await fetchHistory(sock, 'R_100', 60, 2, () => {}, 10000);
  assert.ok(h.length >= 1600 && h.length <= 1700, `tudo que existe (${h.length}), parando no fim do histórico`);
  const h2 = await fetchHistory({ send: async q => { const end = q.end === 'latest' ? 1e9 : +q.end; return { candles: Array.from({ length: 1000 }, (_, i) => ({ epoch: end - (1000 - i) * 60, open: 1, high: 1, low: 1, close: 1 })) }; } }, 'R_100', 60, 2, () => {}, 10000);
  assert.strictEqual(h2.length, 10000);
});
