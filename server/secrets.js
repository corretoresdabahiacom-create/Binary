'use strict';
// Guarda o arquivo de configuração (token da Deriv, chave da Claude) protegido.
// Windows: criptografia DPAPI do usuário atual (só este usuário, neste PC, consegue ler) via PowerShell.
//          Se a proteção falhar, NÃO grava em texto simples (devolve erro).
// Outros sistemas: texto com permissão 0600 (único mecanismo disponível sem dependências).
// Arquivos antigos em texto simples continuam legíveis e são convertidos na próxima gravação.
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');

const PS_PROTECT = "Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
const PS_UNPROTECT = "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
const ps = (script, input) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input, encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();

function saveSecure(file, obj, { platform = process.platform, run = ps } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (platform === 'win32') {
    let data;
    try { data = run(PS_PROTECT, JSON.stringify(obj)); } catch (e) { throw new Error('não foi possível proteger o token neste Windows; nada foi salvo (' + String(e.message).split('\n')[0].slice(0, 80) + ')'); }
    if (!data) throw new Error('proteção do token retornou vazio; nada foi salvo');
    fs.writeFileSync(file, JSON.stringify({ enc: 'dpapi', data }));
  } else {
    fs.writeFileSync(file, JSON.stringify(obj), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}                         // corrige arquivo preexistente com permissão aberta
  }
}
function loadSecure(file, { platform = process.platform, run = ps } = {}) {
  let raw; try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (raw && raw.enc === 'dpapi') {
    if (platform !== 'win32') return null;                               // criptografado em outro sistema: não dá para ler aqui
    try { return JSON.parse(run(PS_UNPROTECT, raw.data)); } catch { return null; }
  }
  return raw;                                                            // formato antigo (texto simples)
}
module.exports = { saveSecure, loadSecure };
