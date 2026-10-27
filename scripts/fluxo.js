'use strict';
// "Tape reading" possível na Deriv: a API pública dá só o PREÇO de cada tick (sem volume, sem lado agressor,
// sem livro de ofertas). Medimos o fluxo pela regra do tick: tick de alta (+1) / de baixa (−1).
// Pergunta: o fluxo recente prevê a direção em 15 min? E melhora o modelo do app quando concorda com ele?
// Decisões a cada fechamento de vela de 15 min; alvo = preço 15 min depois. Regra/direção escolhidas nos
// primeiros 60% do período; avaliação nos 40% finais (sem sobreposição). Benjamini-Hochberg.
// Uso: node scripts/fluxo.js [pares] [maxTicksPorPar]
const deriv = require('../server/deriv');
const { fetchHistory } = require('../server/catalog');
const R = require('../server/research');
const P = require('../server/probability');

const SYMS = (process.argv[2] || 'frxEURUSD,frxGBPUSD,frxUSDJPY,frxAUDUSD,frxUSDCAD,frxEURJPY').split(',');
const MAXT = +(process.argv[3] || 250000);
const STEP = 900, H = 900, PAYOUT = 0.78, BE = 1 / (1 + PAYOUT);
const NM = s => s.replace('frx', '').replace(/(...)(...)/, '$1/$2');
const pct = x => (x == null ? '  -  ' : (x * 100).toFixed(1).padStart(5) + '%');
const wait = ms => new Promise(r => setTimeout(r, ms));

// ticks gravados pelo monitor (data/ticks/<ativo>-<dia>.csv)
function localTicks(sym) {
  const fs = require('fs'), path = require('path'), dir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'ticks');
  const m = new Map();
  try { for (const f of fs.readdirSync(dir).filter(f => f.startsWith(sym + '-')).sort()) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { const [e, q] = l.split(','); if (e && q) m.set(+e, +q); } } catch {}
  return m;
}

async function fetchTicks(sock, sym, max) {
  let end = 'latest', t = [], p = [];
  while (t.length < max) {
    let res;
    for (let k = 0; ; k++) {
      try { res = await sock.send({ ticks_history: sym, style: 'ticks', count: 5000, end }, { timeoutMs: 30000 }); break; }
      catch (e) { if (!/rate limit/i.test(e.message) || k >= 8) throw e; const w = Math.min(120000, 15000 * (k + 1)); console.log(`  (aguardando ${w / 1000} s: limite da Deriv)`); await wait(w); }
    }
    const h = res.history || {}, tt = h.times || [], pp = h.prices || [];
    if (!tt.length || (end !== 'latest' && tt[0] >= +end)) break;
    t = tt.map(Number).concat(t); p = pp.map(Number).concat(p);
    end = String(tt[0] - 1);
    await wait(1200);
  }
  return { t, p };
}

// índice do último tick com tempo ≤ x (busca binária)
function at(t, x) { let lo = 0, hi = t.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] <= x) { r = m; lo = m + 1; } else hi = m - 1; } return r; }

