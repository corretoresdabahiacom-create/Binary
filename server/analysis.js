'use strict';
// Motor de análise multimétodo (somente velas FECHADAS até i; nada de dados futuros).
// Separa as dimensões pedidas: 1) contexto (tendência/lateral/volatilidade), 2) localização (zonas de S/R),
// 3) gatilho (padrão de vela), 4) qualidade operacional (integridade/histórico), 5) evidência estatística
// (fica no modelo + backtest v2). Os bloqueios são configuráveis e medidos no backtest (v3 = v2 + bloqueios).
const { computeSeries, snapshot, ema, adx, detectPatterns } = require('./indicators');
const SR = require('./levels');

const VERSION = 'analise-v1';
const DEFAULTS = { integridade: 1, historico: 1, estendido: 1, lateral: 1, conflito: 1, espaco: 1, baixaVol: 1,
  adxLateral: 15, adxTendencia: 20, espacoMinATR: 0.5, estendidoCorpoATR: 2.5, estendidoSeq: 5, estendidoDistATR: 3 };

const r4 = x => (x == null || !Number.isFinite(x) ? null : +x.toFixed(5));

function integrity(win, gran) {
  const issues = [];
  const tail = win.slice(-60);
  for (let j = 0; j < tail.length; j++) {
    const c = tail[j];
    if (![c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0) || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) { issues.push('OHLC inválido'); break; }
    if (j && c.epoch <= tail[j - 1].epoch) { issues.push(c.epoch === tail[j - 1].epoch ? 'vela duplicada' : 'sequência temporal fora de ordem'); break; }
  }
  if (gran) {                                              // lacuna intradiária recente (fim de semana/feriado é aceito)
    const last = win.slice(-20);
    for (let j = 1; j < last.length; j++) { const d = last[j].epoch - last[j - 1].epoch; if (d > gran * 1.5 && d < 12 * 3600) { issues.push(`lacuna de ${Math.round(d / 60)} min`); break; } }
  }
  return issues;
}

