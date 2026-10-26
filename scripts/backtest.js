'use strict';
// Backtest walk-forward com dados REAIS da Deriv (WebSocket público, sem token).
// Em cada vela t o modelo só conhece velas cujo resultado já existia (t' + h <= t).
// Uso: node scripts/backtest.js [simbolos] [tfs] [expiracoes]
//   ex.: node scripts/backtest.js R_10,R_100 5m,15m 5,15
const fs = require('fs');
const path = require('path');
const deriv = require('../server/deriv');
const { fetchHistory } = require('../server/catalog');
const { buildModel, estimate, wilson } = require('../server/probability');

const GR = { '5m': 300, '15m': 900, '1h': 3600 };
const syms = (process.argv[2] || 'R_10,R_25,R_50,R_75,R_100').split(',');
const tfs = (process.argv[3] || '5m,15m').split(',');
const exps = (process.argv[4] || '5,15').split(',').map(Number);
const THRESH = [0.55, 0.56, 0.58, 0.60, 0.62];
const MIN_N = 40, TRAIN = 3000, RETRAIN = 250, BREAKEVEN = 1 / 1.95; // payout típico ~95%

(async () => {
  const sock = deriv.publicSocket();
  await sock.connect();
  const rows = [];
  for (const sym of syms) for (const tf of tfs) {
    const g = GR[tf];
    const c = await fetchHistory(sock, sym, g, 2, () => {}, 10000);
    for (const e of exps) {
      const h = e * 60 / g;
      if (!Number.isInteger(h) || h < 1) continue;
      const res = Object.fromEntries(THRESH.map(t => [t, { n: 0, w: 0 }]));
      let model = null;
      for (let t = TRAIN; t + h < c.length - 1; t++) {
        if (!model || (t - TRAIN) % RETRAIN === 0) model = buildModel(c.slice(0, t - h + 1), h); // só resultados conhecidos
        const est = estimate(model, c, t, MIN_N);
        if (!est || est.n < MIN_N) continue;
        const d = c[t + h].close - c[t].close;
        if (d === 0) continue;
        const win = (d > 0) === (est.direction === 'CALL');
        for (const th of THRESH) if (est.p >= th && est.lo > 0.5) { res[th].n++; if (win) res[th].w++; }
      }
      for (const th of THRESH) {
        const { n, w } = res[th], [lo, hi] = wilson(w, n);
        rows.push({ ativo: sym, grafico: tf, expiracao: e, minProb: th, velasTeste: c.length - TRAIN, sinais: n, acertos: w,
          taxa: n ? +(w / n).toFixed(4) : null, ic95: n ? [+lo.toFixed(3), +hi.toFixed(3)] : null,
          acimaDoEmpate: n ? lo > BREAKEVEN : false });
      }
      console.log(`${sym} ${tf} exp${e}: ` + THRESH.map(th => { const r = rows.find(x => x.ativo === sym && x.grafico === tf && x.expiracao === e && x.minProb === th); return `${th * 100}%→${r.sinais} sinais ${r.taxa == null ? '-' : (r.taxa * 100).toFixed(1) + '%'}`; }).join(' | '));
    }
  }
  sock.close();
  const out = path.join(__dirname, '..', 'data', `backtest-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ geradoEm: new Date().toISOString(), empate: BREAKEVEN, rows }, null, 1));
  console.log('salvo em', out);
})().catch(e => { console.error('falhou:', e.message); process.exit(1); });
