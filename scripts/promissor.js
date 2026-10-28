'use strict';
// Isola o que sobrou de promissor: MODELO DO APP + FLUXO concordando. Como a Deriv guarda só ~1 dia de ticks,
// o fluxo é aproximado por velas de 1 min (soma do sinal das últimas N velas de 1 min) — dá ~100 dias de teste.
// Hipótese fixada ANTES do teste: "modelo (p≥0,55) e fluxo de 5 min concordam" → entrar na direção. Sem escolher limiar depois.
// Modelo retreinado só com o passado (expanding, a cada 500 velas). Operações sem sobreposição (1 por vela de 15 min).
// Depois testa a ideia do usuário: a cada dia escolher o par mais promissor (histórico anterior) e operar só ele.
const deriv = require('../server/deriv');
const { fetchHistory, wilsonLower } = require('../server/catalog');
const R = require('../server/research');
const P = require('../server/probability');
const SYMS = (process.argv[2] || 'frxEURUSD,frxGBPUSD,frxUSDJPY,frxAUDUSD,frxUSDCAD,frxUSDCHF,frxNZDUSD,frxEURGBP,frxEURJPY,frxGBPJPY').split(',');
const PAY = 0.78, BE = 1 / (1 + PAY), NM = s => s.replace('frx', '').replace(/(...)(...)/, '$1/$2');
const pct = x => (x == null ? '  -  ' : (x * 100).toFixed(1).padStart(5) + '%');
const wait = ms => new Promise(r => setTimeout(r, ms));
const lb = (w, n) => (n ? wilsonLower(w, n, 1.645) : 0);

(async () => {
  const sock = deriv.publicSocket(); await sock.connect();
  const trades = { alone: [], agree: [], disagree: [], f1: [], f3: [], f15: [] };   // {sym, day, win}
  for (const sym of SYMS) {
    let c15, c1;
    try {
      c15 = await fetchHistory(sock, sym, 900, 2, () => {}, 10000); await wait(2500);
      c1 = await fetchHistory(sock, sym, 60, 30, p => p.waitingMs && console.log(`  (aguardando ${p.waitingMs / 1000} s)`), 150000);
    } catch (e) { console.log(`${NM(sym)}: PULADO ${e.message}`); continue; }
    const m1 = new Map(c1.map(c => [c.epoch, c]));
    const flow = (d, k) => { let s = 0, n = 0; for (let t = d - 60 * k; t < d; t += 60) { const c = m1.get(t); if (c) { s += Math.sign(c.close - c.open); n++; } } return n >= Math.ceil(k * 0.6) ? Math.sign(s) : 0; };
    const from1 = c1[0].epoch; let model = null, trainedAt = -1, cnt = 0;
    for (let i = 600; i < c15.length - 1; i++) {
      if (i - trainedAt >= 500) { model = P.buildModel(c15.slice(0, i), 1); trainedAt = i; }
      const d = c15[i].epoch + 900; if (c15[i].epoch < from1) continue;
      const e = P.estimate(model, c15, i, 40); if (!e || e.p < 0.55) continue;
      const y = Math.sign(c15[i + 1].close - c15[i].close); if (!y) continue;
      const dm = e.direction === 'CALL' ? 1 : -1, day = new Date(d * 1000).toISOString().slice(0, 10), f5 = flow(d, 5);
      const rec = (k, dir) => trades[k].push({ sym, day, win: dir === y });
      rec('alone', dm); cnt++;
      if (f5 === dm) rec('agree', dm); else if (f5 === -dm) rec('disagree', dm);
      for (const [k, W] of [['f1', 1], ['f3', 3], ['f15', 15]]) if (flow(d, W) === dm) rec(k, dm);
    }
    console.log(`${NM(sym)}: ${c15.length} velas 15m, ${c1.length} velas 1m (${((c1.at(-1).epoch - from1) / 86400).toFixed(0)} dias), ${cnt} decisões do modelo`);
    await wait(2500);
  }
  sock.close();
  const stat = a => { const n = a.length, w = a.filter(x => x.win).length; return { n, w, rate: n ? w / n : null, p50: R.binomTailP(w, n, 0.5), pBE: R.binomTailP(w, n, BE), lb: lb(w, n) }; };
  console.log(`\nPayout ${pct(PAY)} → empate ${pct(BE)}  (todos os pares, ~100 dias)`);
  const names = { alone: 'MODELO sozinho (p≥0,55)', agree: 'MODELO + fluxo 5 min concordando  ← hipótese', disagree: 'MODELO com fluxo 5 min discordando', f1: 'MODELO + fluxo 1 min concordando', f3: 'MODELO + fluxo 3 min concordando', f15: 'MODELO + fluxo 15 min concordando' };
  const ps = Object.keys(names).map(k => ({ k, ...stat(trades[k]) }));
  const ok = R.benjaminiHochberg(ps.map(x => x.pBE), 0.1);
  ps.forEach((x, i) => console.log(`  ${names[x.k].padEnd(46)} ${String(x.n).padStart(6)} op  acerto ${pct(x.rate)}  IC90 inferior ${pct(x.lb)}  p(>50%)=${x.p50.toFixed(4)}  p(>empate)=${x.pBE.toFixed(4)} ${ok.has(i) ? '✓' : ''}`));
  // por metade do período (estabilidade) e por par, para a hipótese
  const A = trades.agree.slice().sort((a, b) => a.day.localeCompare(b.day)), half = Math.floor(A.length / 2);
  console.log(`\nEstabilidade da hipótese: 1ª metade ${pct(stat(A.slice(0, half)).rate)} (${half} op) · 2ª metade ${pct(stat(A.slice(half)).rate)} (${A.length - half} op)`);
  for (const s of SYMS) { const x = stat(trades.agree.filter(t => t.sym === s)); if (x.n) console.log(`  ${NM(s).padEnd(8)} ${String(x.n).padStart(4)} op ${pct(x.rate)}`); }
  // escolha diária do par: melhor limite inferior do acerto nos 30 dias anteriores (mín. 15 op), opera só ele no dia
  const days = [...new Set(A.map(t => t.day))].sort(); let n = 0, w = 0, diasOp = 0;
  for (const day of days) {
    const di = new Date(day).getTime(), past = A.filter(t => { const x = new Date(t.day).getTime(); return x < di && x >= di - 30 * 86400e3; });
    let best = null; for (const s of SYMS) { const a = past.filter(t => t.sym === s); if (a.length >= 15) { const l = lb(a.filter(t => t.win).length, a.length); if (!best || l > best.l) best = { s, l }; } }
    if (!best) continue; const today = A.filter(t => t.day === day && t.sym === best.s); if (!today.length) continue;
    diasOp++; n += today.length; w += today.filter(t => t.win).length;
  }
  console.log(`\nESCOLHA DIÁRIA DO PAR (melhor dos 30 dias anteriores, só ele no dia): ${diasOp} dias, ${n} op, acerto ${pct(n ? w / n : null)} | p(>empate)=${R.binomTailP(w, n, BE).toFixed(4)} | empate ${pct(BE)}`);
})().catch(e => { console.error('falhou:', e.message); process.exit(1); });
