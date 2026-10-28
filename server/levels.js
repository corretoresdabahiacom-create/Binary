'use strict';
// Suporte e resistência por fractais (topos/fundos com k velas de cada lado), agrupados por proximidade
// (0,5 × ATR). Cada nível tem preço, nº de toques e se está acima (resistência) ou abaixo (suporte).
// Só usa velas FECHADAS até i (sem dados futuros): um fractal só é confirmado k velas depois.
const { atr } = require('./indicators');

function levels(candles, i = candles.length - 1, { lookback = 300, k = 3, max = 6 } = {}) {
  const from = Math.max(0, i - lookback);
  const win = candles.slice(from, i + 1);
  if (win.length < 2 * k + 20) return { levels: [], atr: null };
  const a = atr(win, 14).at(-1) || 0;
  if (!a) return { levels: [], atr: null };
  const pts = [];
  for (let j = k; j < win.length - k; j++) {          // fractal confirmado: j + k ≤ última vela
    let hi = true, lo = true;
    for (let d = 1; d <= k; d++) {
      // empate à esquerda é aceito (máximas iguais são comuns); à direita precisa ser estrito
      if (win[j].high < win[j - d].high || win[j].high <= win[j + d].high) hi = false;
      if (win[j].low > win[j - d].low || win[j].low >= win[j + d].low) lo = false;
    }
    if (hi) pts.push({ price: win[j].high, epoch: win[j].epoch });
    if (lo) pts.push({ price: win[j].low, epoch: win[j].epoch });
  }
  pts.sort((x, y) => x.price - y.price);
  const groups = [];
  for (const p of pts) {
    const g = groups.at(-1);
    // agrupa toques próximos, sem encadear uma faixa larga demais
    if (g && p.price - g.prices.at(-1) <= 0.5 * a && p.price - g.prices[0] <= 1.0 * a) { g.prices.push(p.price); g.last = Math.max(g.last, p.epoch); }
    else groups.push({ prices: [p.price], last: p.epoch });
  }
  const price = win.at(-1).close;
  const out = groups.filter(g => g.prices.length >= 2)
    .map(g => { const lv = g.prices.reduce((s, x) => s + x, 0) / g.prices.length; return { price: lv, touches: g.prices.length, last: g.last, type: lv >= price ? 'resistencia' : 'suporte' }; })
    .sort((x, y) => Math.abs(x.price - price) - Math.abs(y.price - price));
  const half = Math.ceil(max / 2);                         // os mais próximos de cada lado
  const pick = [...out.filter(l => l.type === 'resistencia').slice(0, half), ...out.filter(l => l.type === 'suporte').slice(0, half)];
  return { levels: pick, atr: a, price };
}

// Espaço livre até o nível oposto na direção da operação, em ATRs (limite 3). Pouco espaço = pior.
function room(lv, dir) {
  if (!lv || !lv.atr) return 1.5;
  const opp = lv.levels.filter(l => (dir === 'CALL' ? l.price > lv.price : l.price < lv.price));
  if (!opp.length) return 3;
  const d = Math.min(...opp.map(l => Math.abs(l.price - lv.price))) / lv.atr;
  return Math.min(3, d);
}

module.exports = { levels, room };
