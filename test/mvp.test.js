'use strict';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'tac-test-')); // testes nunca tocam data/ real
// Regras do MVP "só análise". Usa o servidor Deriv SIMULADO (test/mock.js) — não valida a integração real.
delete process.env.TRADING_ENABLED;
const test = require('node:test');
const assert = require('node:assert');
const { startMock } = require('./mock');

let shared = null; // a URL da Deriv é lida uma vez por processo: um único servidor simulado
async function engineWithMock() {
  if (!shared) { shared = await startMock(); process.env.DERIV_WS_PUBLIC = `ws://127.0.0.1:${shared.port}/trading/v1/options/ws/public`; }
  const mock = shared;
  delete process.env.ANTHROPIC_API_KEY;
  const { Engine } = require('../server/engine');
  const e = new Engine();
  e.signals = []; e._saveSignals = () => {}; e._saveTrades = () => {};
  return { e, mock };
}
const done = e => { clearInterval(e._watch); e.pub && e.pub.close(); };
test.after(() => shared && shared.server.close());
const mkSig = (e, over = {}) => {
  const last = e.candles[e.candles.length - 1];
  const s = { uid: 'u' + Math.random(), status: 'valido', symbol: e.symbol, tf: e.tf, expiryMin: 5, direction: 'CALL', price: last.open, candleOpen: last.epoch, expiresAt: e.now() + 30, ...over };
  e.signal = s; e._record(s); return s;
};

test('dados públicos sem token: gráfico 5 min carrega e fonte fica OK', async () => {
  const { e, mock } = await engineWithMock();
  try {
    await e.startPublic();
    assert.strictEqual(e.tf, '5m');
    assert.strictEqual(e.candles.length, 500);
    assert.strictEqual(e.candles[1].epoch - e.candles[0].epoch, 300, 'velas de 5 min');
    e.checkFreshness();
    assert.strictEqual(e.dataState, 'ok');
    assert.strictEqual(e.account, null, 'nenhuma conta necessária');
  } finally { done(e, mock); }
});

test('só análise: ordens e robô bloqueados por padrão', async () => {
  const { Engine } = require('../server/engine');
  const e = new Engine();
  await assert.rejects(() => e.placeTrade('CALL'), /só análise/);
  assert.throws(() => e.start('auto'), /só análise/);
});

test('timeframe e expiração são independentes e validados', async () => {
  const { e, mock } = await engineWithMock();
  try {
    await e.startPublic();
    e.setConfig({ expiryMin: 15 });
    assert.strictEqual(e.cfg.expiryMin, 15); assert.strictEqual(e.tf, '5m');
    assert.throws(() => e.setConfig({ expiryMin: 7 }), /expiração inválida/);
    await assert.rejects(() => e.setMarket(null, '2m'), /timeframe inválido/);
    await e.setMarket(null, '15m');
    assert.strictEqual(e.candles[1].epoch - e.candles[0].epoch, 900);
  } finally { done(e, mock); }
});

test('dado atrasado: sinal válido é invalidado e novos sinais são suspensos', async () => {
  const { e, mock } = await engineWithMock();
  const notes = []; e.on('notify', n => notes.push(n));
  try {
    await e.startPublic();
    const s = mkSig(e);
    e.lastTickAt = Date.now() - 60000;
    e.checkFreshness();
    assert.strictEqual(e.dataState, 'desatualizado');
    assert.strictEqual(s.status, 'invalidado');
    assert.match(s.invalidReason, /desatualizado/);
    assert.ok(notes.some(n => n.kind === 'invalidado'));
    e.signal = null;
    await e._onCandleClosed(e.candles.length - 2, e.candles[e.candles.length - 1]);
    assert.strictEqual(e.signal, null, 'nenhum sinal com dado atrasado (AGUARDAR)');
    e.lastTickAt = Date.now(); e.checkFreshness();
    assert.strictEqual(e.dataState, 'ok', 'retoma quando o dado volta');
  } finally { done(e, mock); }
});

test('sinal expira quando passa a janela de entrada', async () => {
  const { e, mock } = await engineWithMock();
  try {
    await e.startPublic();
    const s = mkSig(e, { expiresAt: e.now() - 1 });
    e.checkFreshness();
    assert.strictEqual(s.status, 'expirado');
  } finally { done(e, mock); }
});

test('resultado só é avaliado após a vela de expiração fechar (sem dados futuros)', async () => {
  const { e, mock } = await engineWithMock();
  try {
    await e.startPublic();
    const g = 300, last = e.candles[e.candles.length - 1];
    const s = mkSig(e, { candleOpen: last.epoch, price: last.open, expiryMin: 5 });
    e._evaluateSignals();
    assert.strictEqual(e.signals[0].outcome, undefined, 'vela de expiração ainda aberta');
    e.candles.push({ epoch: last.epoch + g, open: 1, high: 1, low: 1, close: 1 });
    e._evaluateSignals();
    const r = e.signals.find(x => x.uid === s.uid);
    assert.strictEqual(r.exitPrice, last.close, 'usa o fechamento da vela que termina na expiração');
    assert.ok(['favorável', 'desfavorável', 'empate'].includes(r.outcome));
    assert.strictEqual(e.signalStats().avaliados, 1);
  } finally { done(e, mock); }
});

test('expiração não múltipla do timeframe é marcada como não avaliável', async () => {
  const { e, mock } = await engineWithMock();
  try {
    await e.startPublic();
    await e.setMarket(null, '15m');
    mkSig(e, { tf: '15m', expiryMin: 5 });
    e._evaluateSignals();
    assert.match(e.signals[0].outcome, /não avaliável/);
  } finally { done(e, mock); }
});

