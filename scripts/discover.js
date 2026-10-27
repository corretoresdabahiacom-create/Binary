'use strict';
// Levanta na API pública da Deriv: mercados/ativos ativos e, para uma amostra de cada mercado, os tipos de
// contrato, durações e payout real de uma proposta. Saída: data/discover.json (+ resumo no console).
const fs = require('fs');
const path = require('path');
const deriv = require('../server/deriv');

const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const s = deriv.publicSocket(); await s.connect();
  const act = await s.send({ active_symbols: 'brief' });
  const syms = act.active_symbols || [];
  const byMkt = {};
  for (const a of syms) (byMkt[a.market_display_name || a.market] = byMkt[a.market_display_name || a.market] || []).push(a);
  console.log('MERCADOS:');
  for (const [m, l] of Object.entries(byMkt)) console.log(` ${m.padEnd(22)} ${l.length} ativos · ex.: ${l.slice(0, 6).map(x => x.symbol).join(', ')}`);
  const sample = [];
  for (const [m, l] of Object.entries(byMkt)) {
    const open = l.filter(x => x.exchange_is_open);
    sample.push(...(open.length ? open : l).slice(0, 3).map(x => ({ market: m, symbol: x.symbol, name: x.display_name, open: !!x.exchange_is_open, submarket: x.submarket_display_name })));
  }
  const out = { generatedAt: new Date().toISOString(), markets: Object.fromEntries(Object.entries(byMkt).map(([m, l]) => [m, l.map(x => ({ symbol: x.symbol, name: x.display_name, submarket: x.submarket_display_name, open: !!x.exchange_is_open }))])), contracts: {} };
  for (const a of sample) {
    try {
      const r = await s.send({ contracts_for: a.symbol });
      const av = (r.contracts_for && r.contracts_for.available) || [];
      const types = {};
      for (const c of av) {
        const k = `${c.contract_category_display || c.contract_category}|${c.contract_type}|${c.expiry_type}`;
        const t = types[k] = types[k] || { categoria: c.contract_category_display || c.contract_category, tipo: c.contract_type, expiracao: c.expiry_type, min: c.min_contract_duration, max: c.max_contract_duration, barreiras: c.barriers, exemploBarreira: c.barrier || c.high_barrier || null };
        if (c.barrier) t.exemploBarreira = c.barrier;
      }
      out.contracts[a.symbol] = { ...a, types: Object.values(types) };
      console.log(`\n${a.market} · ${a.name} (${a.symbol})${a.open ? '' : ' [fechado agora]'}`);
      for (const t of Object.values(types)) console.log(`   ${String(t.categoria).padEnd(24)} ${String(t.tipo).padEnd(12)} ${String(t.expiracao).padEnd(9)} ${t.min || '-'}..${t.max || '-'}${t.barreiras ? ' barreiras:' + t.barreiras : ''}`);
    } catch (e) { console.log(`\n${a.symbol}: ${e.message}`); }
    await wait(700);
  }
  fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'discover.json'), JSON.stringify(out, null, 1));
  s.close(); console.log('\nsalvo: data/discover.json');
})().catch(e => { console.error('falhou:', e.message); process.exit(1); });
