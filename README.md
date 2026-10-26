# Trade AI Core (repositório Binary)

## MVP atual — só análise (leia primeiro)

Monitor de mercado para **decisão manual**: o app mostra o gráfico, emite CALL/PUT (ou fica em AGUARDAR) e alerta você; **não envia ordens** (`TRADING_ENABLED=0`, padrão).

**Como rodar no Windows:** instale Node.js 20+ (nodejs.org), descompacte o ZIP, dê dois cliques em `iniciar.bat`. Abre em http://localhost:3000. Nenhum token é necessário para o MVP.

**O que o MVP faz**
- Dados da **API oficial da Deriv** (WebSocket público), índices sintéticos (Volatility). Fonte identificada na tela.
- Gráfico de velas **5 min / 15 min / 1 h**; **expiração 5 ou 15 min** escolhida à parte do timeframe.
- **Diagnóstico da fonte:** estado (OK / DESATUALIZADO / DESCONECTADO), idade do último dado, último preço.
- **Trava de qualidade:** se o dado passar do limite de idade (padrão 20 s) ou a conexão cair, o sinal vigente é **invalidado** e nenhum sinal novo sai até os dados voltarem.
- **Probabilidade em tempo real (CALL/PUT):** ao abrir o ativo, o app baixa até 10.000 velas da Deriv e mede, para o estado técnico atual (RSI, tendência EMA, momento MACD, Bandas de Bollinger), quantas vezes o preço subiu ou caiu até a expiração escolhida. A barra CALL/PUT atualiza a cada tick (no máx. 1×/s). Mostra nº de casos, intervalo de confiança 95% e o nível usado (se o estado exato tem poucos casos, recua para um estado mais geral).
  - **PRELIMINAR** (vela em formação; alerta quando passa da metade da vela) → **CONFIRMADO** no fechamento → entrada na vela seguinte.
  - Sinal só sai com: probabilidade ≥ mínimo (padrão 56%), ≥ 40 casos, IC95% inteiro acima de 50% e dados frescos. Caso contrário: **AGUARDAR** com o motivo.
  - Expiração precisa ser múltipla do gráfico (ex.: gráfico 15 min + expiração 5 min = indisponível).
  - Em índices sintéticos (gerador aleatório) o esperado é quase sempre AGUARDAR — isso é o modelo funcionando, não defeito.
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

**Testes:** `npm test` (25 testes; usam um servidor Deriv **simulado** — validam a lógica, não a integração real).

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