test('fonte fora do ar na inicialização: fica DESCONECTADO e agenda nova tentativa', async () => {
  const { Engine } = require('../server/engine');
  const e = new Engine();
  e._ensurePublic = async () => { e.pub = { removeAllListeners() {}, close() {} }; throw new Error('ENOTFOUND'); };
  await assert.rejects(() => e.startPublic(), /ENOTFOUND/);
  assert.strictEqual(e.pub, null);
  assert.ok(e._retry, 'nova tentativa agendada');
  e.checkFreshness();
  assert.strictEqual(e.dataState, 'desconectado');
  clearTimeout(e._retry); clearInterval(e._watch);
});

test('probabilidade: expiração não múltipla do gráfico → modelo indisponível (AGUARDAR)', async () => {
  const { e } = await engineWithMock();
  try {
    await e.startPublic();
    await e.setMarket(null, '15m');
    e.setConfig({ expiryMin: 5 });
    assert.strictEqual(e.model, null);
    assert.match(e.prob.reason, /não é múltipla/);
    e.setConfig({ expiryMin: 15 });
    assert.ok(e.model && e.model.horizon === 1);
  } finally { done(e); }
});

test('probabilidade: tendência forte gera CALL confirmado só no fechamento, com IC e contexto', async () => {
  const { e } = await engineWithMock();
  const notes = []; e.on('notify', n => notes.push(n));
  try {
    await e.startPublic();
    e._histKey = 'x';                               // ignora o download em segundo plano do mock
    let p = 100; const t0 = e.candles[0].epoch;
    e.candles = Array.from({ length: 500 }, (_, i) => { const o = p; p += (i % 7 === 3 ? -0.4 : 1); return { epoch: t0 + i * 300, open: o, high: Math.max(o, p) + .1, low: Math.min(o, p) - .1, close: p }; });
    e.hist = e.candles.slice(0, -1);
    e.rebuildModel();
    assert.ok(e.model.samples > 400);
    e.lastTickAt = Date.now(); e.checkFreshness();
    const last = e.candles.at(-1);
    e.candles.push({ epoch: last.epoch + 300, open: last.close, high: last.close, low: last.close, close: last.close });
    await e._onCandleClosed(e.candles.length - 2, e.candles.at(-1));
    assert.ok(e.signal, 'sinal emitido');
    assert.strictEqual(e.signal.direction, 'CALL');
    assert.strictEqual(e.signal.stage, 'confirmado');
    assert.ok(e.signal.confidence > 0.56 && e.signal.lo > 0.5);
    assert.ok(e.signal.n >= 40 && e.signal.strategy === 'prob-estado-v1');
    assert.ok(Math.abs(e.signal.pCall + e.signal.pPut - 1) < 1e-9);
    assert.ok(notes.some(n => n.kind === 'sinal' && /ENTRE AGORA CALL/.test(n.text)));
  } finally { done(e); }
});

test('probabilidade ao vivo: dado atrasado mantém AGUARDAR mesmo com probabilidade alta', async () => {
  const { e } = await engineWithMock();
  try {
    await e.startPublic();
    e._histKey = 'x';
    let p = 100; const t0 = e.candles[0].epoch;
    e.candles = Array.from({ length: 500 }, (_, i) => { const o = p; p += (i % 7 === 3 ? -0.4 : 1); return { epoch: t0 + i * 300, open: o, high: Math.max(o, p) + .1, low: Math.min(o, p) - .1, close: p }; });
    e.hist = e.candles.slice(0, -1); e.rebuildModel();
    e.lastTickAt = Date.now() - 60000; e.checkFreshness();
    e._liveProb(true);
    assert.strictEqual(e.prob.stage, 'AGUARDAR');
    assert.match(e.prob.reason, /desatualizado/);
    e.lastTickAt = Date.now(); e.checkFreshness(); e._liveProb(true);
    assert.strictEqual(e.prob.stage, 'preliminar');
  } finally { done(e); }
});

test('acompanhamento: MANTER a favor; ABANDONAR quando vira contra e o modelo inverte; fim na expiração', async () => {
  const { e } = await engineWithMock();
  const notes = []; e.on('notify', n => notes.push(n));
  try {
    await e.startPublic(); e._histKey = 'x';
    let p = 100; const t0 = e.candles[0].epoch;
    e.candles = Array.from({ length: 500 }, (_, i) => { const o = p; p += (i % 7 === 3 ? -0.4 : 1); return { epoch: t0 + i * 300, open: o, high: Math.max(o, p) + .1, low: Math.min(o, p) - .1, close: p }; });
    e.hist = e.candles.slice(0, -1); e.rebuildModel();
    e.markEntry('PUT');                                    // contra a tendência forte do modelo
    const ps = e.position; assert.strictEqual(ps.status, 'MANTER');
    const last = e.candles.at(-1);
    e.candles[e.candles.length - 1] = { ...last, close: last.close + 5, high: last.close + 5 }; // preço sobe: contra o PUT
    e._watchPosition(true);
    assert.strictEqual(e.position.status, 'ABANDONAR');
    assert.ok(notes.some(n => n.kind === 'abandonar'));
    e.position.expiresAt = e.now() - 1; e._watchPosition(true);
    assert.strictEqual(e.position, null);
    assert.ok(notes.some(n => n.kind === 'fim' && /desfavorável/.test(n.text)));
  } finally { done(e); }
});