function analyze(candles, i, { gran = null, cfg = {} } = {}) {
  const o = { ...DEFAULTS, ...cfg };
  const win = candles.slice(Math.max(0, i - 299), i + 1), k = win.length - 1;
  const res = { version: VERSION, epoch: candles[i] && candles[i].epoch, historyOk: win.length >= 60, issues: [] };
  if (!res.historyOk) { res.issues.push(`histórico insuficiente (${win.length} velas; mínimo 60)`); return res; }
  res.issues = integrity(win, gran);
  const ser = computeSeries(win), s = snapshot(win, ser, k), closes = win.map(c => c.close);
  const e50 = ema(closes, 50), e200 = ema(closes, 200), ax = adx(win, 14);
  const c = win[k], a = ser.atr14[k], rng = c.high - c.low;
  const body = Math.abs(c.close - c.open), up = c.high - Math.max(c.open, c.close), lo = Math.min(c.open, c.close) - c.low;
  res.anatomy = { open: c.open, high: c.high, low: c.low, close: c.close, corpo: r4(body), pavioSup: r4(up), pavioInf: r4(lo), amplitude: r4(rng),
    posFechamento: rng ? +((c.close - c.low) / rng).toFixed(3) : null, corpoPct: rng ? +(body / rng).toFixed(3) : null, amplitudeATR: a ? +(rng / a).toFixed(2) : null };
  const slope = a && ser.ema21[k] != null && ser.ema21[k - 5] != null ? (ser.ema21[k] - ser.ema21[k - 5]) / a : null;
  const atrs = ser.atr14.slice(-100).filter(v => v != null), atrPct = a && atrs.length ? atrs.filter(v => v <= a).length / atrs.length : null;
  res.indicators = { ema9: r4(ser.ema9[k]), ema21: r4(ser.ema21[k]), ema50: r4(e50[k]), ema200: win.length >= 200 ? r4(e200[k]) : null,
    adx14: ax[k] == null ? null : +ax[k].toFixed(1), rsi14: s.rsi == null ? null : +s.rsi.toFixed(1), macdHist: r4(s.macdHist), atr14: r4(a),
    bbPos: s.bbPos == null ? null : +s.bbPos.toFixed(2), inclinacaoEMA21ATR: slope == null ? null : +slope.toFixed(2), atrPercentil: atrPct == null ? null : +atrPct.toFixed(2),
    parametros: 'EMA 9/21/50/200, ADX 14, RSI 14, MACD 12/26/9, BB 20/2, ATR 14' };

  // localização: zonas (nível ± 0,25 ATR), idade, relevância e estado
  const lv = SR.levels(win, k);
  res.zones = (lv.levels || []).map(l => {
    const half = 0.25 * (a || 0), top = l.price + half, bot = l.price - half;
    let estado = 'distante';
    if (l.type === 'suporte') {
      if (c.low <= top && c.close > top) estado = 'rejeitando';
      else if (c.close < bot) estado = 'rompendo';
      else if (a && c.close - top < 0.5 * a) estado = 'aproximando';
    } else {
      if (c.high >= bot && c.close < bot) estado = 'rejeitando';
      else if (c.close > top) estado = 'rompendo';
      else if (a && bot - c.close < 0.5 * a) estado = 'aproximando';
    }
    const idade = Math.round((c.epoch - l.last) / Math.max(1, (gran || 300)));
    return { tipo: l.type, preco: r4(l.price), de: r4(bot), ate: r4(top), metodo: 'fractal 3+3 agrupado por ATR', toques: l.touches,
      idadeVelas: idade, relevancia: +(l.touches / (1 + idade / 100)).toFixed(2), distanciaATR: a ? +(Math.abs(l.price - c.close) / a).toFixed(2) : null, estado };
  });
  res.roomCALL = SR.room(lv, 'CALL'); res.roomPUT = SR.room(lv, 'PUT');

  // gatilho: padrões clássicos + rejeição e impulso
  const pats = detectPatterns(win, k).map(p => ({ ...p }));
  const sup = res.zones.find(z => z.tipo === 'suporte' && z.estado === 'rejeitando');
  const res_ = res.zones.find(z => z.tipo === 'resistencia' && z.estado === 'rejeitando');
  if (rng && lo >= 0.5 * rng && (c.close - c.low) / rng >= 0.6) pats.push({ name: sup ? 'rejeicao_inferior_em_suporte' : 'rejeicao_inferior', bias: 'CALL' });
  if (rng && up >= 0.5 * rng && (c.high - c.close) / rng >= 0.6) pats.push({ name: res_ ? 'rejeicao_superior_em_resistencia' : 'rejeicao_superior', bias: 'PUT' });
  if (a && body >= 1.5 * a && rng && body / rng >= 0.7) pats.push({ name: c.close > c.open ? 'impulso_alta' : 'impulso_baixa', bias: c.close > c.open ? 'CALL' : 'PUT' });
  res.patterns = pats;

  // contexto: regime A–G
  const ax14 = ax[k], trendUp = ser.ema9[k] > ser.ema21[k] && slope > 0.3, trendDn = ser.ema9[k] < ser.ema21[k] && slope < -0.3;
  const revUp = pats.some(p => p.bias === 'CALL' && /rejeicao_inferior_em_suporte|engolfo_alta|martelo|estrela_da_manha/.test(p.name));
  const revDn = pats.some(p => p.bias === 'PUT' && /rejeicao_superior_em_resistencia|engolfo_baixa|estrela_cadente|estrela_da_noite/.test(p.name));
  const breaking = res.zones.find(z => z.estado === 'rompendo' && z.distanciaATR != null && z.distanciaATR < 0.3);
  let regime, regimeMotivo;
  if (res.issues.length) { regime = 'G'; regimeMotivo = 'dados com problema'; }
  else if (atrPct != null && atrPct < 0.1) { regime = 'G'; regimeMotivo = 'volatilidade muito baixa (ATR no 10% mais baixo)'; }
  else if (breaking) { regime = 'F'; regimeMotivo = `rompimento de ${breaking.tipo} ainda sem confirmação`; }
  else if (trendDn && revUp) { regime = 'A'; regimeMotivo = 'reversão potencial de alta contra tendência de baixa'; }
  else if (trendUp && revDn) { regime = 'B'; regimeMotivo = 'reversão potencial de baixa contra tendência de alta'; }
  else if (trendUp && ax14 >= o.adxTendencia) { regime = 'C'; regimeMotivo = `continuação de alta (ADX ${ax14.toFixed(0)})`; }
  else if (trendDn && ax14 >= o.adxTendencia) { regime = 'D'; regimeMotivo = `continuação de baixa (ADX ${ax14.toFixed(0)})`; }
  else if (revUp) { regime = 'A'; regimeMotivo = 'reversão potencial de alta'; }
  else if (revDn) { regime = 'B'; regimeMotivo = 'reversão potencial de baixa'; }
  else if (ax14 != null && ax14 < o.adxLateral) { regime = 'E'; regimeMotivo = `lateral (ADX ${ax14.toFixed(0)})`; }
  else { regime = 'E'; regimeMotivo = 'sem direção clara'; }
  res.regime = regime; res.regimeMotivo = regimeMotivo;
  res.seqMesmaCor = (() => { let n = 1; const dir = Math.sign(win[k].close - win[k].open); for (let j = k - 1; j >= 0 && Math.sign(win[j].close - win[j].open) === dir && dir; j--) n++; return dir ? n * dir : 0; })();
  res.distEMA21ATR = a && ser.ema21[k] != null ? +((c.close - ser.ema21[k]) / a).toFixed(2) : null;
  return res;
}

