'use strict';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'tac-test-')); // testes nunca tocam data/ real
// Lógica do scanner sem rede (velas sintéticas). Não valida a integração real com a Deriv.
const test = require('node:test');
const assert = require('node:assert');
require('../server/research').clock.now = () => Date.UTC(2026, 9, 26, 13) / 1000; // horário com forex aberto na Deriv
const { Scanner } = require('../server/scanner');
const prob = require('../server/probability');

const cfg = { minProb: 0.56, minSamples: 40, maxDataAgeSec: 20, windowPct: 0.1, analise: 0 }; // bloqueios testados em analysis.test.js
function trend(n, g, t0) { let p = 100; return Array.from({ length: n }, (_, i) => { const o = p; p += (i % 7 === 3 ? -0.4 : 1); return { epoch: t0 + i * g, open: o, high: Math.max(o, p) + .1, low: Math.min(o, p) - .1, close: p }; }); }
function ready(sc, sym, tf, g) {
  const st = sc.streams.get(`${sym}|${tf}`);
  const t0 = Math.floor(Date.now() / 1000 / g) * g - 599 * g;     // última vela = vela atual
  const all = trend(600, g, t0);
  st.candles = all.slice(-300); st.hist = all.slice(0, -1);
  for (const exp of [15, 60]) { const h = exp * 60 / g; if (Number.isInteger(h) && h >= 1) st.models[exp] = prob.buildModel(st.hist, h); }
  st.loaded = true; st.lastTick = Date.now();
  sc.serverOffset = (st.candles.at(-1).epoch + g * 0.6) - Date.now() / 1000; // 60% da vela decorrida
  return st;
}

test('scanner: preliminar → confirmado → resultado, em todas as expirações válidas', () => {
  const recs = new Map(), opps = [];
  const sc = new Scanner({ getCfg: () => cfg, symbols: ['frxGBPUSD'], tfs: ['15m'], record: s => recs.set(s.uid, { ...s }) });
  sc.on('opportunity', o => opps.push(o));
  const st = ready(sc, 'frxGBPUSD', '15m', 900);
  sc._live(st);
  const pre = opps.filter(o => o.stage === 'preliminar');
  assert.deepStrictEqual(pre.map(o => o.expiryMin).sort((a, b) => a - b), [15, 60], 'gráfico de 15 min: expirações 15 e 60');
  assert.ok(pre.every(o => o.direction === 'CALL' && o.p >= 0.56 && o.lo > 0.5 && o.name === 'GBP/USD'));
  st._at = 0; sc._live(st);
  assert.strictEqual(opps.filter(o => o.stage === 'preliminar').length, 2, 'não repete na mesma vela');
  const last = st.candles.at(-1);
  sc._onOhlc({ symbol: 'frxGBPUSD', granularity: 900, open_time: last.epoch + 900, open: last.close, high: last.close, low: last.close, close: last.close });
  const conf = opps.filter(o => o.stage === 'confirmado');
  assert.strictEqual(conf.length, 2);
  assert.ok(conf[0].entryUntil - conf[0].candleOpen === 90, 'janela de entrada = 10% da vela');
  assert.strictEqual(recs.size, 2, 'sinais registrados para o relatório');
  const c2 = st.candles.at(-1);                       // 15 min = 1 vela de 15 min
  sc._onOhlc({ symbol: 'frxGBPUSD', granularity: 900, open_time: c2.epoch, open: c2.open, high: c2.open + 2, low: c2.open, close: c2.open + 2 });
  sc._onOhlc({ symbol: 'frxGBPUSD', granularity: 900, open_time: c2.epoch + 900, open: c2.open + 2, high: c2.open + 2, low: c2.open + 2, close: c2.open + 2 });
  assert.strictEqual([...recs.values()].find(r => r.expiryMin === 15).outcome, 'favorável');
  assert.strictEqual([...recs.values()].find(r => r.expiryMin === 60).outcome, undefined, '60 min ainda aberto');
});

