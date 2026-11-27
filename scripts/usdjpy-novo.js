'use strict';
// USD/JPY: ângulos NOVOS (local da vela × sequência), com seleção SÓ no treino e avaliação única no teste (sem viés de seleção).
// Contextos: número redondo (.00/.50), faixa do dia anterior, posição na faixa de 96 velas, distância das médias (4h/1 dia), sessão, volatilidade.
// Cada contexto é cruzado com a sequência das últimas 1/2/3 velas (cor). Regra = maioria histórica do contexto (≥56%/≤44%, n≥50) aprendida no treino.
// 3 dobras em ordem de tempo (treino cresce, teste = bloco seguinte, nunca visto). Mede acerto vs. break-even do payout real.
const R = require('../server/research');
const fs = require('fs');
const GRAN = 900, SYM = 'frxUSDJPY', MINN = 50, THR = 0.56;
const { features, FAMS, keyOf, wil } = require('../server/ctx');

function runFold(cs, F, tr0, tr1, te1, pay) {
  const mem = FAMS.map(() => new Map());
  for (let i = tr0; i < tr1 - 1; i++) { if (!F[i]) continue; const y = Math.sign(cs[i + 1].close - cs[i].close); if (!y) continue; FAMS.forEach((fam, fi) => { const k = keyOf(F[i], fam); if (k == null) return; const m = mem[fi].get(k) || [0, 0]; m[y > 0 ? 0 : 1]++; mem[fi].set(k, m); }); }
  const rule = FAMS.map((fam, fi) => { const r = new Map(); for (const [k, [u, d]] of mem[fi]) { const n = u + d; if (n < MINN) continue; const p = u / n; if (p >= THR) r.set(k, { dir: 1, sc: wil(u, n) }); else if (1 - p >= THR) r.set(k, { dir: -1, sc: wil(d, n) }); } return r; });
  const famRes = FAMS.map(() => ({ n: 0, w: 0 })), all = { n: 0, w: 0 };
  for (let i = tr1; i < te1 - 1; i++) { if (!F[i]) continue; const y = Math.sign(cs[i + 1].close - cs[i].close); if (!y) continue; let best = null;
    FAMS.forEach((fam, fi) => { const k = keyOf(F[i], fam); if (k == null) return; const r = rule[fi].get(k); if (!r) return; famRes[fi].n++; if (r.dir === y) famRes[fi].w++; if (!best || r.sc > best.sc) best = r; });
    if (best) { all.n++; if (best.dir === y) all.w++; } }
  return { all, famRes, nRules: rule.reduce((s, r) => s + r.size, 0) };
}
(async () => {
  let cs;
  if (process.env.SYNTH) { let s = 5, r = () => (s = (s * 16807) % 2147483647) / 2147483647, p = 150, t = 1700000000; cs = []; for (let i = 0; i < 11000; i++) { const op = p; let h = op, l = op; for (let k = 0; k < 20; k++) { p *= 1 + (r() - .5) * .0006; h = Math.max(h, p); l = Math.min(l, p); } cs.push({ epoch: t += GRAN, open: op, high: h, low: l, close: p }); } }
  else { const deriv = require('../server/deriv'), { fetchHistory } = require('../server/catalog'); const sock = deriv.publicSocket(); await sock.connect(); cs = await fetchHistory(sock, SYM, GRAN, 3, () => {}, 12000); sock.close(); }
  let pay = 0.90; if (!process.env.SYNTH) { try { const deriv = require('../server/deriv'); const sock = deriv.publicSocket(); await sock.connect(); const r = await sock.send({ proposal: 1, contract_type: 'CALL', underlying_symbol: SYM, currency: 'USD', amount: 10, basis: 'stake', duration: 15, duration_unit: 'm' }, { timeoutMs: 10000 }); const q = +r.proposal.payout; if (q > 10) pay = q / 10 - 1; sock.close(); } catch (e) { console.log('payout padrão 90%:', e.message); } }
  const BE = 1 / (1 + pay); console.log(`USD/JPY: ${cs.length} velas, ${((cs.at(-1).epoch - cs[0].epoch) / 86400).toFixed(0)} dias · payout ${(pay * 100).toFixed(1)}% → break-even ${(BE * 100).toFixed(1)}% · ${FAMS.length} famílias`);
  const F = features(cs), L = cs.length, folds = [[0.5, 0.667], [0.667, 0.833], [0.833, 1]];
  const tot = { all: { n: 0, w: 0 }, fam: FAMS.map(() => ({ n: 0, w: 0 })) };
  folds.forEach(([a, b], k) => { const r = runFold(cs, F, 0, Math.floor(L * a), Math.floor(L * b), pay); tot.all.n += r.all.n; tot.all.w += r.all.w; r.famRes.forEach((x, i) => { tot.fam[i].n += x.n; tot.fam[i].w += x.w; });
    console.log(`dobra ${k + 1}: regras aprendidas ${r.nRules} · teste ${r.all.n} ops · acerto ${r.all.n ? (r.all.w / r.all.n * 100).toFixed(1) : '-'}%`); });
  const P = R.binomTailP, pct = x => (x * 100).toFixed(1) + '%';
  console.log(`\nCONJUNTO (melhor regra por vela, só fora da amostra): ${tot.all.n} ops · acerto ${pct(tot.all.w / tot.all.n)} · limite inferior 90% ${pct(wil(tot.all.w, tot.all.n))} · p vs break-even ${P(tot.all.w, tot.all.n, BE).toFixed(3)}`);
  console.log('\nPor família (fora da amostra; n=ops, acerto, limite inferior, p vs break-even):');
  const rows = FAMS.map((f, i) => ({ id: f.id, ...tot.fam[i] })).filter(x => x.n >= 30).sort((a, b) => b.w / b.n - a.w / a.n);
  const ps = rows.map(x => P(x.w, x.n, BE)), ok = new Set(R.benjaminiHochberg(ps, 0.1));
  rows.forEach((x, i) => console.log(`${x.id.padEnd(22)} n=${String(x.n).padStart(4)} ${pct(x.w / x.n).padStart(6)} LI ${pct(wil(x.w, x.n)).padStart(6)} p=${ps[i].toFixed(3)}${ok.has(i) ? '  ← passa FDR' : ''}`));
  console.log(`\n${rows.length} famílias avaliadas; passam FDR 10%: ${ok.size}`);
})();