// Bloqueios e fatores para uma direção proposta. Cada bloqueio pode ser desligado em cfg.
function gates(an, dir, cfg = {}) {
  const o = { ...DEFAULTS, ...cfg }, blocks = [], favor = [], contra = [], sg = dir === 'CALL' ? 1 : -1;
  if (!an) return { blocks: ['sem análise'], favor, contra };
  if (o.historico && !an.historyOk) blocks.push(an.issues[0] || 'histórico insuficiente');
  if (!an.historyOk) return { blocks, favor, contra };
  if (o.integridade && an.issues.length) blocks.push('dados: ' + an.issues.join(', '));
  if (o.baixaVol && an.regime === 'G' && !an.issues.length) blocks.push(an.regimeMotivo);
  const room = dir === 'CALL' ? an.roomCALL : an.roomPUT;
  if (o.espaco && room * (an.indicators.atr14 ? 1 : 0) < o.espacoMinATR && an.zones.length) blocks.push(`pouco espaço até ${dir === 'CALL' ? 'a resistência' : 'o suporte'} (${room.toFixed(2)}×ATR)`);
  const ext = [];
  if (an.anatomy.amplitudeATR != null && an.anatomy.amplitudeATR >= o.estendidoCorpoATR && Math.sign(an.anatomy.close - an.anatomy.open) === sg) ext.push(`vela de ${an.anatomy.amplitudeATR}×ATR`);
  if (an.seqMesmaCor * sg >= o.estendidoSeq) ext.push(`${Math.abs(an.seqMesmaCor)} velas seguidas na mesma direção`);
  if (an.distEMA21ATR != null && an.distEMA21ATR * sg >= o.estendidoDistATR) ext.push(`preço ${Math.abs(an.distEMA21ATR)}×ATR longe da EMA21`);
  if (o.estendido && ext.length) blocks.push('movimento estendido: ' + ext.join('; '));
  if (o.lateral && an.regime === 'E' && an.indicators.adx14 != null && an.indicators.adx14 < o.adxLateral) blocks.push(an.regimeMotivo);
  if (o.conflito) {
    if (an.regime === 'C' && dir === 'PUT') blocks.push('conflito: PUT contra continuação de alta sem reversão confirmada');
    if (an.regime === 'D' && dir === 'CALL') blocks.push('conflito: CALL contra continuação de baixa sem reversão confirmada');
    if (an.regime === 'F') blocks.push(an.regimeMotivo);
  }
  // fatores (informativos; não são somados como confirmações independentes)
  const i = an.indicators;
  if ((an.regime === 'C' && dir === 'CALL') || (an.regime === 'D' && dir === 'PUT')) favor.push('a favor da tendência');
  if ((an.regime === 'A' && dir === 'CALL') || (an.regime === 'B' && dir === 'PUT')) favor.push('reversão com gatilho em zona');
  for (const p of an.patterns) (p.bias === dir ? favor : p.bias === 'NEUTRAL' ? [] : contra).push('padrão ' + p.name);
  if (room >= 1.5) favor.push(`espaço livre ${room.toFixed(1)}×ATR`); else if (room < 0.8) contra.push(`espaço curto ${room.toFixed(1)}×ATR`);
  if (i.rsi14 != null) { if (dir === 'CALL' && i.rsi14 > 70) contra.push(`RSI ${i.rsi14} (sobrecompra pode persistir)`); if (dir === 'PUT' && i.rsi14 < 30) contra.push(`RSI ${i.rsi14} (sobrevenda pode persistir)`); }
  if (i.ema200 != null) (Math.sign(an.anatomy.close - i.ema200) === sg ? favor : contra).push(`preço ${an.anatomy.close > i.ema200 ? 'acima' : 'abaixo'} da EMA200`);
  return { blocks, favor, contra };
}

// Resumo compacto para auditoria do sinal.
function audit(an, g) {
  if (!an) return null;
  return { version: an.version, regime: an.regime, regimeMotivo: an.regimeMotivo, anatomia: an.anatomy, indicadores: an.indicators,
    zonas: (an.zones || []).slice(0, 4), padroes: (an.patterns || []).map(p => p.name), bloqueios: g && g.blocks, favor: g && g.favor, contra: g && g.contra, problemas: an.issues };
}

module.exports = { analyze, gates, audit, DEFAULTS, VERSION };
