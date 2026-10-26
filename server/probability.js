'use strict';
// Probabilidade empírica de alta/baixa no horizonte da expiração.
// Para cada vela histórica j, o "estado" técnico é discretizado (RSI, tendência EMA, momento MACD,
// posição nas Bandas de Bollinger) e o resultado é close[j+h] vs close[j] (entrada no fechamento de j).
// A estimativa do estado atual usa SOMENTE velas cujo resultado já era conhecido (sem dados futuros).
// Se o estado exato tem poucas amostras, recua para estados mais grossos e, no fim, para a taxa base.
const { computeSeries, snapshot } = require('./indicators');

const MODEL = 'prob-estado-v1';
const WARMUP = 35;

function stateOf(s) {
  if (s.rsi == null || s.emaTrend == null || s.macdHist == null || s.macdHistPrev == null || s.bbPos == null) return null;
  const rsi = s.rsi < 30 ? 'r0' : s.rsi < 45 ? 'r1' : s.rsi <= 55 ? 'r2' : s.rsi <= 70 ? 'r3' : 'r4';
  const ema = s.emaTrend === 'alta' ? 'eA' : 'eB';
  const mac = s.macdHist > s.macdHistPrev ? 'm+' : s.macdHist < s.macdHistPrev ? 'm-' : 'm0';
  const bb = s.bbPos < 0.2 ? 'b0' : s.bbPos > 0.8 ? 'b2' : 'b1';
  return [`${rsi}|${ema}|${mac}|${bb}`, `${rsi}|${ema}|${mac}`, `${rsi}|${ema}`, 'base'];
}

const LEVELS = ['estado completo', 'RSI+EMA+MACD', 'RSI+EMA', 'taxa base'];

function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}

// Constrói as contagens a partir de velas FECHADAS. horizon = número de velas até a expiração.
function buildModel(candles, horizon) {
  const series = computeSeries(candles);
  const table = new Map();
  let ties = 0, used = 0;
  for (let j = WARMUP; j + horizon < candles.length; j++) {
    const keys = stateOf(snapshot(candles, series, j));
    if (!keys) continue;
    const d = candles[j + horizon].close - candles[j].close;
    if (d === 0) { ties++; continue; }           // empate não conta como acerto nem erro
    used++;
    for (const k of keys) { const t = table.get(k) || { up: 0, n: 0 }; t.n++; if (d > 0) t.up++; table.set(k, t); }
  }
  return { model: MODEL, horizon, table, samples: used, ties, from: candles[0] && candles[0].epoch, to: candles.at(-1) && candles.at(-1).epoch };
}

// Estima P(alta) para o estado da vela i de `candles` (pode ser a vela em formação).
function estimate(m, candles, i, minSamples = 40) {
  if (!m) return null;
  const from = Math.max(0, i - 120);              // janela curta: barato para rodar a cada tick
  const win = candles.slice(from, i + 1);
  const keys = stateOf(snapshot(win, computeSeries(win), win.length - 1));
  if (!keys) return null;
  for (let l = 0; l < keys.length; l++) {
    const t = m.table.get(keys[l]);
    if (!t || (t.n < minSamples && l < keys.length - 1)) continue;
    const pUp = (t.up + 1) / (t.n + 2);          // suavização de Laplace
    const dir = pUp >= 0.5 ? 'CALL' : 'PUT';
    const k = dir === 'CALL' ? t.up : t.n - t.up;
    const [lo, hi] = wilson(k, t.n);
    return { pCall: pUp, pPut: 1 - pUp, direction: dir, p: Math.max(pUp, 1 - pUp), lo, hi, n: t.n, level: LEVELS[l], state: keys[0], model: MODEL, horizon: m.horizon };
  }
  return null;
}

module.exports = { buildModel, estimate, stateOf, wilson, MODEL };