(async () => {
  const sock = deriv.publicSocket(); await sock.connect();
  const rows = [], perPair = {};
  for (const sym of SYMS) {
    let tk, cs;
    try {
      tk = await fetchTicks(sock, sym, MAXT); cs = await fetchHistory(sock, sym, 900, 2, () => {}, 10000);
      const m = localTicks(sym); const before = m.size; for (let i = 0; i < tk.t.length; i++) m.set(tk.t[i], tk.p[i]);
      const ks = [...m.keys()].sort((a, b) => a - b); tk = { t: ks, p: ks.map(k => m.get(k)) };
      if (before) console.log(`  + ${before} ticks gravados localmente`);
    }
    catch (e) { console.log(`${NM(sym)}: PULADO ${e.message}`); continue; }
    await wait(2000);
    const { t, p } = tk;
    // regra do tick: sinal da variação; sem variação herda o último sinal
    const sg = new Int8Array(t.length); for (let i = 1; i < t.length; i++) { const d = p[i] - p[i - 1]; sg[i] = d > 0 ? 1 : d < 0 ? -1 : sg[i - 1]; }
    const cum = new Float64Array(t.length + 1); for (let i = 0; i < t.length; i++) cum[i + 1] = cum[i] + sg[i];
    const dias = (t.at(-1) - t[0]) / 86400;
    console.log(`${NM(sym)}: ${t.length} ticks em ${dias.toFixed(1)} dias (${(t.length / Math.max(1, (t.at(-1) - t[0]) / 60)).toFixed(1)} ticks/min) + ${cs.length} velas de 15 min`);
    // modelo do app treinado em velas ANTERIORES ao período dos ticks (nada de dado futuro)
    const firstTick = t[0], ci0 = cs.findIndex(c => c.epoch + 900 > firstTick);
    const model = ci0 > 500 ? P.buildModel(cs.slice(0, ci0), 1) : null;
    const cIdx = new Map(cs.map((c, i) => [c.epoch, i]));
    const ex = [];
    const start = Math.ceil((t[0] + 900) / STEP) * STEP;
    for (let d = start; d + H <= t.at(-1); d += STEP) {
      const i0 = at(t, d), i1 = at(t, d + H); if (i0 < 0 || i1 <= i0) continue;
      if (d - t[i0] > 60 || d + H - t[i1] > 60) continue;              // mercado parado / sem ticks
      const y = Math.sign(p[i1] - p[i0]); if (!y) continue;
      const f = {};
      for (const W of [60, 300, 900]) {
        const j = at(t, d - W); if (j < 0) { f.ok = false; break; }
        const n = i0 - j; f['n' + W] = n; f['imb' + W] = n ? (cum[i0 + 1] - cum[j + 1]) / n : 0; f['ret' + W] = p[i0] - p[j];
      }
      if (f.ok === false) continue;
      let mdl = null;
      const ci = cIdx.get(d - 900);                                     // vela de 15 min que fechou em d
      if (model && ci != null && ci >= 40) { const e = P.estimate(model, cs, ci, 40); if (e) mdl = e.direction === 'CALL' ? 1 : -1; }
      ex.push({ d, y, f, mdl });
    }
    perPair[sym] = ex.length;
    const split = Math.floor(ex.length * 0.6), tr = ex.slice(0, split), te = ex.slice(split);
    const q = (arr, k) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(k * (s.length - 1))]; };
    const add = (nome, fn) => {
      let n = 0, w = 0; for (const x of tr) { const s = fn(x); if (!s) continue; n++; if (s === x.y) w++; }
      if (n < 40) return; const seguir = w / n >= 0.5;
      let tn = 0, tw = 0; for (const x of te) { const s = fn(x); if (!s) continue; tn++; if ((seguir ? s : -s) === x.y) tw++; }
      if (tn < 20) return;
      rows.push({ sym, nome, seguir, trainRate: seguir ? w / n : 1 - w / n, n: tn, w: tw, rate: tw / tn, p50: R.binomTailP(tw, tn, 0.5), pBE: R.binomTailP(tw, tn, BE) });
    };
    for (const W of [60, 300, 900]) {
      const th = q(tr.map(x => Math.abs(x.f['imb' + W])), 0.75), tn = q(tr.map(x => x.f['n' + W]), 0.75);
      add(`fluxo ${W / 60} min (sinal)`, x => Math.sign(x.f['imb' + W]));
      add(`fluxo ${W / 60} min forte (quartil superior)`, x => (Math.abs(x.f['imb' + W]) >= th ? Math.sign(x.f['imb' + W]) : 0));
      add(`fluxo ${W / 60} min forte + muitos ticks`, x => (Math.abs(x.f['imb' + W]) >= th && x.f['n' + W] >= tn ? Math.sign(x.f['imb' + W]) : 0));
      add(`fluxo ${W / 60} min contra o preço (absorção)`, x => (Math.sign(x.f['imb' + W]) && Math.sign(x.f['imb' + W]) !== Math.sign(x.f['ret' + W]) ? Math.sign(x.f['imb' + W]) : 0));
    }
    add('fluxo 1 min concorda com 15 min', x => (Math.sign(x.f.imb60) === Math.sign(x.f.imb900) ? Math.sign(x.f.imb60) : 0));
    // o fluxo melhora o modelo do app?
    const cmp = (sel) => { let n = 0, w = 0; for (const x of te) { if (!x.mdl || !sel(x)) continue; n++; if (x.mdl === x.y) w++; } return { n, w }; };
    const a = cmp(() => true), c = cmp(x => Math.sign(x.f.imb300) === x.mdl), dz = cmp(x => Math.sign(x.f.imb300) === -x.mdl);
    rows.push({ sym, nome: 'MODELO DO APP sozinho', n: a.n, w: a.w, rate: a.n ? a.w / a.n : null, p50: R.binomTailP(a.w, a.n, 0.5), pBE: R.binomTailP(a.w, a.n, BE), comparacao: true });
    rows.push({ sym, nome: 'MODELO + fluxo 5 min concordando', n: c.n, w: c.w, rate: c.n ? c.w / c.n : null, p50: R.binomTailP(c.w, c.n, 0.5), pBE: R.binomTailP(c.w, c.n, BE), comparacao: true });
    rows.push({ sym, nome: 'MODELO com fluxo 5 min discordando', n: dz.n, w: dz.w, rate: dz.n ? dz.w / dz.n : null, p50: R.binomTailP(dz.w, dz.n, 0.5), pBE: R.binomTailP(dz.w, dz.n, BE), comparacao: true });
  }
  sock.close();
  const rules = rows.filter(r => !r.comparacao && r.n);
  const ok50 = R.benjaminiHochberg(rules.map(r => r.p50), 0.1), okBE = R.benjaminiHochberg(rules.map(r => r.pBE), 0.1);
  rules.forEach((r, i) => { r.sig50 = ok50.has(i); r.sigBE = okBE.has(i); });
  console.log(`\nDecisões avaliadas por par (a cada 15 min): ${Object.entries(perPair).map(([s, n]) => NM(s) + ' ' + n).join(' · ')}`);
  console.log(`Payout ${pct(PAYOUT)} → empate ${pct(BE)}\n`);
  const agg = sel => { let n = 0, w = 0; for (const r of rows) if (sel(r)) { n += r.n; w += r.w; } return `${String(n).padStart(5)} op ${pct(n ? w / n : null)}`; };
  console.log('REGRAS DE FLUXO (todas somadas):      ' + agg(r => !r.comparacao));
  console.log('MODELO DO APP sozinho:                ' + agg(r => r.nome === 'MODELO DO APP sozinho'));
  console.log('MODELO + fluxo 5 min concordando:     ' + agg(r => r.nome === 'MODELO + fluxo 5 min concordando'));
  console.log('MODELO com fluxo 5 min discordando:   ' + agg(r => r.nome === 'MODELO com fluxo 5 min discordando'));
  console.log('\nMelhores 10 regras no teste (inspeção; o ranking é viés de seleção):');
  for (const r of rules.slice().sort((a, b) => b.rate - a.rate).slice(0, 10))
    console.log(`  ${NM(r.sym).padEnd(8)} ${r.nome.padEnd(38)} ${r.seguir ? '        ' : '(inverte)'} ${String(r.n).padStart(4)} op ${pct(r.rate)} | p vs 50% ${r.p50.toFixed(3)} ${r.sig50 ? '✓' : ' '} | p vs empate ${r.pBE.toFixed(3)} ${r.sigBE ? '✓' : ' '}`);
  console.log(`\nSignificativas após correção (FDR 10%): acima de 50% → ${rules.filter(r => r.sig50).length} · acima do empate → ${rules.filter(r => r.sigBE).length} (de ${rules.length} regras)`);
})().catch(e => { console.error('falhou:', e.message); process.exit(1); });
