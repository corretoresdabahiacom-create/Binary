'use strict';
// Indicadores técnicos e padrões de vela. Funções puras, sem dependências.
// Vela: { epoch, open, high, low, close }

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// RSI de Wilder
function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function macd(values, fast = 12, slow = 26, signal = 9) {
  const ef = ema(values, fast), es = ema(values, slow);
  const line = values.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const firstIdx = line.findIndex(v => v != null);
  const sig = new Array(values.length).fill(null);
  if (firstIdx >= 0) {
    const e = ema(line.slice(firstIdx), signal);
    for (let i = 0; i < e.length; i++) sig[firstIdx + i] = e[i];
  }
  const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));
  return { line, signal: sig, hist };
}

function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  let prev = 0;
  for (let i = 1; i <= period; i++) prev += tr[i];
  prev /= period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// ---------- Padrões de vela ----------
const body = c => Math.abs(c.close - c.open);
const range = c => c.high - c.low;
const upper = c => c.high - Math.max(c.open, c.close);
const lower = c => Math.min(c.open, c.close) - c.low;
const bull = c => c.close > c.open;
const bear = c => c.close < c.open;

// Retorna lista de { name, bias: 'CALL'|'PUT'|'NEUTRAL' } para a vela no índice i.
function detectPatterns(candles, i) {
  const out = [];
  const c = candles[i];
  if (!c || range(c) === 0) return out;
  const p = candles[i - 1];
  const pp = candles[i - 2];
  const b = body(c), r = range(c);

  if (b / r < 0.1) out.push({ name: 'doji', bias: 'NEUTRAL' });
  if (lower(c) >= 2 * b && upper(c) <= 0.3 * b + 1e-12 && b / r > 0.1) out.push({ name: 'martelo', bias: 'CALL' });
  if (upper(c) >= 2 * b && lower(c) <= 0.3 * b + 1e-12 && b / r > 0.1) out.push({ name: 'estrela_cadente', bias: 'PUT' });
  if (b / r > 0.9) out.push({ name: bull(c) ? 'marubozu_alta' : 'marubozu_baixa', bias: bull(c) ? 'CALL' : 'PUT' });

  if (p && range(p) > 0) {
    if (bear(p) && bull(c) && c.open <= p.close && c.close >= p.open && b > body(p))
      out.push({ name: 'engolfo_alta', bias: 'CALL' });
    if (bull(p) && bear(c) && c.open >= p.close && c.close <= p.open && b > body(p))
      out.push({ name: 'engolfo_baixa', bias: 'PUT' });
    if (bear(p) && bull(c) && c.high < p.high && c.low > p.low && body(c) < body(p) * 0.6)
      out.push({ name: 'harami_alta', bias: 'CALL' });
    if (bull(p) && bear(c) && c.high < p.high && c.low > p.low && body(c) < body(p) * 0.6)
      out.push({ name: 'harami_baixa', bias: 'PUT' });
  }
  if (p && pp && range(p) > 0 && range(pp) > 0) {
    if (bear(pp) && body(p) / range(p) < 0.3 && bull(c) && c.close > (pp.open + pp.close) / 2)
      out.push({ name: 'estrela_da_manha', bias: 'CALL' });
    if (bull(pp) && body(p) / range(p) < 0.3 && bear(c) && c.close < (pp.open + pp.close) / 2)
      out.push({ name: 'estrela_da_noite', bias: 'PUT' });
    if (bull(pp) && bull(p) && bull(c) && c.close > p.close && p.close > pp.close)
      out.push({ name: 'tres_soldados', bias: 'CALL' });
    if (bear(pp) && bear(p) && bear(c) && c.close < p.close && p.close < pp.close)
      out.push({ name: 'tres_corvos', bias: 'PUT' });
  }
  return out;
}