test('scanner: dados atrasados ou mercado aberto no painel não geram aviso', () => {
  const opps = [];
  let active = false;
  const sc = new Scanner({ getCfg: () => cfg, symbols: ['frxEURUSD'], tfs: ['15m'], isActive: () => active });
  sc.on('opportunity', o => opps.push(o));
  const st = ready(sc, 'frxEURUSD', '15m', 900);
  assert.deepStrictEqual(Object.keys(st.models), ['15', '60'], 'gráfico de 15 min: expirações 15 e 60');
  st.lastTick = Date.now() - 60000; sc._live(st);
  assert.strictEqual(opps.length, 0, 'forex parado (fim de semana) → nada');
  assert.match(sc.view()[0].reason, /atrasados/);
  st.lastTick = Date.now(); st._at = 0; active = true; sc._live(st);
  assert.strictEqual(opps.length, 0, 'combinação já aberta no painel → o painel avisa');
  st._at = 0; active = false; sc._live(st);
  assert.strictEqual(opps.length, 2, 'uma por expiração (15 e 60 min)');
  assert.strictEqual(opps[0].name, 'EUR/USD');
});

test('modelo incremental = modelo reconstruído (mesmas contagens)', () => {
  const c = trend(800, 300, 0);
  const inc = prob.buildModel(c.slice(0, 600), 1);
  for (let k = 600; k < 800; k++) prob.addSample(inc, c.slice(0, k + 1), k - 1);
  const full = prob.buildModel(c, 1);
  assert.ok(Math.abs(inc.samples - full.samples) <= 1);
  const a = inc.table.get('base'), b = full.table.get('base');
  assert.ok(Math.abs(a.up / a.n - b.up / b.n) < 0.01);
});

test('scanner: combinação não aprovada gera registro "sombra" (teste ao vivo) sem aviso', () => {
  const R = require('../server/research');
  R.saveResearch({ combos: { 'frxGBPUSD|15m|15': { approved: false, iso: null, meta: null, payout: 0.95 } } });
  try {
    const recs = new Map(), opps = [];
    const sc = new Scanner({ getCfg: () => cfg, symbols: ['frxGBPUSD'], tfs: ['15m'], record: s => recs.set(s.uid, { ...s }) });
    sc.on('opportunity', o => opps.push(o));
    const st = ready(sc, 'frxGBPUSD', '15m', 900);
    const last = st.candles.at(-1);
    sc._onOhlc({ symbol: 'frxGBPUSD', granularity: 900, open_time: last.epoch + 900, open: last.close, high: last.close, low: last.close, close: last.close });
    const sh = [...recs.values()].filter(r => r.status === 'sombra');
    assert.strictEqual(sh.length, 2, '15 e 60 min, ambas não aprovadas'); assert.strictEqual(opps.filter(o => o.stage === 'confirmado').length, 0, 'não avisa');
    for (let k = 0; k < 1; k++) { const c2 = st.candles.at(-1); sc._onOhlc({ symbol: 'frxGBPUSD', granularity: 900, open_time: c2.epoch + 900, open: c2.close + 1, high: c2.close + 1, low: c2.close + 1, close: c2.close + 1 }); }
    const r = [...recs.values()].find(x => x.status === 'sombra' && x.expiryMin === 15);
    assert.ok(r.outcome, 'resultado avaliado'); assert.strictEqual(r.status, 'sombra', 'continua marcado como sombra');
  } finally { require('fs').unlinkSync(R.RESEARCH_FILE()); }
});

test('gravador de ticks: um arquivo por ativo e dia, sem perder ticks', () => {
  const fs = require('fs'), path = require('path');
  const sc = new Scanner({ getCfg: () => cfg, symbols: ['frxEURUSD'], tfs: ['15m'] });
  const day = Date.UTC(2026, 9, 27) / 1000;
  sc._recordTick({ symbol: 'frxEURUSD', epoch: day + 10, quote: 1.16123 });
  sc._recordTick({ symbol: 'frxEURUSD', epoch: day + 11, quote: 1.16125 });
  sc._recordTick({ symbol: 'frxGBPUSD', epoch: day + 86400 + 5, quote: 1.3 });
  clearTimeout(sc._tickFlush); sc.flushTicks();
  const dir = path.join(process.env.DATA_DIR, 'ticks');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'frxEURUSD-20261027.csv'), 'utf8'), `${day + 10},1.16123\n${day + 11},1.16125\n`);
  assert.ok(fs.existsSync(path.join(dir, 'frxGBPUSD-20261028.csv')));
});
