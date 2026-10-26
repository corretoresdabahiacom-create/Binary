# Trade AI Core (repositório Binary)

## MVP atual — só análise (leia primeiro)

Monitor de mercado para **decisão manual**: o app mostra o gráfico, emite CALL/PUT (ou fica em AGUARDAR) e alerta você; **não envia ordens** (`TRADING_ENABLED=0`, padrão).

**Como rodar no Windows:** instale Node.js 20+ (nodejs.org), descompacte o ZIP, dê dois cliques em `iniciar.bat`. Abre em http://localhost:3010. Nenhum token é necessário para o MVP.

**O que o MVP faz** (foco em **forex**: 10 pares no scanner; índices Volatility retirados por não terem vantagem possível — são gerados por sorteio)
- **Acompanhamento da entrada:** botões “Entrei CALL/PUT” (nenhuma ordem é enviada). O app avisa **ABANDONAR** se o preço virar contra a entrada por mais de 0,5×ATR e o modelo cair abaixo de 45% para a sua direção, com ≥20% do tempo restante; senão **MANTER**. Regra não comprovada em backtest.
- Dados da **API oficial da Deriv** (WebSocket público), índices sintéticos (Volatility). Fonte identificada na tela.
- Gráfico de velas **5 min / 15 min / 1 h**; **expiração 5 ou 15 min** escolhida à parte do timeframe.
- **Diagnóstico da fonte:** estado (OK / DESATUALIZADO / DESCONECTADO), idade do último dado, último preço.
- **Trava de qualidade:** se o dado passar do limite de idade (padrão 20 s) ou a conexão cair, o sinal vigente é **invalidado** e nenhum sinal novo sai até os dados voltarem.
- **Probabilidade em tempo real (CALL/PUT):** ao abrir o ativo, o app baixa até 10.000 velas da Deriv e mede, para o estado técnico atual (RSI, tendência EMA, momento MACD, Bandas de Bollinger), quantas vezes o preço subiu ou caiu até a expiração escolhida. A barra CALL/PUT atualiza a cada tick (no máx. 1×/s). Mostra nº de casos, intervalo de confiança 95% e o nível usado (se o estado exato tem poucos casos, recua para um estado mais geral).
  - **PRELIMINAR** (vela em formação; alerta quando passa da metade da vela) → **CONFIRMADO** no fechamento → entrada na vela seguinte.
  - Sinal só sai com: probabilidade ≥ mínimo (padrão 56%), ≥ 40 casos, IC95% inteiro acima de 50% e dados frescos. Caso contrário: **AGUARDAR** com o motivo.
  - Expiração precisa ser múltipla do gráfico (ex.: gráfico 15 min + expiração 5 min = indisponível).
  - Em índices sintéticos (gerador aleatório) o esperado é quase sempre AGUARDAR — isso é o modelo funcionando, não defeito.
- **Backtest v2 / regra v2 (botão "Rodar backtest v2" ou `npm run backtest2`):** com dados reais da Deriv, por ativo × gráfico × expiração:
  - walk-forward com embargo; operações **sem sobreposição** (faixa de confiança honesta);
  - **calibração isotônica** da probabilidade (quando o modelo diz 58%, deve acertar ~58%);
  - **meta-modelo** (regressão logística) com features de **sessão do câmbio** (Ásia/Londres/sobreposição/NY), percentil de volatilidade, RSI, Bollinger, MACD e impulso — escolhe entre CALL e PUT e filtra sinais fracos; uma 2ª calibração fora da amostra anula o meta-modelo se ele não provar valor;
  - **payout real** da Deriv (quando a API pública fornece; senão 95%, marcado) e decisão por **valor esperado** (prob. final ≥ empate + margem);
  - **Benjamini-Hochberg (FDR 10%)** entre as combinações: só as **aprovadas** (significativas, VE>0, ≥30 operações independentes) notificam. Opção para avisar também as não aprovadas.
  - Resultado salvo em `data/research.json`; painel e scanner usam automaticamente as mesmas funções (`server/research.js`).
