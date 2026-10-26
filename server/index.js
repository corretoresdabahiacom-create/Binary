'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { Engine } = require('./engine');
const { createGuard } = require('./access');

const PORT = Number(process.env.PORT || 3010); // 3000 costuma estar ocupada (ex.: Tailscale)
const HOST = '127.0.0.1'; // nunca exponha: o servidor guarda tokens de negociação
const CONFIG = path.join(__dirname, '..', 'data', 'config.json');

try { for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}

const engine = new Engine();
const guard = process.env.CF_ACCESS_TEAM_DOMAIN && process.env.CF_ACCESS_AUD
  ? createGuard({ teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN, aud: process.env.CF_ACCESS_AUD }) : null;
const app = express();
if (guard) app.use(guard.middleware); // tudo exige login do Cloudflare Access
app.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', 'lightweight-charts', 'dist')));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/api/trades', (req, res) => res.json(engine.trades.slice(-200)));
app.get('/api/signals', (req, res) => res.json({ stats: engine.signalStats(), signals: engine.signals.slice(-200) }));
app.get('/api/probability', (req, res) => res.json({ prob: engine.prob, model: engine.publicState().model, cfg: { minProb: engine.cfg.minProb, minSamples: engine.cfg.minSamples, expiryMin: engine.cfg.expiryMin, tf: engine.tf } }));
app.get('/api/status', (req, res) => res.json(engine.publicState()));
const server = http.createServer(app);

const allowedOrigins = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`,
  ...(process.env.ALLOWED_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean)]); // ex.: https://trade.seudominio.com
const wss = new WebSocketServer({
  server, path: '/ws',
  verifyClient: (info, done) => {
    if (info.origin && !allowedOrigins.has(info.origin)) return done(false, 403, 'origem não permitida'); // bloqueia outros sites
    if (!guard) return done(true);
    guard.check(info.req).then(() => done(true)).catch(() => done(false, 403, 'acesso negado'));
  },
});

const clients = new Set();
const bcast = (type, data) => { const s = JSON.stringify({ type, data }); for (const c of clients) if (c.readyState === 1) c.send(s); };

for (const ev of ['state', 'candles', 'candle', 'signal', 'trade_open', 'trade_update', 'trade_closed', 'log', 'alert', 'catalog_progress', 'catalog', 'notify', 'prob'])
  engine.on(ev, d => bcast(ev, d));
engine.on('trade_closed', () => bcast('diagnostics', engine.diagnostics()));

function saveConfig(c) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(c), { mode: 0o600 });
}
function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return null; } }

async function connectWith(cfg) {
  if (cfg.anthropicKey) process.env.ANTHROPIC_API_KEY = cfg.anthropicKey;
  await engine.connect(cfg.token, cfg.appId);
}

const handlers = {
  async connect(d) {
    if (!d.token || !d.appId) throw new Error('informe o App ID e o token da Deriv');
    await connectWith(d);
    if (d.remember) saveConfig({ token: d.token, appId: d.appId, anthropicKey: d.anthropicKey || process.env.ANTHROPIC_API_KEY || '' });
  },
  async select_account(d) {
    const acc = engine.accounts.find(a => a.account_id === d.id);
    if (acc && acc.account_type === 'real' && !d.confirmReal) throw new Error('confirme que deseja operar com dinheiro REAL');
    await engine.selectAccount(d.id);
  },
  async market(d) { await engine.setMarket(d.symbol, d.tf); },
  async config(d) { engine.setConfig(d); },
  async buy(d) {
    if (engine.account && engine.account.account_type === 'real' && !d.confirmReal) throw new Error('confirme a operação REAL');
    await engine.placeTrade(d.direction, 'manual');
  },
  async sell() { await engine.sellEarly(); },
  async start(d) {
    if (engine.account && engine.account.account_type === 'real' && !d.confirmReal) throw new Error('confirme que o bot operará com dinheiro REAL');
    engine.start(d.mode);
  },
  async stop() { engine.stop(); },
  async catalog_build(d) { await engine.buildCatalog(d && d.pages); },
  async catalog_get() { /* enviado abaixo */ },
  async forget() { try { fs.unlinkSync(CONFIG); } catch {} },
};

wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'state', data: engine.publicState() }));
  if (engine.candles.length) ws.send(JSON.stringify({ type: 'candles', data: { symbol: engine.symbol, tf: engine.tf, candles: engine.candles } }));
  if (engine.signal) ws.send(JSON.stringify({ type: 'signal', data: engine.signal }));
  ws.send(JSON.stringify({ type: 'diagnostics', data: engine.diagnostics() }));
  ws.send(JSON.stringify({ type: 'saved', data: { hasSaved: !!loadConfig(), anthropic: !!process.env.ANTHROPIC_API_KEY } }));
  if (engine.catalog) ws.send(JSON.stringify({ type: 'catalog', data: engine.catalog }));

  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const h = handlers[msg.type];
    if (!h) return;
    try {
      await h(msg.data || {});
      if (msg.type === 'market') { ws.send(JSON.stringify({ type: 'diagnostics', data: engine.diagnostics() })); if (engine.catalog) bcast('catalog', engine.catalog); }
      ws.send(JSON.stringify({ type: 'ack', id: msg.id, ok: true }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'ack', id: msg.id, ok: false, error: e.message }));
      engine.log(e.message, 'error');
    }
  });
  ws.on('close', () => clients.delete(ws));
});

server.listen(PORT, HOST, async () => {
  console.log(`Deriv MVP em http://localhost:${PORT}`);
  try { await engine.startPublic(); console.log('Fonte de dados: Deriv (pública) conectada'); } catch (e) { console.log('Fonte de dados indisponível:', e.message); }
  const saved = loadConfig();
  if (saved && saved.token && saved.appId) {
    try { await connectWith(saved); console.log('Reconectado com credenciais salvas'); }
    catch (e) { console.log('Credenciais salvas falharam:', e.message); }
  }
});

process.on('unhandledRejection', e => console.error('erro não tratado:', e && e.message));
