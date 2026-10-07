# Deriv Signal Desk

MVP para operar na Deriv (contas **demo** e **real**) com gráfico ao vivo, sinais de entrada validados pela Claude, robô automático, robô por catálogo de sinais e limites de perda. Tudo usa a API oficial da Deriv; nada é simulado (os testes usam um servidor falso só para verificar o protocolo).

## Como usar

1. Instale o Node.js 20 ou superior (nodejs.org).
2. Em developers.deriv.com crie um **App ID** e um **token de acesso pessoal (PAT)** com escopo `trade`.
3. Dê dois cliques em `iniciar.bat` (Windows) ou rode `./iniciar.sh`. Abre em http://localhost:3000.
4. Aba **Conexão**: informe App ID, token e (para os robôs) a chave da API da Claude. Marque "Lembrar" se quiser.
5. Comece **sempre pela conta DEMO** (padrão). Para trocar, clique no selo DEMO/REAL no topo; a conta real pede confirmação.

## Telas

- **Operar**: gráfico de velas (15 min ou 1 h), cartão do sinal (permanece enquanto ainda dá para entrar e some quando o tempo passa), botões de compra/venda, aviso "aguardar fechar ou sair agora" após entrar, robô com probabilidade mínima e limites de perda.
- **Catálogo**: busca no histórico da Deriv combinações de hora, dia, padrão de vela e indicadores. Cada regra é achada com 70% dos dados e conferida nos 30% restantes, com correção estatística pelo número de regras testadas. O robô por catálogo só entra quando uma regra validada coincide com a vela atual **e** a Claude confirma com probabilidade acima do mínimo (sugerido: 85%).
- **Histórico**: operações, latência sinal→compra, deslize de preço e diagnóstico estatístico.
- **Conexão**: credenciais.

## Limites de perda

Perda máxima da sessão, perdas seguidas e número máximo de operações. Ao atingir qualquer um, o robô para sozinho.

## O que esperar (leia)

- Em índices sintéticos (Volatility) o preço vem de um gerador aleatório; padrões de vela e indicadores não têm poder preditivo comprovado. É normal o catálogo não validar nenhuma regra e a Claude responder "sem vantagem" na maioria das velas. Com 85% de mínimo, o robô por catálogo provavelmente quase nunca entrará.
- O payout fica abaixo de 100%: com ~95% é preciso acertar mais de ~51,3% só para empatar. Amostras com menos de ~100 operações não provam nada.
- Não há evidência de que a Deriv reverta velas. O app não tenta "burlar" isso; ele **mede**: registra o preço que você via na decisão, o preço real de entrada e a latência de cada ordem, e a aba Histórico mostra se há deslize adverso sistemático. Rode pelo menos 100 operações em DEMO e confira esses números antes de usar dinheiro real.
- Negociar derivativos envolve alto risco de perda. Isto não é recomendação financeira.

## Segurança

O servidor só escuta em 127.0.0.1 e recusa conexões WebSocket de outros sites. Credenciais salvas ficam em `data/config.json` (permissão 600). Não exponha a porta na internet.

## Testes

`npm test`: indicadores, catálogo contra ruído e contra padrão plantado, motor e servidor contra uma Deriv simulada.
