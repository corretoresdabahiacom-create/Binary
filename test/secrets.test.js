'use strict';
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { saveSecure, loadSecure } = require('../server/secrets');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-')), f = path.join(dir, 'config.json');
// "DPAPI" simulado (base64 invertido) só para testar o fluxo; a criptografia real do Windows NÃO é exercitada aqui.
const fake = (script, input) => (/Unprotect|FromBase64String/.test(script) ? Buffer.from(input.trim().split('').reverse().join(''), 'base64').toString() : Buffer.from(input).toString('base64').split('').reverse().join(''));

test('Windows: não grava o token em texto simples', () => {
  saveSecure(f, { token: 'SEGREDO123', appId: '1' }, { platform: 'win32', run: fake });
  assert.ok(!fs.readFileSync(f, 'utf8').includes('SEGREDO123'));
  assert.deepStrictEqual(loadSecure(f, { platform: 'win32', run: fake }), { token: 'SEGREDO123', appId: '1' });
});
test('Windows: se a proteção falhar, nada é gravado', () => {
  const g = path.join(dir, 'x.json');
  assert.throws(() => saveSecure(g, { token: 't' }, { platform: 'win32', run: () => { throw new Error('sem powershell'); } }), /nada foi salvo/);
  assert.ok(!fs.existsSync(g));
});
test('arquivo antigo em texto simples continua legível', () => {
  fs.writeFileSync(f, JSON.stringify({ token: 'velho', appId: '2' }));
  assert.strictEqual(loadSecure(f, { platform: 'win32', run: fake }).token, 'velho');
});
test('Unix: permissão 0600, inclusive em arquivo preexistente', { skip: process.platform === 'win32' }, () => {
  const g = path.join(dir, 'u.json'); fs.writeFileSync(g, '{}', { mode: 0o644 });
  saveSecure(g, { token: 't' }, { platform: 'linux' });
  assert.strictEqual(fs.statSync(g).mode & 0o777, 0o600);
});
