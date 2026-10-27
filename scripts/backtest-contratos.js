'use strict';
// Testa outros mercados e outros tipos de contrato da Deriv com dados e preços REAIS (API pública):
//  1) Rise/Fall em commodities, índices de ações e forex com expiração de 60 min (modelo v2/v3, walk-forward)
//  2) Contratos com barreira de 1 dia: probabilidade embutida no preço da Deriv × frequência histórica
//  3) Multiplicadores: direção pelo modelo, comissão real, stop-out
// Correção por múltiplos testes (Benjamini-Hochberg, FDR 10%) dentro de cada bateria.
// Uso: node scripts/backtest-contratos.js [1,2,3]
const fs = require('fs');
const path = require('path');
const deriv = require('../server/deriv');
const { fetchHistory } = require('../server/catalog');
const { evaluateCombo, approve, evaluateMultiplier, barrierEvents } = require('../server/backtest2');
const R = require('../server/research');
const { atr } = require('../server/indicators');

const parts = (process.argv[2] || '1,2,3').split(',');
const wait = ms => new Promise(r => setTimeout(r, ms));
const pct = x => (x == null ? '   -  ' : (x * 100).toFixed(1).padStart(5) + '%');
const GR = { '5m': 300, '15m': 900, '1h': 3600 };
const NAMES = { frxXAUUSD: 'Ouro', frxXAGUSD: 'Prata', OTC_SPC: 'S&P 500', OTC_NDX: 'Nasdaq 100', OTC_DJI: 'Wall Street 30', OTC_GDAXI: 'Alemanha 40',
  OTC_FTSE: 'Reino Unido 100', OTC_N225: 'Japão 225', frxEURUSD: 'EUR/USD', frxGBPUSD: 'GBP/USD', frxUSDJPY: 'USD/JPY', frxAUDJPY: 'AUD/JPY',
  cryBTCUSD: 'BTC/USD', cryETHUSD: 'ETH/USD' };
const nm = s => (NAMES[s] || s).padEnd(15);
const out = { geradoEm: new Date().toISOString(), riseFall: {}, barreiras: [], multiplicadores: [] };
const OUT = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'contratos.json');
const save = () => { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); };

async function hist(sock, sym, gran, max = 10000) {
  const c = await fetchHistory(sock, sym, gran, 2, p => p.waitingMs && console.log(`  (aguardando ${p.waitingMs / 1000} s: ${p.reason})`), max);
  await wait(2500);
  return c;
}
async function proposal(sock, q) {
  for (let i = 0; ; i++) {
    try { return (await sock.send({ proposal: 1, currency: 'USD', amount: 10, basis: 'stake', ...q }, { timeoutMs: 10000 })).proposal; }
    catch (e) { if (/rate limit/i.test(e.message) && i < 5) { await wait(15000 * (i + 1)); continue; } throw e; }
  }
}

async function riseFall(sock) {
  console.log('\n=== 1) RISE/FALL em outros mercados (payout real; v3 = modelo + bloqueios) ===');
  const syms = ['frxXAUUSD', 'frxXAGUSD', 'OTC_SPC', 'OTC_NDX', 'OTC_DJI', 'OTC_GDAXI', 'OTC_FTSE', 'OTC_N225', 'frxEURUSD', 'frxGBPUSD', 'frxUSDJPY'];
  const res = {};
  for (const sym of syms) for (const tf of ['5m', '15m', '1h']) {
    let c; try { c = await hist(sock, sym, GR[tf]); } catch (e) { console.log(`${nm(sym)} ${tf} PULADO: ${e.message}`); continue; }
    if (c.length < 4500) { console.log(`${nm(sym)} ${tf} PULADO: só ${c.length} velas`); continue; }
    for (const exp of R.researchExpiries(sym)) {
      if (/^frx(EUR|GBP)USD$|^frxUSDJPY$/.test(sym) && exp !== 60) continue;     // 15 min já testado no forex
      if (exp * 60 < GR[tf]) continue;
      let pay = 0.95, src = 'padrão';
      try { const p = await proposal(sock, { contract_type: 'CALL', underlying_symbol: sym, duration: exp, duration_unit: 'm' }); pay = p.payout / 10 - 1; src = 'Deriv'; } catch (e) { src = 'padrão (' + e.message.slice(0, 40) + ')'; }
      const r = evaluateCombo(c, { symbol: sym, gran: GR[tf], expiryMin: exp, payout: pay });
      if (!r) continue;
      const k = `${sym}|${tf}|${exp}`;
      res[k] = r;
      out.riseFall[k] = { payout: pay, payoutSource: src, referencia: r.referencia, v1: r.v1, v2: r.v2, v3: r.v3, empate: 1 / (1 + pay) };
      console.log(`${nm(sym)} ${tf.padEnd(3)} exp${String(exp).padEnd(3)} payout ${pct(pay)} empate ${pct(1 / (1 + pay))} | ref ${pct(r.referencia.rate)} | v2 ${String(r.v2.n).padStart(4)} ${pct(r.v2.rate)} | v3 ${String(r.v3.n).padStart(4)} ${pct(r.v3.rate)} VE ${pct(r.v3.evPerTrade)} p=${r.v3.pValue.toFixed(3)}`);
    }
    save();
  }
  approve(res);
  const ok = Object.keys(res).filter(k => res[k].approved);
  for (const k of Object.keys(res)) out.riseFall[k].aprovada = res[k].approved;
  console.log(`APROVADAS (FDR 10%, VE>0, ≥30 op): ${ok.length ? ok.join(', ') : 'nenhuma'}`);
  save();
}

