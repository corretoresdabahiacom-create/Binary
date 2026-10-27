'use strict';
// Testa ÂNGULOS NOVOS com dados reais da Deriv (forex + ouro, velas de 5 min, alvo = direção em 15 min):
//  A) Cruzamento entre ativos: o movimento recente de OUTRO par (ou de um "índice do dólar" montado com os
//     pares) prevê o próximo movimento deste par? (lead-lag)
//  B) Extremos estatísticos: depois de movimentos de 2+ desvios-padrão, o preço reverte ou continua?
//  C) Horário × dia da semana: há direção típica por hora/dia?
//  D) Convergência: quando A, B e o modelo do app apontam para o mesmo lado ao mesmo tempo.
// Método: regra e direção escolhidas SÓ nos primeiros 60% do histórico; avaliação nos 40% finais, com
// operações sem sobreposição; p-valor contra 50% e contra o empate do payout real; Benjamini-Hochberg.
const deriv = require('../server/deriv');
const { fetchHistory } = require('../server/catalog');
const R = require('../server/research');
const P = require('../server/probability');

const SYMS = ['frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDUSD', 'frxUSDCAD', 'frxUSDCHF', 'frxNZDUSD', 'frxEURGBP', 'frxEURJPY', 'frxGBPJPY', 'frxXAUUSD'];
const NM = s => s.replace('frx', '').replace(/(...)(...)/, '$1/$2');
const G = 300, H = 3, PAYOUT = 0.78, BE = 1 / (1 + PAYOUT);
const pct = x => (x == null ? '  -  ' : (x * 100).toFixed(1).padStart(5) + '%');
const wait = ms => new Promise(r => setTimeout(r, ms));
// moedas cotadas contra o dólar: sinal de quanto o par sobe quando o DÓLAR sobe
const USD = { frxEURUSD: -1, frxGBPUSD: -1, frxAUDUSD: -1, frxNZDUSD: -1, frxUSDJPY: 1, frxUSDCAD: 1, frxUSDCHF: 1 };

