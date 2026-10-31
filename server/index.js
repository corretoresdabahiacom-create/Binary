'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const secrets = require('./secrets');
const { WebSocketServer } = require('ws');
const { Engine } = require('./engine');
const { createGuard } = require('./access');
const { Scanner, NAMES } = require('./scanner');
const research = require('./research');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3010); // 3000 costuma estar ocupada (ex.: Tailscale)
const HOST = '127.0.0.1'; // nunca exponha: o servidor guarda tokens de negociação
const CONFIG = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'config.json');

try { for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}

const engine = new Engine();
// Atraso do loop de eventos (p99 em janelas de 10 s): se subir, algo está segurando o recebimento de ticks.
const lag = require('perf_hooks').monitorEventLoopDelay({ resolution: 10 }); lag.enable();
setInterval(() => { engine.perf.loopLagP99Ms = +(lag.percentile(99) / 1e6).toFixed(1); lag.reset(); engine.perf.tickMsMaxPrev = engine.perf.tickMsMax; engine.perf.tickMsMax = 0; }, 10000).unref();
const scanner = process.env.SCANNER === '0' ? null : new Scanner({
  getCfg: () => engine.cfg,
  isActive: (sym, tf, exp) => engine.symbol === sym && engine.tf === tf && engine.cfg.expiryMin === exp,
  record: sig => engine._record(sig),
});
const guard = process.env.CF_ACCESS_TEAM_DOMAIN && process.env.CF_ACCESS_AUD
  ? createGuard({ teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN, aud: process.env.CF_ACCESS_AUD }) : null;
const app = express();
if (guard) app.use(guard.middleware); // tudo exige login do Cloudflare Access
app.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', 'lightweight-charts', 'dist')));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/api/trades', (req, res) => res.json(engine.trades.slice(-200)));
app.get('/api/signals', (req, res) => res.json({ stats: engine.signalStats(), signals: engine.signals.slice(-200) }));
app.get('/api/probability', (req, res) => res.json({ prob: engine.prob, model: engine.publicState().model, cfg: { minProb: engine.cfg.minProb, minSamples: engine.cfg.minSamples, expiryMin: engine.cfg.expiryMin, tf: engine.tf } }));
app.get('/api/research', (req, res) => {
  const r = research.loadResearch();
  if (!r) return res.json(null);
  res.json({ generatedAt: r.generatedAt, method: r.method, aggregate: r.aggregate, running: !!researchJob,
    combos: Object.fromEntries(Object.entries(r.combos).map(([k, c]) => [k, { approved: c.approved, payout: c.payout, payoutSource: c.payoutSource, v1: c.v1, v2: c.v2, calibration: c.calibration, v1PorSessao: c.v1PorSessao, metaPesos: c.meta && Object.fromEntries(research.FEATURE_NAMES.map((n, j) => [n, +c.meta.w[j].toFixed(3)])) }])) });
});
// Melhor par: limite inferior (Wilson 95%) do acerto fora da amostra − empate do payout real. Conservador de propósito.
const { wilson } = require('./probability');
function bestPairs() {
  const r = research.loadResearch(), out = { historico: [], agora: [], aprovadas: [], geradoEm: r && r.generatedAt };
  if (r) for (const [k, c] of Object.entries(r.combos)) {
    const [sym, tf, exp] = k.split('|'); if (!/^frx/.test(sym) || !['15m', '1h'].includes(tf)) continue;
    const v = c.v3 && c.v3.n >= 20 ? c.v3 : c.v2; if (!v || !v.n) continue;
    const be = 1 / (1 + (c.payout || 0.95)), lo = wilson(v.wins, v.n)[0];
    const sh = engine.signals.filter(x => x.status === 'sombra' && x.symbol === sym && x.tf === tf && x.expiryMin === +exp && ['favorável', 'desfavorável'].includes(x.outcome));
    out.historico.push({ symbol: sym, name: NAMES[sym] || sym, tf, expiryMin: +exp, n: v.n, acerto: v.wins / v.n, limiteInferior: lo, empate: be, folga: lo - be, aprovada: !!c.approved,
      aoVivo: { n: sh.length, acerto: sh.length ? sh.filter(x => x.outcome === 'favorável').length / sh.length : null } });
    if (c.approved) out.aprovadas.push(k);
  }
  out.historico.sort((a, b) => b.folga - a.folga); out.historico = out.historico.slice(0, 5);
  if (scanner) out.agora = scanner.view().filter(x => x.fresh && x.p != null).sort((a, b) => b.p - a.p).slice(0, 3)
    .map(x => ({ symbol: x.symbol, name: x.name, tf: x.tf, expiryMin: x.expiryMin, direction: x.direction, p: x.p, ok: x.ok, approved: x.approved, reason: x.reason }));
  return out;
}
app.get('/api/best', (req, res) => res.json(bestPairs()));
app.get('/api/scan', (req, res) => res.json(scanner ? scanner.view() : []));
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

