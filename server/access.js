'use strict';
// Proteção opcional para publicar atrás do Cloudflare Access.
// Com CF_ACCESS_TEAM_DOMAIN e CF_ACCESS_AUD definidos, TODA requisição (HTTP e WebSocket) precisa
// trazer um JWT válido do Cloudflare Access (assinatura RS256, audiência, emissor e validade).
// Sem essas variáveis, o servidor continua restrito a localhost como antes.
const crypto = require('crypto');

const b64 = s => Buffer.from(s, 'base64url');

function verifyJwt(token, { jwks, aud, issuer, nowSec = Math.floor(Date.now() / 1000) }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('JWT malformado');
  const header = JSON.parse(b64(parts[0]).toString());
  const payload = JSON.parse(b64(parts[1]).toString());
  if (header.alg !== 'RS256') throw new Error('algoritmo não permitido');
  const jwk = (jwks.keys || []).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('chave desconhecida');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }), b64(parts[2]));
  if (!ok) throw new Error('assinatura inválida');
  const audOk = Array.isArray(payload.aud) ? payload.aud.includes(aud) : payload.aud === aud;
  if (!audOk) throw new Error('audiência inválida');
  if (payload.iss !== issuer) throw new Error('emissor inválido');
  if (!payload.exp || payload.exp < nowSec) throw new Error('token expirado');
  return payload;
}

function createGuard({ teamDomain, aud, fetchJwks }) {
  const issuer = `https://${teamDomain}`;
  let cache = null, cacheAt = 0;
  const getJwks = async () => {
    if (!cache || Date.now() - cacheAt > 10 * 60 * 1000) {
      cache = await (fetchJwks ? fetchJwks() : fetch(process.env.CF_ACCESS_CERTS_URL || `${issuer}/cdn-cgi/access/certs`).then(r => r.json()));
      cacheAt = Date.now();
    }
    return cache;
  };
  const tokenOf = req => req.headers['cf-access-jwt-assertion'];
  async function check(req) {
    const t = tokenOf(req);
    if (!t) throw new Error('sem credencial do Cloudflare Access');
    return verifyJwt(t, { jwks: await getJwks(), aud, issuer });
  }
  return {
    check,
    middleware: (req, res, next) => check(req).then(() => next()).catch(() => res.status(403).send('Acesso negado')),
  };
}

module.exports = { verifyJwt, createGuard };
