'use strict';
// Sonda o formato das propostas (preço real) de cada tipo de contrato na API pública da Deriv.
const deriv = require('../server/deriv');
const wait = ms => new Promise(r => setTimeout(r, ms));
const cases = [
  ['frxXAUUSD', { contract_type: 'CALL', duration: 5, duration_unit: 'm' }],
  ['frxXAUUSD', { contract_type: 'CALL', duration: 1, duration_unit: 'h' }],
  ['OTC_SPC', { contract_type: 'CALL', duration: 15, duration_unit: 'm' }],
  ['OTC_SPC', { contract_type: 'CALL', duration: 1, duration_unit: 'h' }],
  ['frxEURUSD', { contract_type: 'CALL', duration: 1, duration_unit: 'h' }],
  ['frxEURUSD', { contract_type: 'CALL', duration: 1, duration_unit: 'd' }],
  ['frxEURUSD', { contract_type: 'ONETOUCH', duration: 1, duration_unit: 'd', barrier: '+0.0050' }],
  ['frxEURUSD', { contract_type: 'NOTOUCH', duration: 1, duration_unit: 'd', barrier: '+0.0050' }],
  ['frxEURUSD', { contract_type: 'CALL', duration: 1, duration_unit: 'd', barrier: '+0.0030' }],
  ['frxEURUSD', { contract_type: 'EXPIRYRANGE', duration: 1, duration_unit: 'd', barrier: '+0.0040', barrier2: '-0.0040' }],
  ['frxEURUSD', { contract_type: 'RANGE', duration: 1, duration_unit: 'd', barrier: '+0.0060', barrier2: '-0.0060' }],
  ['cryBTCUSD', { contract_type: 'MULTUP', multiplier: 10 }],
  ['frxXAUUSD', { contract_type: 'MULTUP', multiplier: 50 }],
  ['frxEURUSD', { contract_type: 'MULTUP', multiplier: 100 }],
];
(async () => {
  const s = deriv.publicSocket(); await s.connect();
  for (const [sym, q] of cases) {
    try {
      const r = await s.send({ proposal: 1, underlying_symbol: sym, currency: 'USD', amount: 10, basis: 'stake', ...q }, { timeoutMs: 10000 });
      const p = r.proposal || {};
      console.log(sym, JSON.stringify(q), '→', JSON.stringify({ payout: p.payout, ask: p.ask_price, spot: p.spot, commission: p.commission, limit: p.limit_order, barrier: p.barrier, barrier2: p.low_barrier || p.barrier2, keys: Object.keys(p).join(',') }));
    } catch (e) { console.log(sym, JSON.stringify(q), 'ERRO', e.message); }
    await wait(600);
  }
  s.close();
})();