- **Suporte e resistência:** topos/fundos confirmados (fractais), agrupados por 0,5×ATR, desenhados no gráfico (R/S × nº de toques); o espaço até o nível oposto é uma feature do meta-modelo do v2.
- **Catalogador em segundo plano:** para cada par e expiração, regras (hora, dia, padrão de vela, indicadores) achadas em 70% do histórico e conferidas nos 30% restantes (Bonferroni), refeitas a cada 6 h. Cada sinal mostra se o catálogo **concorda/discorda**; opção de bloquear discordância ou exigir concordância. As estatísticas por concordância (`/api/signals` → `porCatalogo`) dizem se o filtro melhora o acerto antes de ligá-lo.
- **Histórico no gráfico:** sinais anteriores do par marcados nas velas (✓ favorável, ✗ desfavorável).
- **Motor de análise multimétodo (`server/analysis.js`, velas fechadas, sem dados futuros):** anatomia da vela (corpo, pavios, posição do fechamento, amplitude em ATR); indicadores EMA 9/21/50/200, ADX 14 (Wilder), RSI 14, MACD, Bollinger, ATR com aquecimento validado; padrões (engolfo, martelo, estrela, doji, harami, rejeição com pavio em suporte/resistência, vela de impulso); **zonas** de S/R (limites, toques, idade, relevância, estado: aproximando/rejeitando/rompendo); **regime A–G** (reversão de alta/baixa, continuação de alta/baixa, lateral, rompimento não confirmado, inadequado).
  - **Bloqueios (cada um desligável):** integridade dos dados (OHLC inválido, duplicadas, fora de ordem, lacuna intradiária), histórico mínimo, movimento estendido, lateral (ADX < 15), conflito com a tendência ou rompimento não confirmado, pouco espaço até S/R (< 0,5×ATR), volatilidade muito baixa.
  - Cada sinal mostra contexto, padrão, S/R, indicadores, fatores **a favor/contra** e bloqueios, e é gravado com a auditoria completa. Decisões **bloqueadas** também são gravadas e avaliadas (ficam fora da taxa de acerto principal) para medir se cada filtro ajuda.
  - **Backtest v2** passa a reportar: referência simples (seguir a cor da última vela), v1, v2, **v3 = v2 + bloqueios** (é o v3 que é aprovado e vai ao vivo), resultados por regime, acerto que os bloqueados teriam e estabilidade por janela.
  - Não implementado (sem fonte verificada/autorizada): calendário econômico; spread não se aplica a Rise/Fall (o custo está no payout, que é medido); multi-timeframe como confirmação não foi adicionado porque não há evidência de ganho — os gráficos de 5 e 15 min são avaliados como combinações separadas no scanner.
- **Ciclo do sinal:** válido → expirado (janela de entrada acabou) ou invalidado (com motivo). Tudo gravado em `data/signals.json` com ativo, timeframe, expiração, estratégia, horário e idade do dado.
- **Resultado observado:** após a vela de expiração fechar, compara fechamento vs. preço de abertura do sinal (favorável / desfavorável / empate). Nunca usa dados futuros.
- **Alertas no Windows** (notificação do navegador + som) para sinal, invalidação, dados atrasados e retomada. Permita notificações quando o navegador pedir.
- **Segundo plano:** o monitor roda na janela do `iniciar.bat`; pode fechar/minimizar o navegador. Para os alertas do Windows, mantenha ao menos uma aba aberta (pode ficar minimizada). Fechar a janela do monitor, desligar ou suspender o PC para tudo.

**O que o MVP NÃO faz (honestamente)**
- **IQ Option:** sem API pública oficial; não implementado. O app não usa senha, cookies nem endpoints privados.
- **OTC:** não suportado. Os sintéticos da Deriv não são OTC de outra corretora.
- **Sincronização com o gráfico da corretora:** marcada como **Não validada** — não há acesso ao OHLC exibido pela corretora; compare visualmente.
- **Celular:** sem push. Acesso remoto só via túnel (ver seção Cloudflare abaixo); o monitor depende do PC ligado.
- Sinais vêm de regras de indicadores (`indicadores-v1`) sem vantagem comprovada. Nada aqui é promessa de lucro ou taxa de acerto.

**Testes:** `npm test` (50 testes; usam um servidor Deriv **simulado** — validam a lógica, não a integração real).

---

## Recursos herdados (desligados no MVP)

Execução de ordens, robôs e conta real exigem `TRADING_ENABLED=1` no `.env`. Documentação original abaixo.

### Deriv Signal Desk (base original)

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

## Publicar num servidor (Cloudflare Tunnel + Access)

O app não tem login próprio. Publique **somente** atrás do Cloudflare Access (com `CF_ACCESS_TEAM_DOMAIN` e `CF_ACCESS_AUD` definidos, toda requisição HTTP e WebSocket exige um JWT válido do Access). O servidor continua escutando só em 127.0.0.1; o túnel (cloudflared) roda na mesma máquina e só faz conexões de saída. Passo a passo e script: `deploy/setup-vps.sh`.
