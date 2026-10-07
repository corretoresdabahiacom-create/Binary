'use strict';
// Servidor web real + Deriv simulado, falando pelo mesmo WebSocket que o navegador usa.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { startMock } = require('./mock');

const wait = ms => new Promise(r => setTimeout(r, ms));

test('servidor web: conectar, receber velas, comprar, origem estranha recusada', async () => {
  const mock = await startMock();
  const PORT = 3917;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, PORT, DERIV_REST_BASE: `http://127.0.0.1:${mock.port}`, DERIV_WS_PUBLIC: `ws://127.0.0.1:${mock.port}/trading/v1/options/ws/public`, ANTHROPIC_API_KEY: '' },
    stdio: 'pipe',
  });
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.ok) break; } catch {} await wait(100); }

    // outro site tentando controlar o robô é recusado
    await new Promise(res => { const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: 'https://site-malicioso.example' } }); bad.on('error', () => res()); bad.on('open', () => { assert.fail('origem estranha foi aceita'); }); bad.on('unexpected-response', (q, r) => { assert.strictEqual(r.statusCode, 401); res(); }); });

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://localhost:${PORT}` } });
    const got = { candles: null, state: null, closed: null }; const acks = new Map(); let id = 1;
    ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'ack') acks.get(m.id)?.(m); if (m.type === 'candles') got.candles = m.data; if (m.type === 'state') got.state = m.data; if (m.type === 'trade_closed') got.closed = m.data; });
    await new Promise(r => ws.on('open', r));
    const call = (type, data) => new Promise(r => { const i = id++; acks.set(i, r); ws.send(JSON.stringify({ type, data, id: i })); });

    const bad = await call('connect', { appId: 'ERRADO', token: 'TOKEN' });
    assert.strictEqual(bad.ok, false);

    const ok = await call('connect', { appId: 'APP1', token: 'TOKEN' });
    assert.strictEqual(ok.ok, true, ok.error);
    await wait(200);
    assert.strictEqual(got.candles.candles.length, 500);
    assert.strictEqual(got.state.account.type, 'demo');
    assert.strictEqual(got.state.accounts.length, 2);

    const buy = await call('buy', { direction: 'CALL' });
    assert.strictEqual(buy.ok, true, buy.error);
    await wait(300);
    assert.ok(got.closed && got.closed.win, 'resultado chegou ao navegador');

    // conta real exige confirmação explícita
    const noConfirm = await call('select_account', { id: 'REAL1' });
    assert.strictEqual(noConfirm.ok, false);
    assert.match(noConfirm.error, /REAL/);
    const yes = await call('select_account', { id: 'REAL1', confirmReal: true });
    assert.strictEqual(yes.ok, true, yes.error);
    const buyReal = await call('buy', { direction: 'CALL' });
    assert.strictEqual(buyReal.ok, false, 'compra real sem confirmação deve falhar');

    // robô sem chave da Claude é recusado
    const bot = await call('start', { mode: 'auto', confirmReal: true });
    assert.strictEqual(bot.ok, false);
    assert.match(bot.error, /Claude/);
    ws.close();
  } finally { child.kill(); mock.server.close(); }
});