for (const ev of ['state', 'candles', 'candle', 'signal', 'trade_open', 'trade_update', 'trade_closed', 'log', 'alert', 'catalog_progress', 'catalog', 'notify', 'prob', 'positions', 'flow'])
  engine.on(ev, d => bcast(ev, d));
engine.on('trade_closed', () => bcast('diagnostics', engine.diagnostics()));
if (scanner) {
  scanner.on('opportunity', o => bcast('opportunity', o));
  scanner.on('log', m => engine.log(m, 'warn'));
  scanner.on('catalog', c => engine.log(`Catálogo ${NAMES[c.sym] || c.sym} ${c.tf}: regras validadas ${JSON.stringify(c.validated)}`));
  engine.catalogCheck = (...a) => scanner.agreement(...a);
  engine.priceOf = sym => { const st = scanner.streams.get(`${sym}|15m`); const c = st && st.candles.at(-1); return c ? c.close : null; };
  setInterval(() => { if (clients.size) bcast('scan', scanner.view()); }, 2000).unref();
}

function saveConfig(c) { secrets.saveSecure(CONFIG, c); }       // Windows: criptografado (DPAPI); falha = nada é gravado
function loadConfig() { return secrets.loadSecure(CONFIG); }

async function connectWith(cfg) {
  if (cfg.anthropicKey) process.env.ANTHROPIC_API_KEY = cfg.anthropicKey;
  await engine.connect(cfg.token, cfg.appId);
}

let researchJob = null;
const handlers = {
  // Backtest v2 em processo separado: o monitor continua rodando enquanto calcula.
  async research_run() {
    if (researchJob) throw new Error('backtest v2 já está rodando');
    researchJob = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'backtest2.js')], { env: process.env });
    engine.log('Backtest v2 iniciado (alguns minutos; o monitor continua ativo)', 'ok');
    researchJob.stdout.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => engine.log('v2: ' + l)));
    researchJob.stderr.on('data', d => engine.log('v2: ' + String(d).trim(), 'error'));
    researchJob.on('close', code => { researchJob = null; engine.log(code === 0 ? 'Backtest v2 concluído — artefatos aplicados' : 'Backtest v2 falhou', code === 0 ? 'ok' : 'error'); bcast('research', null); engine.push(); });
  },
  async connect(d) {
    if (!d.token || !d.appId) throw new Error('informe o App ID e o token da Deriv');
    await connectWith(d);
    if (d.remember) { try { saveConfig({ token: d.token, appId: d.appId, anthropicKey: d.anthropicKey || process.env.ANTHROPIC_API_KEY || '' }); } catch (e) { engine.log('Conectado, mas a configuração NÃO foi salva: ' + e.message, 'warn'); } }
  },
  async select_account(d) {
    const acc = engine.accounts.find(a => a.account_id === d.id);
    if (acc && acc.account_type === 'real' && !d.confirmReal) throw new Error('confirme que deseja operar com dinheiro REAL');
    await engine.selectAccount(d.id);
  },
  async entered(d) { engine.markEntry(d.direction); },
  async position_clear(d) { engine.clearPosition(d && d.id); },
  async market(d) { await engine.setMarket(d.symbol, d.tf); },
  // Vai para a oportunidade indicada pelo scanner: ativo + gráfico + expiração.
  async goto(d) {
    if (!d.symbol || !d.tf || !d.expiryMin) throw new Error('oportunidade inválida');
    await engine.setMarket(d.symbol, d.tf);
    engine.setConfig({ expiryMin: d.expiryMin });
    engine.log(`Painel movido para ${NAMES[d.symbol] || d.symbol} · ${d.tf} · expiração ${d.expiryMin} min`, 'ok');
  },
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
  const startScan = () => scanner.start().then(() => console.log('Scanner multi-mercado ativo'))
    .catch(e => { console.log('Scanner indisponível:', e.message, '— nova tentativa em 15 s'); scanner.stop(); setTimeout(startScan, 15000).unref(); });
  if (scanner) startScan();
  const saved = loadConfig();
  if (saved && saved.token && saved.appId) {
    try { await connectWith(saved); console.log('Reconectado com credenciais salvas'); }
    catch (e) { console.log('Credenciais salvas falharam:', e.message); }
  }
});

process.on('unhandledRejection', e => console.error('erro não tratado:', e && e.message));
