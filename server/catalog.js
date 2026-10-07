'use strict';
// Catálogo de sinais: procura no histórico da Deriv combinações (hora, dia, padrão de vela, indicadores)
// que antecederam velas de alta/baixa e valida cada regra em dados que NÃO foram usados para encontrá-la.
const fs = require('fs');
const path = require('path');
const { computeSeries, snapshot } = require('./indicators');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ---------- Estatística ----------
function wilsonLower(wins, n, z = 1.96) {
  if (n === 0) return 0;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (c - m) / d;
}

// p-valor unilateral (aprox. normal) de observar >= wins sucessos se a probabilidade real fosse p0.
function binomPValue(wins, n, p0) {
  if (n === 0) return 1;
  const mu = n * p0, sd = Math.sqrt(n * p0 * (1 - p0));
  const z = (wins - 0.5 - mu) / sd;
  return 1 - normCdf(z);
}
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// ---------- Atributos de cada vela ----------
const bucketRsi = v => (v == null ? null : v < 30 ? 'rsi<30' : v < 45 ? 'rsi30-45' : v < 55 ? 'rsi45-55' : v < 70 ? 'rsi55-70' : 'rsi>70');
const bucketBb = v => (v == null ? null : v < 0.1 ? 'bb_baixa' : v > 0.9 ? 'bb_alta' : 'bb_meio');

function features(candles, series, i) {
  const s = snapshot(candles, series, i);
  const d = new Date(s.epoch * 1000);
  const pat = s.patterns.find(p => p.bias !== 'NEUTRAL') || s.patterns[0];
  const macdDir = s.macdHist == null ? null : s.macdHist > 0 ? (s.macdHistPrev != null && s.macdHist > s.macdHistPrev ? 'macd+sobe' : 'macd+cai') : (s.macdHistPrev != null && s.macdHist < s.macdHistPrev ? 'macd-cai' : 'macd-sobe');
  const f = {
    padrao: pat ? 'padrao:' + pat.name : 'padrao:nenhum',
    rsi: bucketRsi(s.rsi),
    ema: s.emaTrend ? 'ema:' + s.emaTrend : null,
    macd: macdDir,
    bb: bucketBb(s.bbPos),
    hora: 'hora:' + String(d.getUTCHours()).padStart(2, '0'),
    dia: 'dia:' + d.getUTCDay(),
    cor: candles[i].close >= candles[i].open ? 'cor:verde' : 'cor:vermelha',
  };
  return f;
}

const KEYS = ['padrao', 'rsi', 'ema', 'macd', 'bb', 'hora', 'dia', 'cor'];
function combos(arr, k) {
  const out = [];
  (function rec(start, cur) {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
  })(0, []);
  return out;
}
const COMBOS = [...combos(KEYS, 2), ...combos(KEYS, 3)];

function ruleKey(f, keys) {
  const parts = [];
  for (const k of keys) { if (f[k] == null) return null; parts.push(f[k]); }
  return parts.join('&');
}

// ---------- Construção do catálogo ----------
// candles: array ordenado por tempo. Resultado da vela i+1: CALL ganha se close > open (empate perde).
function buildCatalog(candles, opts = {}) {
  const {
    minTrain = 40, minTest = 15, trainRatio = 0.7,
    breakeven = 0.52, // 1/(1+payout); ~95% de payout em Rise/Fall
    minTestRate = 0.55, maxP = 0.05,
  } = opts;
  const series = computeSeries(candles);
  const start = 35; // aquecimento dos indicadores
  const last = candles.length - 2;
  if (last - start < 200) throw new Error('histórico insuficiente (mínimo ~240 velas)');
  const split = start + Math.floor((last - start) * trainRatio);
  const train = new Map(), test = new Map();
  let nCombos = 0;

  for (let i = start; i <= last; i++) {
    const f = features(candles, series, i);
    const nxt = candles[i + 1];
    const up = nxt.close > nxt.open ? 1 : 0;
    const bucket = i < split ? train : test;
    for (const keys of COMBOS) {
      const k = ruleKey(f, keys);
      if (!k) continue;
      const id = keys.join('+') + '|' + k;
      let e = bucket.get(id);
      if (!e) { e = { n: 0, up: 0, keys, key: k }; bucket.set(id, e); }
      e.n++; e.up += up;
    }
  }
  nCombos = train.size;

  const rules = [];
  for (const [id, tr] of train) {
    if (tr.n < minTrain) continue;
    const rateUp = tr.up / tr.n;
    const dir = rateUp >= 0.5 ? 'CALL' : 'PUT';
    const trWins = dir === 'CALL' ? tr.up : tr.n - tr.up;
    const trRate = trWins / tr.n;
    if (trRate < minTestRate) continue;
    const te = test.get(id);
    if (!te || te.n < minTest) continue;
    const teWins = dir === 'CALL' ? te.up : te.n - te.up;
    const teRate = teWins / te.n;
    const p = binomPValue(teWins, te.n, breakeven);
    rules.push({
      id, keys: tr.keys, key: tr.key, direction: dir,
      trainN: tr.n, trainRate: +trRate.toFixed(4),
      testN: te.n, testRate: +teRate.toFixed(4),
      testWilson: +wilsonLower(teWins, te.n).toFixed(4),
      p: +p.toExponential(3),
      // Bonferroni: corrige pelo número de regras testadas (evita confundir sorte com padrão).
      pAdj: Math.min(1, p * nCombos),
      validated: teRate >= minTestRate && p * nCombos <= maxP,
    });
  }
  rules.sort((a, b) => b.testWilson - a.testWilson);
  return {
    createdAt: Date.now(),
    candles: candles.length,
    from: candles[0].epoch, to: candles[candles.length - 1].epoch,
    splitEpoch: candles[split].epoch,
    rulesTested: nCombos,
    breakeven,
    rules: rules.slice(0, 200),
    validated: rules.filter(r => r.validated).length,
  };
}

// Regras do catálogo que casam com a última vela fechada.
function matchRules(catalog, candles, series, i, { onlyValidated = true } = {}) {
  if (!catalog) return [];
  const f = features(candles, series, i);
  return catalog.rules.filter(r => (!onlyValidated || r.validated) && ruleKey(f, r.keys) === r.key);
}

// ---------- Histórico via API (paginado) ----------
async function fetchHistory(sock, symbol, granularity, pages = 4, onProgress = () => {}) {
  let end = 'latest';
  let all = [];
  for (let p = 0; p < pages; p++) {
    const res = await sock.send({ ticks_history: symbol, style: 'candles', granularity, count: 5000, end }, { timeoutMs: 30000 });
    const cs = (res.candles || []).map(c => ({ epoch: c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
    if (!cs.length) break;
    all = cs.concat(all);
    onProgress({ page: p + 1, pages, candles: all.length });
    end = String(cs[0].epoch - 1);
    if (cs.length < 5000) break;
  }
  // remove duplicatas e ordena
  const m = new Map(all.map(c => [c.epoch, c]));
  return [...m.values()].sort((a, b) => a.epoch - b.epoch);
}

function file(symbol, gran) { return path.join(DATA_DIR, `catalog-${symbol}-${gran}.json`); }
function save(symbol, gran, cat) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file(symbol, gran), JSON.stringify(cat)); }
function load(symbol, gran) { try { return JSON.parse(fs.readFileSync(file(symbol, gran), 'utf8')); } catch { return null; } }

module.exports = { buildCatalog, matchRules, fetchHistory, save, load, wilsonLower, binomPValue, features, COMBOS };
