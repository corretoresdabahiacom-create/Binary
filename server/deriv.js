'use strict';
// Cliente da API oficial da Deriv (https://developers.deriv.com).
// - REST (https://api.derivws.com): lista contas e emite OTP de 120 s, uso único.
// - WebSocket: /options/ws/public (dados, sem login) e /options/ws/demo|real?otp=... (negociação).
const WebSocket = require('ws');
const EventEmitter = require('events');

const REST_BASE = process.env.DERIV_REST_BASE || 'https://api.derivws.com';
const WS_PUBLIC = process.env.DERIV_WS_PUBLIC || 'wss://api.derivws.com/trading/v1/options/ws/public';

async function rest(path, { method = 'GET', token, appId } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (appId) headers['Deriv-App-ID'] = appId; // obrigatório para tokens PAT
  const res = await fetch(REST_BASE + path, { method, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json.errors && json.errors[0];
    throw new Error(`Deriv REST ${res.status}: ${e ? e.message : res.statusText}`);
  }
  return json;
}

const listAccounts = (token, appId) =>
  rest('/trading/v1/options/accounts', { token, appId }).then(j => j.data || []);

const getOtpUrl = (token, appId, accountId) =>
  rest(`/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`, { method: 'POST', token, appId })
    .then(j => j.data.url);

// Conexão WebSocket com req_id, assinaturas e medição de latência.
class DerivSocket extends EventEmitter {
  constructor(urlProvider, label) {
    super();
    this.urlProvider = urlProvider; // função async que devolve a URL (OTP novo a cada conexão)
    this.label = label;
    this.ws = null;
    this.reqId = 1;
    this.pending = new Map();
    this.latencyMs = null;
    this.closedByUser = false;
  }

  async connect() {
    this.closedByUser = false;
    const url = await this.urlProvider();
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.once('open', () => { this._startPing(); resolve(); });
      ws.once('error', reject);
      ws.on('message', d => this._onMessage(d));
      ws.on('close', () => this._onClose());
    });
    this.emit('open');
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.msg_type === 'ping' || msg.ping) {
      const t = this._pingSent;
      if (t) this.latencyMs = Date.now() - t;
      this.emit('latency', this.latencyMs);
    }
    const p = msg.req_id != null ? this.pending.get(msg.req_id) : null;
    if (p) {
      if (msg.error) { this.pending.delete(msg.req_id); p.reject(Object.assign(new Error(msg.error.message || 'erro Deriv'), { code: msg.error.code })); }
      else if (!p.keep) { this.pending.delete(msg.req_id); p.resolve(msg); }
      else { p.resolve(msg); p.keep = false; p.stream = true; }
    }
    this.emit('message', msg);
  }

  _startPing() {
    clearInterval(this._pingTimer);
    const ping = () => { this._pingSent = Date.now(); this._raw({ ping: 1 }); };
    ping();
    this._pingTimer = setInterval(ping, 15000);
  }

  _raw(obj) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }

  // Envia e espera a primeira resposta com o mesmo req_id.
  send(payload, { subscribe = false, timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error(`${this.label}: sem conexão`));
      const id = this.reqId++;
      const req = { ...payload, req_id: id };
      if (subscribe) req.subscribe = 1;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.label}: tempo esgotado (${Object.keys(payload)[0]})`)); }, timeoutMs);
      this.pending.set(id, {
        keep: subscribe,
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify(req));
    });
  }

  _onClose() {
    clearInterval(this._pingTimer);
    for (const [, p] of this.pending) p.reject(new Error(`${this.label}: conexão encerrada`));
    this.pending.clear();
    this.emit('close');
    if (!this.closedByUser) this._reconnect();
  }

  async _reconnect(attempt = 1) {
    if (this.closedByUser) return;
    const wait = Math.min(15000, 1000 * attempt);
    await new Promise(r => setTimeout(r, wait));
    try {
      await this.connect();
      this.emit('reconnected');
    } catch (e) {
      this.emit('warn', `reconexão ${attempt} falhou: ${e.message}`);
      this._reconnect(attempt + 1);
    }
  }

  close() {
    this.closedByUser = true;
    clearInterval(this._pingTimer);
    if (this.ws) this.ws.close();
  }
}

const publicSocket = () => new DerivSocket(async () => WS_PUBLIC, 'público');
const tradingSocket = (token, appId, accountId) =>
  new DerivSocket(() => getOtpUrl(token, appId, accountId), `conta ${accountId}`);

module.exports = { listAccounts, getOtpUrl, publicSocket, tradingSocket, DerivSocket };
