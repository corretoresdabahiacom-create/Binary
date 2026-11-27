'use strict';
// "Decorar as velas": memória de padrões + análise contrária, com aprendizado contínuo e SEM dado futuro.
// A cada vela fechada o app olha as últimas N velas, procura o mesmo formato no passado (só o que já aconteceu) e vê o que veio depois.
// O lado (a favor ou CONTRA a última vela) sai dos dados: segue a maioria histórica daquele padrão.
// Entra só se o padrão já apareceu ≥ minN vezes e a maioria histórica ≥ thr. Duas famílias:
//  A) memória exata por forma (cor / cor+tamanho / forma completa com pavios), N = 2..5
//  B) vizinhos mais parecidos (k-NN) sobre as últimas 6 velas normalizadas.
// Aprendizado: início = 60% do histórico só treina; os 40% finais são avaliados vela a vela, aprendendo conforme avança.
// Resultado = direção da vela seguinte (entrada no fechamento, expiração 1 vela). p-valor contra o empate (payout 78%) + Benjamini-Hochberg.
const R = require('../server/research');
const SYMS = (process.argv[2] || 'frxEURUSD,frxGBPUSD,frxUSDJPY,frxAUDUSD,frxUSDCAD,frxUSDCHF,frxNZDUSD,frxEURGBP,frxEURJPY,frxGBPJPY').split(',');
const GRAN = +(process.argv[3] || 900);
let PAY = 0.78; const BE = 1 / (1 + PAY), NM = s => s.replace('frx', '').replace(/(...)(...)/, '$1/$2');
const pct = x => (x == null ? '  -  ' : (x * 100).toFixed(1).padStart(5) + '%');

function synth(n, seed = 7) { let s = seed, r = () => (s = (s * 16807) % 2147483647) / 2147483647, p = 1, t = 1700000000, o = []; for (let i = 0; i < n; i++) { const op = p; let h = op, l = op; for (let k = 0; k < 20; k++) { p *= 1 + (r() - 0.5) * 0.0006; h = Math.max(h, p); l = Math.min(l, p); } o.push({ epoch: t += GRAN, open: op, high: h, low: l, close: p }); } return o; }

function atr(cs) { const a = new Array(cs.length).fill(null); let s = 0; for (let i = 1; i < cs.length; i++) { const tr = Math.max(cs[i].high - cs[i].low, Math.abs(cs[i].high - cs[i - 1].close), Math.abs(cs[i].low - cs[i - 1].close)); if (i <= 14) { s += tr; if (i === 14) a[i] = s / 14; } else a[i] = (a[i - 1] * 13 + tr) / 14; } return a; }
const sizeB = (b, A) => { const x = Math.abs(b) / A; return x < 0.3 ? 0 : x < 0.8 ? 1 : 2; };
function code(cs, i, A, scheme) {
  const c = cs[i], b = c.close - c.open, sg = b > 0 ? 1 : b < 0 ? -1 : 0, rg = (c.high - c.low) || 1e-12;
  if (scheme === 0) return sg + 1;
  const sz = sizeB(b, A);
  if (scheme === 1) return (sg + 1) * 3 + sz;
  const up = (c.high - Math.max(c.open, c.close)) / rg > 0.4 ? 1 : 0, lo = (Math.min(c.open, c.close) - c.low) / rg > 0.4 ? 1 : 0;
  return (((sg + 1) * 3 + sz) * 2 + up) * 2 + lo;
}
const wil = (w, n) => { if (!n) return 0; const z = 1.645, p = w / n, d = 1 + z * z / n; return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d; };

