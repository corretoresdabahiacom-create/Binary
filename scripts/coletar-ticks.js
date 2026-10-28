'use strict';
// Coleta diária de ticks: a Deriv só guarda ~1 dia de ticks, então este script baixa o último dia dos 10 pares
// e acrescenta em data/ticks/<ativo>-<AAAAMMDD>.csv (sem duplicar). Rodar 1x por dia, com o monitor ligado ou não.
// Depois de ~20 dias de ticks, scripts/fluxo.js testa "modelo + fluxo" com amostra de verdade.
const fs = require('fs'), path = require('path');
const deriv = require('../server/deriv');
const SYMS = ['frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDUSD', 'frxUSDCAD', 'frxUSDCHF', 'frxNZDUSD', 'frxEURGBP', 'frxEURJPY', 'frxGBPJPY'];
const dir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'ticks');
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(dir, { recursive: true });
  const sock = deriv.publicSocket(); await sock.connect();
  for (const sym of SYMS) {
    const byDay = new Map(); let end = 'latest', got = 0;
    for (let page = 0; page < 30; page++) {
      let res;
      for (let k = 0; ; k++) {
        try { res = await sock.send({ ticks_history: sym, style: 'ticks', count: 5000, end }, { timeoutMs: 30000 }); break; }
        catch (e) { if (!/rate limit/i.test(e.message) || k >= 8) { console.log(sym, 'erro', e.message); res = null; break; } await wait(Math.min(120000, 15000 * (k + 1))); }
      }
      const h = res && res.history; if (!h || !h.times || !h.times.length) break;
      const t = h.times.map(Number); if (end !== 'latest' && t[0] >= +end) break;
      t.forEach((e, i) => { const day = new Date(e * 1000).toISOString().slice(0, 10).replace(/-/g, ''); (byDay.get(day) || byDay.set(day, new Map()).get(day)).set(e, h.prices[i]); });
      got += t.length; end = String(t[0] - 1); await wait(1200);
    }
    let added = 0;
    for (const [day, m] of byDay) {
      const f = path.join(dir, `${sym}-${day}.csv`), have = new Set();
      try { for (const l of fs.readFileSync(f, 'utf8').split('\n')) { const e = l.split(',')[0]; if (e) have.add(+e); } } catch {}
      const lines = [...m].filter(([e]) => !have.has(e)).sort((a, b) => a[0] - b[0]).map(([e, q]) => `${e},${q}`);
      if (lines.length) { fs.appendFileSync(f, lines.join('\n') + '\n'); added += lines.length; }
    }
    console.log(`${sym}: ${got} ticks baixados, ${added} novos gravados`);
    await wait(2000);
  }
  sock.close();
})().catch(e => { console.error('falhou:', e.message); process.exit(1); });
