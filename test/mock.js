'use strict';
// Servidor Deriv SIMULADO apenas para testes do protocolo. O produto real nunca usa isto.
const http = require('http');
const { WebSocketServer } = require('ws');

function startMock() {
  const state = { buys: [], sells: [], otps: 0, outcome: 'won', wsUrls: [] };
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const auth = req.headers.authorization;
    if (auth !== 'Bearer TOKEN' || req.headers['deriv-app-id'] !== 'APP1') { res.statusCode = 401; return res.end(JSON.stringify({ errors: [{ message: 'Unauthorized' }] })); }
    if (req.method === 'GET' && req.url === '/trading/v1/options/accounts')
      return res.end(JSON.stringify({ data: [
        { account_id: 'REAL1', balance: 50, currency: 'USD', group: 'row', status: 'active', account_type: 'real' },
        { account_id: 'DEMO1', balance: 10000, currency: 'USD', group: 'row', status: 'active', account_type: 'demo' }] }));
    const m = req.url.match(/accounts\/(\w+)\/otp$/);
    if (req.method === 'POST' && m) {
      state.otps++;
      const kind = m[1].startsWith('DEMO') ? 'demo' : 'real';
      return res.end(JSON.stringify({ data: { url: `ws://127.0.0.1:${server.address().port}/trading/v1/options/ws/${kind}?otp=abc${state.otps}` } }));
    }
    res.statusCode = 404; res.end('{}');
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    state.wsUrls.push(req.url);
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      const reply = o => ws.send(JSON.stringify({ ...o, req_id: m.req_id, echo_req: m }));
      if (m.ping) return reply({ msg_type: 'ping', ping: 'pong' });
      if (m.time) return reply({ msg_type: 'time', time: Math.floor(Date.now() / 1000) });
      if (m.ticks_history) {
        const t0 = Math.floor(Date.now() / 1000 / 900) * 900 - 499 * 900; let p = 1000;
        const candles = Array.from({ length: 500 }, (_, i) => { const o = p; p += Math.sin(i / 5) * 2; return { epoch: t0 + i * 900, open: o, high: Math.max(o, p) + 1, low: Math.min(o, p) - 1, close: p }; });
        return reply({ msg_type: 'candles', candles, subscription: { id: 'sub-1' } });
      }
      if (m.forget) return reply({ msg_type: 'forget', forget: 1 });
      if (m.proposal) return reply({ msg_type: 'proposal', proposal: { id: 'P'.repeat(32), ask_price: m.amount, payout: +(m.amount * 1.95).toFixed(2), spot: 1000 } });
      if (m.buy) {
        state.buys.push(m);
        reply({ msg_type: 'buy', buy: { contract_id: 777, buy_price: 1, payout: 1.95, balance_after: 9999, longcode: 'x', purchase_time: 1, shortcode: 'x', start_time: 1, transaction_id: 5 } });
        return;
      }
      if (m.proposal_open_contract) {
        reply({ msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: 777, entry_spot: 1000.4, current_spot: 1001, profit: 0.2, is_valid_to_sell: 1, is_sold: 0 } });
        setTimeout(() => {
          const won = state.outcome === 'won';
          ws.send(JSON.stringify({ msg_type: 'proposal_open_contract', req_id: m.req_id, proposal_open_contract: { contract_id: 777, is_sold: 1, status: won ? 'won' : 'lost', profit: won ? 0.95 : -1, exit_tick: 1002, entry_spot: 1000.4 } }));
        }, 50);
        return;
      }
      if (m.sell) { state.sells.push(m); return reply({ msg_type: 'sell', sell: { contract_id: m.sell } }); }
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, state, port: server.address().port })));
}

module.exports = { startMock };
