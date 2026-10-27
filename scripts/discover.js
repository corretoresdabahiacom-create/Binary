'use strict';
// Levanta na Deriv (API pública) os mercados e tipos de contrato disponíveis, com durações e payout de exemplo.
const deriv = require('../server/deriv');
(async () => {
  const s = deriv.publicSocket(); await s.connect();
  const a = await s.send({ active_symbols: 'brief' });
  const syms = a.active_symbols.filter(x => !x.is_trading_suspended);
  const byMkt = {};
  for (const x of syms) (byMkt[x.market + '/' + x.submarket] = byMkt[x.market + '/' + x.submarket] || []).push(x.symbol + (x.exchange_is_open ? '' : '(fechado)'));
  console.log('MERCADOS:'); for (const [k, v] of Object.entries(byMkt)) console.log(' ', k.padEnd(34), v.length, v.slice(0, 8).join(' '));
  const pick = process.argv[2] ? process.argv[2].split(',') : ['frxEURUSD', 'frxXAUUSD', 'OTC_SPC', 'cryBTCUSD', 'R_100'];
  for (const sym of pick) {
    try {
      const r = await s.send({ contracts_for: sym });
      const rows = {};
      for (const c of r.contracts_for.available) { const k = `${c.contract_category}/${c.contract_type}/${c.expiry_type}`; rows[k] = `${c.min_contract_duration}–${c.max_contract_duration}${c.barriers ? ' barreiras:' + c.barriers : ''}`; }
      console.log(`\n${sym}:`); for (const [k, v] of Object.entries(rows)) console.log('  ', k.padEnd(40), v);
    } catch (e) { console.log(`\n${sym}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 800));
  }
  s.close();
})().catch(e => { console.error('falhou:', e.message); process.exit(1); });
