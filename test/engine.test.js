'use strict';
// Servidor Deriv SIMULADO apenas para testar o protocolo do cliente. O produto real nunca usa isto.
const test = require('node:test');
const assert = require('node:assert');

const { startMock } = require('./mock');

test('motor: demo → compra real via proposal+buy, resultado, risco e diagnóstico', async () => {
  const mock = await startMock();
  process.env.DERIV_REST_BASE = `http://127.0.0.1:${mock.port}`;
  process.env.DERIV_WS_PUBLIC = `ws://127.0.0.1:${mock.port}/trading/v1/options/ws/public`;
  delete process.env.ANTHROPIC_API_KEY;
  const { Engine } = require('../server/engine');
  const e = new Engine();
  e.trades = [];
  e._saveTrades = () => {}; // não tocar no arquivo real de histórico
  await e.connect('TOKEN', 'APP1');

  assert.strictEqual(e.account.account_type, 'demo', 'deve iniciar na conta demo');
  assert.ok(mock.state.wsUrls.some(u => u.includes('/ws/demo?otp=')), 'conecta no WS demo com OTP');
  assert.ok(mock.state.wsUrls.some(u => u.includes('/ws/public')), 'usa WS público para velas');
  assert.strictEqual(e.candles.length, 500);

  e.setConfig({ stake: 1, maxLoss: 2, maxConsecLosses: 2, maxTrades: 10 });
  await e.placeTrade('CALL', 'manual');
  assert.strictEqual(mock.state.buys.length, 1);
  assert.strictEqual(e.open.direction, 'CALL');
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(e.open, null, 'operação fechou');
  assert.strictEqual(e.session.wins, 1);
  assert.ok(Math.abs(e.session.pnl - 0.95) < 1e-9);
  assert.ok(e.trades[0].lat.totalMs >= 0, 'latência registrada');
  assert.ok(e.trades[0].slip != null, 'slippage registrado');

  // duas perdas seguidas → bloqueio de risco
  mock.state.outcome = 'lost';
  for (let i = 0; i < 2; i++) { await e.placeTrade('PUT', 'manual'); await new Promise(r => setTimeout(r, 200)); }
  assert.strictEqual(e.session.consec, 2);
  assert.ok(e.riskBlock(), 'limite atingido');
  await assert.rejects(() => e.placeTrade('CALL', 'manual'), /perdas|limite/);

  const d = e.diagnostics();
  assert.strictEqual(d.n, 3);
  assert.ok(Math.abs(d.winRate - 1 / 3) < 1e-9);

  // não permite duas operações simultâneas
  e.session = e._newSession();
  mock.state.outcome = 'won';
  await e.placeTrade('CALL', 'manual');
  await assert.rejects(() => e.placeTrade('PUT', 'manual'), /andamento/);
  await e.sellEarly();
  assert.strictEqual(mock.state.sells[0].price, 0);
  await new Promise(r => setTimeout(r, 200));

  // troca para a conta real
  await e.selectAccount('REAL1');
  assert.strictEqual(e.account.account_type, 'real');
  assert.ok(mock.state.wsUrls.some(u => u.includes('/ws/real?otp=')), 'WS real com OTP novo');

  // vela fecha → motor não quebra e mantém estado
  e._onPublic({ ohlc: { open_time: e.candles.at(-1).epoch + 900, open: 1, high: 2, low: 0.5, close: 1.5, granularity: 900, symbol: 'R_100' } });
  assert.strictEqual(e.candles.length, 501);

  e.pub.close(); e.trade.close(); mock.server.close();
});

test('bot exige chave da Claude e catálogo validado', () => {
  delete process.env.ANTHROPIC_API_KEY;
  const { Engine } = require('../server/engine');
  const e = new Engine();
  e.account = { account_type: 'demo' };
  assert.throws(() => e.start('auto'), /Claude/);
  process.env.ANTHROPIC_API_KEY = 'x';
  assert.throws(() => e.start('catalog'), /catálogo/);
  delete process.env.ANTHROPIC_API_KEY;
});