// ADX de Wilder (força direcional, sem sentido). null durante o aquecimento (~2×period velas).
function adx(candles, period = 14) {
  const n = candles.length, out = Array(n).fill(null);
  if (n < 2 * period + 1) return out;
  let trS = 0, pS = 0, mS = 0, dxs = [], adxV = null;
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const up = c.high - p.high, dn = p.low - c.low;
    const pdm = up > dn && up > 0 ? up : 0, mdm = dn > up && dn > 0 ? dn : 0;
    if (i <= period) { trS += tr; pS += pdm; mS += mdm; if (i < period) continue; }
    else { trS = trS - trS / period + tr; pS = pS - pS / period + pdm; mS = mS - mS / period + mdm; }
    const pdi = trS ? 100 * pS / trS : 0, mdi = trS ? 100 * mS / trS : 0;
    const dx = pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
    if (adxV == null) { dxs.push(dx); if (dxs.length === period) adxV = dxs.reduce((a, b) => a + b, 0) / period; else continue; }
    else adxV = (adxV * (period - 1) + dx) / period;
    out[i] = adxV;
  }
  return out;
}

// Snapshot dos indicadores e padrões para a vela i (usado pelo catálogo e pelo motor de sinais).
function computeSeries(candles) {
  const closes = candles.map(c => c.close);
  return {
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    rsi14: rsi(closes, 14),
    macd: macd(closes),
    bb: bollinger(closes, 20, 2),
    atr14: atr(candles, 14),
  };
}

function snapshot(candles, series, i) {
  const c = candles[i];
  const g = a => (a[i] == null ? null : a[i]);
  const e9 = g(series.ema9), e21 = g(series.ema21);
  const bbu = g(series.bb.upper), bbl = g(series.bb.lower);
  let bbPos = null;
  if (bbu != null && bbl != null && bbu > bbl) bbPos = (c.close - bbl) / (bbu - bbl);
  return {
    epoch: c.epoch,
    close: c.close,
    rsi: g(series.rsi14),
    emaTrend: e9 != null && e21 != null ? (e9 > e21 ? 'alta' : 'baixa') : null,
    macdHist: g(series.macd.hist),
    macdHistPrev: i > 0 && series.macd.hist[i - 1] != null ? series.macd.hist[i - 1] : null,
    bbPos,
    atr: g(series.atr14),
    patterns: detectPatterns(candles, i),
  };
}

// Pontuação local (-100 venda .. +100 compra) usada como pré-filtro antes de consultar a Claude.
function localScore(s) {
  let score = 0;
  const reasons = [];
  if (s.rsi != null) {
    if (s.rsi < 30) { score += 20; reasons.push('RSI sobrevendido'); }
    else if (s.rsi > 70) { score -= 20; reasons.push('RSI sobrecomprado'); }
  }
  if (s.emaTrend) score += s.emaTrend === 'alta' ? 10 : -10;
  if (s.macdHist != null && s.macdHistPrev != null) {
    if (s.macdHist > 0 && s.macdHist > s.macdHistPrev) { score += 15; reasons.push('MACD ganhando força de alta'); }
    if (s.macdHist < 0 && s.macdHist < s.macdHistPrev) { score -= 15; reasons.push('MACD ganhando força de baixa'); }
  }
  if (s.bbPos != null) {
    if (s.bbPos < 0.05) { score += 15; reasons.push('Preço na banda inferior'); }
    if (s.bbPos > 0.95) { score -= 15; reasons.push('Preço na banda superior'); }
  }
  for (const p of s.patterns) {
    if (p.bias === 'CALL') { score += 20; reasons.push(p.name); }
    if (p.bias === 'PUT') { score -= 20; reasons.push(p.name); }
  }
  score = Math.max(-100, Math.min(100, score));
  return { score, direction: score > 0 ? 'CALL' : score < 0 ? 'PUT' : null, reasons };
}

module.exports = { sma, ema, rsi, macd, bollinger, atr, adx, detectPatterns, computeSeries, snapshot, localScore };