async function barriers(sock) {
  console.log('\n=== 2) CONTRATOS COM BARREIRA (1 dia): preço da Deriv × frequência histórica ===');
  const syms = ['frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDJPY', 'frxXAUUSD', 'frxXAGUSD'];
  const rows = [];
  for (const sym of syms) {
    let c; try { c = await hist(sock, sym, 86400, 5000); } catch (e) { console.log(`${nm(sym)} PULADO: ${e.message}`); continue; }
    if (c.length < 300) { console.log(`${nm(sym)} PULADO: só ${c.length} dias`); continue; }
    const A = atr(c, 14).at(-1);
    let spot, dec;
    try { const p = await proposal(sock, { contract_type: 'CALL', underlying_symbol: sym, duration: 1, duration_unit: 'd' }); spot = +p.spot; dec = (String(p.spot).split('.')[1] || '').length; }
    catch (e) { console.log(`${nm(sym)} PULADO: ${e.message}`); continue; }
    const f = x => x.toFixed(dec);
    console.log(`${nm(sym)} ${c.length} dias de histórico · ATR diário ${f(A)}`);
    for (const k of [0, 0.5, 1, 1.5]) {
      const ev = barrierEvents(c, k), up = f(spot + k * A), dn = f(spot - k * A);
      const specs = k === 0
        ? [['HIGHER', { contract_type: 'CALL' }], ['LOWER', { contract_type: 'PUT' }]]
        : [['ONETOUCH_alta', { contract_type: 'ONETOUCH', barrier: up }], ['ONETOUCH_baixa', { contract_type: 'ONETOUCH', barrier: dn }],
           ['NOTOUCH_alta', { contract_type: 'NOTOUCH', barrier: up }], ['NOTOUCH_baixa', { contract_type: 'NOTOUCH', barrier: dn }],
           ['HIGHER', { contract_type: 'CALL', barrier: up }], ['LOWER', { contract_type: 'PUT', barrier: dn }],
           ['EXPIRYRANGE', { contract_type: 'EXPIRYRANGE', barrier: up, barrier2: dn }], ['EXPIRYMISS', { contract_type: 'EXPIRYMISS', barrier: up, barrier2: dn }],
           ['RANGE', { contract_type: 'RANGE', barrier: up, barrier2: dn }], ['UPORDOWN', { contract_type: 'UPORDOWN', barrier: up, barrier2: dn }]];
      for (const [name, q] of specs) {
        let p; try { p = await proposal(sock, { underlying_symbol: sym, duration: 1, duration_unit: 'd', ...q }); } catch (e) { continue; }
        await wait(400);
        const implied = +p.ask_price / +p.payout, xs = ev[name], n = xs.length, w = xs.filter(Boolean).length, freq = w / n;
        const half = Math.floor(n / 2), f1 = xs.slice(0, half).filter(Boolean).length / half, f2 = xs.slice(half).filter(Boolean).length / (n - half);
        const row = { simbolo: sym, contrato: name, distanciaATR: k, payoutPorStake: +p.payout / +p.ask_price, probImplicita: implied, freqHistorica: freq, freq1aMetade: f1, freq2aMetade: f2,
          dias: n, vePorOp: freq * (+p.payout / +p.ask_price) - 1, pValue: R.binomTailP(w, n, implied) };
        rows.push(row);
        console.log(`  ${name.padEnd(15)} k=${k} paga ${(row.payoutPorStake).toFixed(2)}x | implícita ${pct(implied)} | histórico ${pct(freq)} (${pct(f1)} / ${pct(f2)}) | VE ${pct(row.vePorOp)} p=${row.pValue.toFixed(3)}`);
      }
    }
    out.barreiras = rows; save();
  }
  const okIdx = R.benjaminiHochberg(rows.map(r => r.pValue), 0.1);
  rows.forEach((r, i) => { r.aprovada = okIdx.has(i) && r.vePorOp > 0 && r.freq1aMetade > r.probImplicita && r.freq2aMetade > r.probImplicita; });
  const ok = rows.filter(r => r.aprovada);
  console.log(`APROVADOS (FDR 10%, VE>0 e acima do preço nas duas metades do histórico): ${ok.length ? ok.map(r => `${r.simbolo} ${r.contrato} k=${r.distanciaATR}`).join(', ') : 'nenhum'}`);
  out.barreiras = rows; save();
}