(async () => {
  const sock = deriv.publicSocket(); await sock.connect();
  const data = {};
  for (const s of SYMS) {
    try { data[s] = await fetchHistory(sock, s, G, 2, p => p.waitingMs && console.log(`  (aguardando ${p.waitingMs / 1000} s)`), 10000); console.log(`${NM(s)}: ${data[s].length} velas`); }
    catch (e) { console.log(`${NM(s)}: PULADO ${e.message}`); }
    await wait(2500);
  }
  sock.close();

  // alinha por horário: só instantes presentes em todos os ativos
  const syms = Object.keys(data);
  const maps = Object.fromEntries(syms.map(s => [s, new Map(data[s].map(c => [c.epoch, c]))]));
  const T = [...maps[syms[0]].keys()].filter(t => syms.every(s => maps[s].has(t))).sort((a, b) => a - b);
  console.log(`\n${T.length} instantes comuns de 5 min (${new Date(T[0] * 1000).toISOString().slice(0, 10)} a ${new Date(T.at(-1) * 1000).toISOString().slice(0, 10)})`);
  const cl = s => T.map(t => maps[s].get(t).close);
  const C = Object.fromEntries(syms.map(s => [s, cl(s)]));
  const ret = (s, i, k) => (i - k >= 0 ? Math.log(C[s][i] / C[s][i - k]) : null);
  const fut = (s, i) => (i + H < T.length && T[i + H] - T[i] === H * G ? Math.sign(C[s][i + H] - C[s][i]) : 0);   // 0 = empate ou lacuna
  const split = Math.floor(T.length * 0.6);
  const usdIdx = (i, k) => { let v = 0, n = 0; for (const [s, w] of Object.entries(USD)) if (C[s]) { const r = ret(s, i, k); if (r != null) { v += w * r; n++; } } return n ? v / n : null; };
  const sd = (s, k) => { const xs = []; for (let i = k; i < split; i++) xs.push(ret(s, i, k)); const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };

  // regra genérica: f(i) devolve +1/−1 (lado do preditor) ou 0 (fora da regra). Treino escolhe se segue ou inverte.
  const rules = [];
  function test(nome, alvo, f) {
    let tn = 0, tw = 0;
    for (let i = 20; i < split - H; i++) { const x = f(i); if (!x) continue; const y = fut(alvo, i); if (!y) continue; tn++; if (x === y) tw++; }
    if (tn < 150) return;
    const seguir = tw / tn >= 0.5, trainRate = seguir ? tw / tn : 1 - tw / tn;
    let n = 0, w = 0, next = -1;
    for (let i = split + 20; i < T.length - H; i++) {
      if (i < next) continue; const x = f(i); if (!x) continue; const y = fut(alvo, i); if (!y) continue;
      n++; if ((seguir ? x : -x) === y) w++; next = i + H;                    // sem sobreposição
    }
    if (n < 30) return;
    rules.push({ nome, alvo, seguir, trainRate, n, w, rate: w / n, p50: R.binomTailP(w, n, 0.5), pBE: R.binomTailP(w, n, BE) });
  }

  for (const a of syms) {
    // A) lead-lag: retorno da última vela de cada outro ativo e do índice do dólar
    for (const b of syms) if (b !== a) test(`A: última vela de ${NM(b)}`, a, i => Math.sign(ret(b, i, 1) || 0));
    if (USD[a] || a === 'frxXAUUSD') test('A: índice do dólar (últimas 3 velas)', a, i => Math.sign(usdIdx(i, 3) || 0) * (USD[a] || -1));
    // A2) divergência: o par andou contra o índice do dólar → volta a acompanhar?
    if (USD[a]) test('A: divergência do par vs. dólar (3 velas)', a, i => { const u = usdIdx(i, 3), r = ret(a, i, 3); if (u == null || r == null) return 0; const d = r - USD[a] * u; return Math.abs(d) > 1.5 * sd(a, 3) ? -Math.sign(d) : 0; });
    // B) extremos
    for (const k of [1, 3, 12]) { const s = sd(a, k); for (const z of [2, 3]) test(`B: movimento de ${z}σ em ${k} vela(s)`, a, i => { const r = ret(a, i, k); return r != null && Math.abs(r) > z * s ? Math.sign(r) : 0; }); }
    // C) horário × dia da semana
    for (let h = 0; h < 24; h++) test(`C: ${String(h).padStart(2, '0')}h UTC`, a, i => (new Date(T[i] * 1000).getUTCHours() === h ? 1 : 0));
    for (let d = 1; d <= 5; d++) test(`C: dia ${['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][d]}`, a, i => (new Date(T[i] * 1000).getUTCDay() === d ? 1 : 0));
  }

  // D) convergência: modelo do app (treinado só no período de treino) + dólar + extremo concordando
  const conv = [];
  for (const a of Object.keys(USD)) {
    const cs = T.map(t => maps[a].get(t)), m = P.buildModel(cs.slice(0, split), H), s3 = sd(a, 3);
    let n = 0, w = 0, next = -1;
    for (let i = split + 40; i < T.length - H; i++) {
      if (i < next) continue; const y = fut(a, i); if (!y) continue;
      const e = P.estimate(m, cs, i, 40); if (!e || e.p < 0.55) continue;
      const dm = e.direction === 'CALL' ? 1 : -1, du = Math.sign(usdIdx(i, 3) || 0) * USD[a], r = ret(a, i, 3);
      const rev = Math.abs(r) > 2 * s3 ? -Math.sign(r) : 0;
      if (dm === du && (rev === 0 || rev === dm)) { n++; if (dm === y) w++; next = i + H; }
    }
    if (n >= 20) conv.push({ nome: 'D: modelo + dólar + extremos concordando', alvo: a, n, w, rate: w / n, p50: R.binomTailP(w, n, 0.5), pBE: R.binomTailP(w, n, BE) });
  }

  const all = rules.concat(conv);
  const ok50 = R.benjaminiHochberg(all.map(r => r.p50), 0.1), okBE = R.benjaminiHochberg(all.map(r => r.pBE), 0.1);
  all.forEach((r, i) => { r.sig50 = ok50.has(i); r.sigBE = okBE.has(i); });
  const byCat = {};
  for (const r of all) { const k = r.nome.slice(0, 1); const b = byCat[k] = byCat[k] || { regras: 0, n: 0, w: 0 }; b.regras++; b.n += r.n; b.w += r.w; }
  console.log(`\nRegras testadas fora da amostra: ${all.length} · payout ${pct(PAYOUT)} → empate ${pct(BE)}`);
  for (const [k, b] of Object.entries(byCat)) console.log(`  ${({ A: 'A) cruzamento entre ativos', B: 'B) extremos estatísticos', C: 'C) horário/dia', D: 'D) convergência' })[k].padEnd(28)} ${String(b.regras).padStart(4)} regras · ${String(b.n).padStart(6)} op · acerto ${pct(b.w / b.n)}`);
  console.log('\nMelhores 12 por acerto no teste (só para inspeção — o ranking em si é viés de seleção):');
  for (const r of all.slice().sort((x, y) => y.rate - x.rate).slice(0, 12))
    console.log(`  ${NM(r.alvo).padEnd(8)} ${r.nome.padEnd(44)} ${r.seguir === false ? '(inverte)' : '         '} ${String(r.n).padStart(4)} op ${pct(r.rate)} | p vs 50% ${r.p50.toFixed(4)} ${r.sig50 ? '✓' : ' '} | p vs empate ${r.pBE.toFixed(4)} ${r.sigBE ? '✓' : ' '}`);
  const s50 = all.filter(r => r.sig50), sBE = all.filter(r => r.sigBE);
  console.log(`\nSignificativas após correção (FDR 10%): acima de 50% → ${s50.length}${s50.length ? ' (' + s50.map(r => NM(r.alvo) + ' ' + r.nome + ' ' + pct(r.rate)).join('; ') + ')' : ''}`);
  console.log(`                                      acima do EMPATE (${pct(BE)}) → ${sBE.length}${sBE.length ? ' (' + sBE.map(r => NM(r.alvo) + ' ' + r.nome).join('; ') + ')' : ''}`);
})().catch(e => { console.error('falhou:', e.message); process.exit(1); });
