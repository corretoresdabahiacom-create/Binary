'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { verifyJwt } = require('../server/access');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] };
const ISS = 'https://time.cloudflareaccess.com', AUD = 'aud123';
const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(payload, { key = privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const head = b({ alg, kid, typ: 'JWT' }), body = b(payload);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(head + '.' + body), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const good = (o = {}) => ({ aud: [AUD], iss: ISS, exp: Math.floor(Date.now() / 1000) + 600, email: 'eu@x.com', ...o });
const v = t => verifyJwt(t, { jwks, aud: AUD, issuer: ISS });

test('JWT: aceita válido e recusa adulterações', () => {
  assert.strictEqual(v(sign(good())).email, 'eu@x.com');
  assert.throws(() => v(sign(good(), { key: other.privateKey })), /assinatura/);
  assert.throws(() => v(sign(good({ aud: ['outro'] }))), /audiência/);
  assert.throws(() => v(sign(good({ iss: 'https://evil.com' }))), /emissor/);
  assert.throws(() => v(sign(good({ exp: 1 }))), /expirado/);
  assert.throws(() => v(sign(good(), { kid: 'zzz' })), /chave/);
  assert.throws(() => v('abc.def'), /malformado/);
  const none = b({ alg: 'none', kid: 'k1' }) + '.' + b(good()) + '.';
  assert.throws(() => v(none), /algoritmo/);
});

test('servidor com Access: HTTP e WebSocket exigem login válido', async () => {
  const certs = http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(jwks)); });
  await new Promise(r => certs.listen(0, '127.0.0.1', r));
  const PORT = 3931;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: require('path').join(__dirname, '..'), stdio: 'pipe',
    env: { ...process.env, PORT, CF_ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com', CF_ACCESS_AUD: AUD,
      CF_ACCESS_CERTS_URL: `http://127.0.0.1:${certs.address().port}/`, ALLOWED_ORIGIN: 'https://trade.exemplo.com', ANTHROPIC_API_KEY: '' },
  });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const tryWs = (headers) => new Promise(res => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers });
    w.on('open', () => { w.close(); res('aberto'); });
    w.on('error', () => res('recusado')); w.on('unexpected-response', () => res('recusado'));
  });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/`); break; } catch { await wait(100); } }
    assert.strictEqual((await fetch(`http://127.0.0.1:${PORT}/`)).status, 403, 'sem login: negado');
    assert.strictEqual((await fetch(`http://127.0.0.1:${PORT}/`, { headers: { 'cf-access-jwt-assertion': sign(good({ aud: ['x'] })) } })).status, 403);
    assert.strictEqual((await fetch(`http://127.0.0.1:${PORT}/`, { headers: { 'cf-access-jwt-assertion': sign(good()) } })).status, 200, 'com login: ok');
    assert.strictEqual((await fetch(`http://127.0.0.1:${PORT}/api/trades`)).status, 403);

    assert.strictEqual(await tryWs({ Origin: 'https://trade.exemplo.com' }), 'recusado', 'WS sem login');
    assert.strictEqual(await tryWs({ Origin: 'https://trade.exemplo.com', 'cf-access-jwt-assertion': sign(good()) }), 'aberto', 'WS com login');
    assert.strictEqual(await tryWs({ Origin: 'https://evil.com', 'cf-access-jwt-assertion': sign(good()) }), 'recusado', 'origem errada mesmo com login');
  } finally { child.kill(); certs.close(); }
});
