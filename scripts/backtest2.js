'use strict';
// Backtest v2 com dados REAIS da Deriv. Gera data/research.json (calibração, meta-modelo, payout e
// aprovação por combinação) — o painel e o scanner passam a usar estes artefatos automaticamente.
// Uso: node scripts/backtest2.js [simbolos] [tfs]
const deriv = require('../server/deriv');
const { fetchHistory } = require('../server/catalog');
const { evaluateCombo, approve } = require('../server/backtest2');
const { saveResearch } = require('../server/research');
const { DEFAULT_SYMBOLS, NAMES, TFS, EXPIRIES } = require('../server/scanner');

const syms = process.argv[2] ? process.argv[2].split(',') : DEFAULT_SYMBOLS;
const tfs = process.argv[3] ? process.argv[3].split(',') : Object.keys(TFS);
const pct = x => (x == null ? '   -  ' : (x * 100).toFixed(1).padStart(5) + '%');

// Payout real (Rise/Fall, stake 10) via proposta da Deriv; se a API pública não aceitar, usa 95% e marca.
async function payoutOf(sock, sym, exp) {
  try {
    const r = await sock.send({ proposal: 1, contract_type: 'CALL', underlying_symbol: sym, currency: 'USD', amount: 10, basis: 'stake', duration: exp, duration_unit: 'm' }, { timeoutMs: 10000 });
    const p = +r.proposal.payout; if (p > 10) return { payout: p / 10 - 1, source: 'Deriv (proposta)' };
  } catch (e) { return { payout: 0.95, source: 'padrão 95% (' + e.message.slice(0, 60) + ')' }; }
  return { payout: 0.95, source: 'padrão 95%' };
}

(async () => {
  const sock = deriv.publicSocket(); await sock.connect();
  const results = {}, meta = {};
  for (const sym of syms) for (const tf of tfs) {
    const c = await fetchHistory(sock, sym, TFS[tf], 2, () => {}, 10000);
    for (const exp of require('../server/research').contractRules(sym).expiries) {
      const key = `${sym}|${tf}|${exp}`;
      const pay = await payoutOf(sock, sym, exp);
      const t = Date.now();
      const r = evaluateCombo(c, { symbol: sym, gran: TFS[tf], expiryMin: exp, payout: pay.payout });
      if (!r) continue;
      r.payoutSource = pay.source; r.candles = c.length; r.from = c[0].epoch; r.to = c.at(-1).epoch;
      results[key] = r;
      console.log(`${(NAMES[sym] || sym).padEnd(15)} ${tf.padEnd(3)} exp${String(exp).padEnd(2)} payout ${pct(pay.payout)} | v1: ${String(r.v1.n).padStart(4)} op ${pct(r.v1.rate)} | v2: ${String(r.v2.n).padStart(4)} op ${pct(r.v2.rate)} VE ${pct(r.v2.evPerTrade)} p=${r.v2.pValue.toFixed(3)} (${((Date.now() - t) / 1000).toFixed(0)} s)`);
    }
  }
  sock.close();
  approve(results);
  const agg = v => { const rs = Object.values(results).map(r => r[v]); const n = rs.reduce((a, x) => a + x.n, 0), w = rs.reduce((a, x) => a + x.wins, 0); return { n, w, rate: n ? w / n : null }; };
  const a1 = agg('v1'), a2 = agg('v2');
  console.log(`\nAGREGADO (operações independentes): v1 ${a1.n} op ${pct(a1.rate)} | v2 ${a2.n} op ${pct(a2.rate)}`);
  const ok = Object.entries(results).filter(([, r]) => r.approved);
  console.log(`APROVADAS (FDR 10%, VE>0, ≥30 op): ${ok.length ? ok.map(([k]) => k).join(', ') : 'nenhuma'}`);
  const combos = {};
  for (const [k, r] of Object.entries(results)) combos[k] = { approved: r.approved, iso: r.art.iso, meta: r.art.meta, payout: r.payout, payoutSource: r.payoutSource,
    v1: r.v1, v2: r.v2, calibration: r.calibration, v1PorSessao: r.v1PorSessao, folds: r.folds, candles: r.candles, from: r.from, to: r.to };
  saveResearch({ generatedAt: new Date().toISOString(), method: 'walk-forward 1000 velas, embargo h+2, isotônica + logística em 30% fora da amostra do treino, sem sobreposição, BH-FDR 10%', aggregate: { v1: a1, v2: a2 }, combos });
  console.log('salvo: data/research.json');
})().catch(e => { console.error('falhou:', e.message); process.exit(1); });
