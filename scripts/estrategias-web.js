'use strict';
// Testa, com velas reais de 15 min da Deriv, as "estratégias" mais vendidas na internet para opções
// binárias/Rise-Fall, em dinheiro fixo e com martingale (payout real ~78%, empate ≈ 56,2%).
// Entrada no fechamento da vela i, resultado no fechamento da vela i+1 (≈ expiração de 15 min).
const deriv = require('../server/deriv');
const { fetchHistory } = require('../server/catalog');
const R = require('../server/research');
const SYMS = (process.argv[2] || 'frxEURUSD,frxGBPUSD,frxUSDJPY,frxAUDUSD').split(',');
const PAY = 0.78, BE = 1 / (1 + PAY);
const pct = x => (x * 100).toFixed(1).padStart(5) + '%';
const ema = (a, n) => { const k = 2 / (n + 1); const o = []; let e = a[0]; for (const v of a) { e = v * k + e * (1 - k); o.push(e); } return o; };
function rsi(c, n = 14) { const o = new Array(c.length).fill(null); let g = 0, l = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; if (i <= n) { g += Math.max(d, 0); l += Math.max(-d, 0); if (i === n) { g /= n; l /= n; o[i] = 100 - 100 / (1 + g / (l || 1e-12)); } } else { g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; o[i] = 100 - 100 / (1 + g / (l || 1e-12)); } } return o; }
function strategies(cs) {
  const c = cs.map(x => x.close), e9 = ema(c, 9), e21 = ema(c, 21), e50 = ema(c, 50), r = rsi(c);
  const sma = (i, n) => c.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n;
  const sd = (i, n) => { const m = sma(i, n); return Math.sqrt(c.slice(i - n + 1, i + 1).reduce((a, b) => a + (b - m) ** 2, 0) / n); };
  const body = i => cs[i].close - cs[i].open, rng = i => cs[i].high - cs[i].low;
  return {
    'seguir cor da última vela': i => Math.sign(body(i)),
    'contra a cor da última vela': i => -Math.sign(body(i)),
    'RSI 30/70 (reversão)': i => (r[i] < 30 ? 1 : r[i] > 70 ? -1 : 0),
    'RSI 30/70 (continuação)': i => (r[i] < 30 ? -1 : r[i] > 70 ? 1 : 0),
    'Bollinger 20,2 (reversão)': i => { const m = sma(i, 20), s = sd(i, 20); return c[i] < m - 2 * s ? 1 : c[i] > m + 2 * s ? -1 : 0; },
    'cruzamento EMA 9/21': i => (e9[i - 1] <= e21[i - 1] && e9[i] > e21[i] ? 1 : e9[i - 1] >= e21[i - 1] && e9[i] < e21[i] ? -1 : 0),
    'tendência EMA 9>21>50': i => (e9[i] > e21[i] && e21[i] > e50[i] ? 1 : e9[i] < e21[i] && e21[i] < e50[i] ? -1 : 0),
    'engolfo (price action)': i => { const b = body(i), p = body(i - 1); return b > 0 && p < 0 && cs[i].close > cs[i - 1].open && cs[i].open < cs[i - 1].close ? 1 : b < 0 && p > 0 && cs[i].close < cs[i - 1].open && cs[i].open > cs[i - 1].close ? -1 : 0; },
    'pavio longo (pin bar)': i => { const t = cs[i].high - Math.max(cs[i].open, cs[i].close), b = Math.min(cs[i].open, cs[i].close) - cs[i].low; return rng(i) > 0 && t / rng(i) > 0.6 ? -1 : rng(i) > 0 && b / rng(i) > 0.6 ? 1 : 0; },
    'rompimento da máxima/mínima de 20': i => { const h = Math.max(...cs.slice(i - 20, i).map(x => x.high)), l = Math.min(...cs.slice(i - 20, i).map(x => x.low)); return c[i] > h ? 1 : c[i] < l ? -1 : 0; },
    '3 velas iguais → inverter': i => (Math.sign(body(i)) === Math.sign(body(i - 1)) && Math.sign(body(i)) === Math.sign(body(i - 2)) ? -Math.sign(body(i)) : 0),
  };
}
// martingale: dobra (×(1+1/PAY) para recuperar tudo) após perda; bankroll 100 un., aposta base 1 un., até 5 níveis
function martingale(trades) {
  let bank = 100, ruins = 0, nivel = 0, perdido = 0, lucro = 0, maxNivel = 0, ops = 0;
  for (const [x, y] of trades) {
    const stake = Math.min(bank, perdido > 0 ? (perdido + 1) / PAY : 1);
    if (stake <= 0) { ruins++; bank = 100; perdido = 0; nivel = 0; continue; }
    ops++;
    if (x === y) { bank += stake * PAY; perdido = 0; nivel = 0; } else { bank -= stake; perdido += stake; nivel++; maxNivel = Math.max(maxNivel, nivel); if (nivel >= 5) { perdido = 0; nivel = 0; } }
    if (bank < 1) { ruins++; bank = 100; perdido = 0; nivel = 0; }
  }
  return { ops, ruinas: ruins, bancaFinal: bank, maxNivel };
}
(async () => {
  const sock = deriv.publicSocket(); await sock.connect();
  const all = {};
  for (const s of SYMS) {
    let cs; try { cs = await fetchHistory(sock, s, 900, 2, () => {}, 10000); } catch (e) { console.log(s, 'PULADO', e.message); continue; }
    console.log(`${s}: ${cs.length} velas`);
    const st = strategies(cs);
    for (const [nome, f] of Object.entries(st)) { const a = all[nome] = all[nome] || { n: 0, w: 0, tr: [] };
      for (let i = 60; i < cs.length - 1; i++) { const x = f(i); if (!x) continue; const y = Math.sign(cs[i + 1].close - cs[i].close); if (!y) continue; a.n++; if (x === y) a.w++; a.tr.push([x, y]); } }
    await new Promise(r => setTimeout(r, 3000));
  }
  sock.close();
  const rows = Object.entries(all).map(([nome, a]) => ({ nome, ...a, rate: a.w / a.n, p50: R.binomTailP(a.w, a.n, 0.5), pBE: R.binomTailP(a.w, a.n, BE) }));
  const ok = R.benjaminiHochberg(rows.map(r => r.pBE), 0.1);
  console.log(`\nPayout ${pct(PAY)} → empate ${pct(BE)}. Dinheiro fixo (todas as operações, ${SYMS.length} pares):`);
  rows.forEach((r, i) => console.log(`  ${r.nome.padEnd(36)} ${String(r.n).padStart(6)} op  acerto ${pct(r.rate)}  resultado por R$1 apostado ${(r.rate * PAY - (1 - r.rate)).toFixed(3).padStart(7)}  p(>empate)=${r.pBE.toFixed(3)} ${ok.has(i) ? '✓' : ''}`));
  console.log('\nMARTINGALE (banca 100, aposta base 1, recupera tudo, máx. 5 níveis; "ruína" = banca < 1 → recomeça):');
  for (const r of rows) { const m = martingale(r.tr); console.log(`  ${r.nome.padEnd(36)} ${String(m.ops).padStart(6)} op  ruínas ${String(m.ruinas).padStart(3)}  banca final ${m.bancaFinal.toFixed(0).padStart(5)}  nível máx ${m.maxNivel}`); }
  console.log(`\nSignificativas acima do empate após correção (FDR 10%): ${ok.size}`);
})().catch(e => { console.error('falhou:', e.message); process.exit(1); });
