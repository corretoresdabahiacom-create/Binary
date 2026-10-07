'use strict';
// Validação de sinais pela API da Claude. A chave fica só no servidor (ANTHROPIC_API_KEY).
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

const SYSTEM = `Você é um analista quantitativo de velas e indicadores técnicos.
Recebe os dados da última vela fechada, padrões detectados, indicadores e as últimas velas.
Decida se a PRÓXIMA vela deve fechar acima (CALL) ou abaixo (PUT) da abertura, ou se não há vantagem (NONE).
Regras:
- Seja conservador e calibrado. Em índices sintéticos o preço é aleatório e a maioria dos setups não tem vantagem real; use NONE quando os sinais forem fracos, conflitantes ou ruído.
- "confidence" é sua estimativa honesta de 0 a 1 da probabilidade de a direção escolhida acertar. Nunca passe de 0.75 sem evidência muito forte e convergente.
- Responda APENAS com JSON: {"direction":"CALL|PUT|NONE","confidence":0.00,"reason":"até 25 palavras em português"}`;

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('resposta da Claude sem JSON');
  return JSON.parse(m[0]);
}

async function askClaude(context, { timeoutMs = 20000 } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY não configurada');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(context) }],
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Claude ${res.status}: ${json.error ? json.error.message : 'erro'}`);
    const text = (json.content || []).map(b => b.text || '').join('');
    const out = extractJson(text);
    const direction = ['CALL', 'PUT', 'NONE'].includes(out.direction) ? out.direction : 'NONE';
    const confidence = Math.max(0, Math.min(1, Number(out.confidence) || 0));
    return { direction, confidence, reason: String(out.reason || '').slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { askClaude, extractJson, MODEL };