(async () => {
  const data = {};
  if (process.env.SYNTH) for (const s of SYMS) data[s] = synth(6000, s.length * 13);
  else {
    const deriv = require('../server/deriv'), { fetchHistory } = require('../server/catalog'); const sock = deriv.publicSocket(); await sock.connect();
    for (const s of SYMS) { try { data[s] = await fetchHistory(sock, s, GRAN, 2, () => {}, 10000); console.log(`${NM(s)}: ${data[s].length} velas (${((data[s].at(-1).epoch - data[s][0].epoch) / 86400).toFixed(0)} dias)`); } catch (e) { console.log(NM(s), 'PULADO', e.message); } await new Promise(r => setTimeout(r, 2500)); }
    sock.close();
  }
  // payout real por par (Rise/Fall 15 min, proposta da Deriv agora); sem resposta → 78% e marca
  const PAYS = {};
  if (!process.env.SYNTH) { const deriv = require('../server/deriv'); const sock = deriv.publicSocket(); await sock.connect();
    for (const s of Object.keys(data)) { PAYS[s] = { v: 0.78, src: 'padrão' }; try { const r = await sock.send({ proposal: 1, contract_type: 'CALL', underlying_symbol: s, currency: 'USD', amount: 10, basis: 'stake', duration: 15, duration_unit: 'm' }, { timeoutMs: 10000 }); const q = +r.proposal.payout; if (q > 10) PAYS[s] = { v: q / 10 - 1, src: 'Deriv agora' }; } catch (e) { PAYS[s].src = 'padrão (' + e.message.slice(0, 40) + ')'; } await new Promise(r => setTimeout(r, 1500)); }
    sock.close(); } else for (const s of Object.keys(data)) PAYS[s] = { v: 0.78, src: 'sintético' };
  console.log('Payout real por par: ' + Object.entries(PAYS).map(([s, p]) => `${NM(s)} ${pct(p.v)} (${p.src})`).join(' · '));
  const configs = [];
  for (const N of [2, 3, 4, 5]) for (const scheme of [0, 1, 2]) for (const minN of [20, 40]) for (const thr of [0.56, 0.6]) configs.push({ fam: 'A', N, scheme, minN, thr });
  for (const k of [30, 60]) for (const thr of [0.58, 0.62]) configs.push({ fam: 'B', k, thr });
  const res = configs.map(c => ({ ...c, byPair: {}, n: 0, w: 0, contra: 0, nContra: 0 }));
  const base = { n: 0, w: 0 };                      // referência: contra a última vela, sempre
  for (const sym of Object.keys(data)) {
    const cs = data[sym], A = atr(cs), split = Math.floor(cs.length * 0.6), L = cs.length;
    const y = i => Math.sign(cs[i + 1].close - cs[i].close);
    // memória exata: Map chave → [altas, baixas]
    const mem = configs.map(c => c.fam === 'A' ? new Map() : null);
    // vetores para k-NN
    const vec = i => { const v = []; for (let j = 5; j >= 0; j--) { const c = cs[i - j]; v.push((c.close - c.open) / A[i], (c.high - Math.max(c.open, c.close)) / A[i], (Math.min(c.open, c.close) - c.low) / A[i]); } return v; };
    const V = [], Y = [];                            // base de vizinhos (só passado)
    for (let i = 20; i < L - 1; i++) {
      if (A[i] == null || !y(i)) { continue; }
      const yi = y(i), test = i >= split;
      const keys = configs.map((c, ci) => { if (c.fam !== 'A') return null; let k = 0; for (let j = c.N - 1; j >= 0; j--) k = k * 40 + code(cs, i - j, A[i - j] || A[i], c.scheme); return k; });
      const v = vec(i);
      if (test) {
        // decisão ANTES de aprender com a vela i
        const last = Math.sign(cs[i].close - cs[i].open);
        if (last) { base.n++; if (-last === yi) base.w++; }
        configs.forEach((c, ci) => {
          let dir = 0;
          if (c.fam === 'A') { const m = mem[ci].get(keys[ci]); if (m) { const t = m[0] + m[1]; if (t >= c.minN) { const sh = m[0] / t; if (sh >= c.thr) dir = 1; else if (1 - sh >= c.thr) dir = -1; } } }
          else if (V.length > 200) {
            const d = new Float64Array(V.length); for (let q = 0; q < V.length; q++) { let s = 0; const u = V[q]; for (let z = 0; z < 18; z++) { const e = u[z] - v[z]; s += e * e; } d[q] = s; }
            const idx = Array.from(d.keys()).sort((a, b) => d[a] - d[b]).slice(0, c.k); let up = 0; for (const q of idx) if (Y[q] > 0) up++;
            const sh = up / idx.length; dir = sh >= c.thr ? 1 : 1 - sh >= c.thr ? -1 : 0;
          }
          if (dir) { const r = res[ci], p = r.byPair[sym] = r.byPair[sym] || { n: 0, w: 0 }; p.n++; r.n++; if (dir === yi) { p.w++; r.w++; } if (last && dir === -last) { r.nContra++; if (dir === yi) r.contra++; } }
        });
      }
      // aprende com a vela i (resultado conhecido quando i+1 fechou)
      configs.forEach((c, ci) => { if (c.fam === 'A') { const m = mem[ci].get(keys[ci]) || [0, 0]; if (yi > 0) m[0]++; else m[1]++; mem[ci].set(keys[ci], m); } });
      if (!test || true) { V.push(v); Y.push(yi); }
    }
  }
  const rows = res.filter(r => r.n >= 30).map(r => ({ ...r, rate: r.w / r.n, p50: R.binomTailP(r.w, r.n, 0.5), pBE: R.binomTailP(r.w, r.n, BE) }));
  const ok = R.benjaminiHochberg(rows.map(r => r.pBE), 0.1);
  const nm = r => r.fam === 'A' ? `exata N=${r.N} ${['cor', 'cor+tam', 'forma'][r.scheme]} min${r.minN} ≥${r.thr}` : `k-NN k=${r.k} ≥${r.thr}`;
  console.log(`\nPayout ${pct(PAY)} → empate ${pct(BE)} | referência 'contra a última vela' (todas as velas do teste): ${base.n} op ${pct(base.w / base.n)}`);
  console.log(`Configurações com ≥30 operações no teste: ${rows.length} de ${configs.length}. Janela de teste = 40% finais, aprendendo vela a vela.\n`);
  const agg = rows.reduce((a, r) => ({ n: a.n + r.n, w: a.w + r.w, cn: a.cn + r.nContra, cw: a.cw + r.contra }), { n: 0, w: 0, cn: 0, cw: 0 });
  console.log(`TODAS as configurações somadas: ${agg.n} op, acerto ${pct(agg.w / agg.n)} | só as entradas CONTRA a última vela: ${agg.cn} op ${pct(agg.cw / (agg.cn || 1))}`);
  console.log('\nMelhores 12 (só inspeção; ranking = viés de seleção):');
  rows.sort((a, b) => b.rate - a.rate).slice(0, 12).forEach(r => console.log(`  ${nm(r).padEnd(34)} ${String(r.n).padStart(6)} op acerto ${pct(r.rate)} IC90inf ${pct(wil(r.w, r.n))} p(>empate)=${r.pBE.toFixed(4)}`));
  console.log(`\nSignificativas após correção FDR 10%: acima do empate → ${ok.size} (de ${rows.length}). Acima de 50% → ${R.benjaminiHochberg(rows.map(r => r.p50), 0.1).size}`);
  // ---- por par, com o EMPATE DO PRÓPRIO PAR (payout real) ----
  const pc = []; res.forEach(r => Object.entries(r.byPair).forEach(([sym, q]) => { if (q.n >= 30) { const be = 1 / (1 + PAYS[sym].v); pc.push({ sym, nome: nm(r), n: q.n, w: q.w, rate: q.w / q.n, be, pBE: R.binomTailP(q.w, q.n, be), lb: wil(q.w, q.n) }); } }));
  const ok2 = R.benjaminiHochberg(pc.map(x => x.pBE), 0.1);
  console.log(`\n=== POR PAR, empate do próprio par: ${pc.length} combinações par×configuração (≥30 op) ===`);
  for (const sym of Object.keys(PAYS).sort((a, b) => PAYS[b].v - PAYS[a].v)) { const xs = pc.filter(x => x.sym === sym); if (!xs.length) continue; const n = xs.reduce((a, x) => a + x.n, 0), w = xs.reduce((a, x) => a + x.w, 0), be = 1 / (1 + PAYS[sym].v); const best = xs.slice().sort((a, b) => b.lb - a.lb)[0];
    console.log(`  ${NM(sym).padEnd(8)} payout ${pct(PAYS[sym].v)} empate ${pct(be)} | todas as configs: ${String(n).padStart(6)} op acerto ${pct(w / n)} | melhor por IC90inf: ${best.nome} ${best.n} op ${pct(best.rate)} IC90inf ${pct(best.lb)} p=${best.pBE.toFixed(3)}`); }
  const sig = pc.filter((x, i) => ok2.has(i)); console.log(`Significativas acima do empate do próprio par (FDR 10%): ${sig.length} de ${pc.length}${sig.length ? ' → ' + sig.map(x => NM(x.sym) + ' ' + x.nome + ' ' + pct(x.rate) + ' (' + x.n + ' op, empate ' + pct(x.be) + ')').join('; ') : ''}`);
  const hi = pc.filter(x => PAYS[x.sym].v >= 0.85); if (hi.length) { const n = hi.reduce((a, x) => a + x.n, 0), w = hi.reduce((a, x) => a + x.w, 0), eb = hi.reduce((a, x) => a + x.n * x.be, 0) / n; console.log(`Pares com payout ≥85% somados: ${n} op, acerto ${pct(w / n)} vs empate médio ${pct(eb)}`); }
  const pr = {}; rows.forEach(r => Object.entries(r.byPair).forEach(([s, p]) => { const q = pr[s] = pr[s] || { n: 0, w: 0 }; q.n += p.n; q.w += p.w; }));
  console.log('Por par (todas as configs somadas): ' + Object.entries(pr).map(([s, p]) => `${NM(s)} ${pct(p.w / p.n)}`).join(' · '));
})().catch(e => { console.error('falhou:', e.stack); process.exit(1); });