async function multipliers(sock) {
  console.log('\n=== 3) MULTIPLICADORES: direção pelo modelo, comissão real, stop-out ===');
  const syms = ['cryBTCUSD', 'cryETHUSD', 'frxXAUUSD', 'frxXAGUSD', 'frxEURUSD', 'frxGBPUSD', 'frxUSDJPY'];
  const rows = [];
  for (const sym of syms) {
    let mult = null, comm = null;
    for (const m of [50, 100, 30, 20, 10, 200]) {
      try { const p = await proposal(sock, { contract_type: 'MULTUP', underlying_symbol: sym, multiplier: m }); mult = m; comm = +p.commission / 10; break; }
      catch (e) { const mm = e.message.match(/Accepts ([\d,]+)/); if (mm) { const first = +mm[1].split(',')[0]; try { const p = await proposal(sock, { contract_type: 'MULTUP', underlying_symbol: sym, multiplier: first }); mult = first; comm = +p.commission / 10; } catch {} break; } }
    }
    if (!mult) { console.log(`${nm(sym)} PULADO: multiplicador não disponível`); continue; }
    for (const [tf, holds] of [['5m', [3, 12]], ['15m', [1, 4]], ['1h', [1, 4]]]) {
      let c; try { c = await hist(sock, sym, GR[tf]); } catch (e) { console.log(`${nm(sym)} ${tf} PULADO: ${e.message}`); continue; }
      if (c.length < 4500) { console.log(`${nm(sym)} ${tf} PULADO: só ${c.length} velas`); continue; }
      for (const h of holds) {
        const r = evaluateMultiplier(c, { gran: GR[tf], hold: h, mult, commission: comm });
        const row = { simbolo: sym, grafico: tf, manterVelas: h, multiplicador: mult, comissaoPorStake: comm, modelo: r.modelo, sempreCompra: r.sempreCompra };
        rows.push(row);
        const m = r.modelo;
        console.log(`${nm(sym)} ${tf.padEnd(3)} x${mult} manter ${h} vela(s) comissão ${pct(comm)} | modelo ${String(m.n || 0).padStart(4)} op média ${pct(m.mediaPorOp)} acerto ${pct(m.acerto)} stop-outs ${m.stopOuts || 0} p=${m.pValue != null ? m.pValue.toFixed(3) : '-'} | sempre compra média ${pct(r.sempreCompra.mediaPorOp)}`);
      }
      out.multiplicadores = rows; save();
    }
  }
  const valid = rows.filter(r => r.modelo.n);
  const okIdx = R.benjaminiHochberg(valid.map(r => r.modelo.pValue), 0.1);
  valid.forEach((r, i) => { r.aprovada = okIdx.has(i) && r.modelo.mediaPorOp > 0 && r.modelo.n >= 30; });
  const ok = valid.filter(r => r.aprovada);
  console.log(`APROVADOS (FDR 10%, média > 0, ≥30 op): ${ok.length ? ok.map(r => `${r.simbolo} ${r.grafico} manter ${r.manterVelas}`).join(', ') : 'nenhum'}`);
  out.multiplicadores = rows; save();
}

(async () => {
  const sock = deriv.publicSocket(); await sock.connect();
  if (parts.includes('2')) await barriers(sock);          // mais rápido primeiro
  if (parts.includes('3')) await multipliers(sock);
  if (parts.includes('1')) await riseFall(sock);
  sock.close(); save(); console.log('\nsalvo: data/contratos.json');
})().catch(e => { console.error('falhou:', e.message); save(); process.exit(1); });
