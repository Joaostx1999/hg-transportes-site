<!-- generated-by: gsd-doc-writer -->
# Operação do painel (runbook)

Procedimentos do dia a dia e de incidente para o Worker `hg-cms-api` e o painel. Os comandos foram
tirados do código (`api/src/`, `api/scripts/`, `api/wrangler.toml`). O que depende da conta Cloudflare
ou GitHub de produção, que ainda não existe, está marcado como **A CONFIRMAR**.

O deploy inicial está no [checklist de deploy](README.md#checklist-de-deploy-em-produção). As rotas
citadas aqui estão detalhadas em [api.md](api.md). Os riscos ligados a cada procedimento estão no
[modelo de ameaças](seguranca/ameacas-stride.md).

> **Secrets efêmeros.** `BOOTSTRAP_SECRET`, `RECOVERY_SECRET` e `PASSWORD_PEPPER_PREV` só existem durante
> o procedimento que os usa. Apague cada um logo depois (`npx wrangler secret delete <NOME>`). Enquanto
> existirem, são uma porta de entrada.

## Antes de começar

Tudo roda dentro de `api/`. Os comandos `wrangler` exigem login na conta Cloudflare do Worker
(`npx wrangler login`). De quem é essa conta e quem tem acesso é **A CONFIRMAR**.

Para chamar a API fora do painel (por exemplo, para ler a auditoria), lembre que:

- todo pedido sem cabeçalho `Origin` é recusado com `403 cors`, exceto `GET /health`,
  `POST /bootstrap` e `POST /recover` (`api/src/app.ts`, `noOrigin`). Envie `Origin` com um valor de `ALLOWED_ORIGINS`
  (hoje `https://joaostx1999.github.io`);
- o token de sessão vem do `POST /login`. Com `TURNSTILE_SECRET` ligado, o login exige um
  `turnstileToken`, o que inviabiliza o login por `curl`. Nesse caso, entre pelo painel e copie o token
  da chave `hg-cms-session` do `sessionStorage` da aba (ferramentas do desenvolvedor).

Login por `curl` (sem Turnstile). A senha é lida sem eco, para não ficar no histórico do shell:

```bash
API=https://<url-do-worker>          # A CONFIRMAR
ORIGIN=https://joaostx1999.github.io
read -r -s -p 'Senha: ' SENHA; echo
TOKEN=$(jq -n --arg u admin --arg p "$SENHA" '{username:$u,password:$p}' \
  | curl -sS -X POST "$API/login" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' --data @- \
  | jq -r .token)
unset SENHA
```

Saia no fim (`POST /logout`) para apagar a sessão no servidor:

```bash
curl -sS -X POST "$API/logout" -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN"
```

## Primeiro usuário

O primeiro admin só pode ser criado pelo `POST /bootstrap`, e só enquanto o DO não tem nenhum usuário.
O script `scripts/criar-usuario.mjs` aplica a mesma política de senha do Worker antes de chamar a rota.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # 43 caracteres
npx wrangler secret put BOOTSTRAP_SECRET          # mínimo 32 caracteres, senão a rota recusa sempre
HG_BOOTSTRAP_SECRET='<mesmo valor>' \
  node scripts/criar-usuario.mjs <usuario> --url https://<url-do-worker>
npx wrangler secret delete BOOTSTRAP_SECRET       # OBRIGATÓRIO depois de criar
```

- A senha vem de `HG_SENHA`, de `--senha-stdin` ou é digitada sem eco no terminal.
- Para URL remota, o script exige `https://`.
- `403` quer dizer: já existe usuário, o segredo está errado, `BOOTSTRAP_SECRET` não está configurado ou
  tem menos de 32 caracteres (neste caso o log traz `config_missing` com `BOOTSTRAP_SECRET curto`).
  O `/bootstrap` tem limite próprio de 20 falhas por IP em 15 min.
- Local: veja [Como rodar localmente](README.md#como-rodar-localmente).

Quem é o primeiro admin e quem guarda a senha é **A CONFIRMAR**. Recomendação: crie logo um **segundo
admin** pelo painel, de outra pessoa. Com dois admins, um redefine a senha do outro pelo painel e a
[recuperação por secret](#recuperar-o-acesso-de-admin) fica só para o caso extremo.

## Criar, remover e mudar o papel de usuários

Pelo painel (aba de usuários, só admin), que chama `POST /users/create` e `POST /users/delete`.
**As duas ações pedem a senha do admin** ("Sua senha (para confirmar)"). Errar conta no limite de
tentativas do login e fica na auditoria (`reauth_fail`).

- O nome de usuário tem 3 a 32 caracteres `[a-z0-9._-]`. As regras de senha estão em
  [regras-de-negocio.md](regras-de-negocio.md#usuário-e-senha).
- Remover um usuário derruba as sessões dele na hora.
- Ninguém remove a si mesmo, e o último admin não pode ser removido.
- **Não existe rota para mudar o papel.** Para promover ou rebaixar, remova o usuário e crie de novo com
  o papel novo.

## Redefinir senha

| Situação | Procedimento |
| --- | --- |
| O usuário lembra a senha atual | Ele mesmo troca pelo painel (`POST /password`). As outras sessões dele caem, e a atual continua |
| Editor ou admin esqueceu, e existe **outro** admin | O outro admin redefine pelo painel (`POST /users/password`, com a senha **dele** para confirmar). **Todas** as sessões do alvo caem. Passe a senha nova por um canal seguro e peça a troca no primeiro acesso (o código não força essa troca). O admin não usa essa tela para a própria senha: é "Minha senha" |
| **Nenhum** admin consegue entrar | [Recuperar o acesso de admin](#recuperar-o-acesso-de-admin) com `RECOVERY_SECRET`. Não precisa zerar o DO |

Errar a senha atual em `/password` conta no mesmo limite do login (5 falhas por usuário+IP bloqueiam
por 15 min).

## Recuperar o acesso de admin

Para quando nenhum admin consegue entrar (senha esquecida, único admin fora, pepper perdido). Usa a rota
`POST /recover`, que só existe enquanto o secret `RECOVERY_SECRET` está definido
([ADR 0007](adr/0007-recuperacao-e-pepper-versionado.md)). Quem pode fazer isso é quem tem acesso à conta
Cloudflare (**A CONFIRMAR**).

1. Gere um valor novo (cada valor vale **uma vez**; depois de usado, a rota responde `403 "já foi usado"`):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   npx wrangler secret put RECOVERY_SECRET     # mínimo 32 caracteres
   ```
2. Redefina a senha do admin pelo script (a senha nova é pedida sem eco e passa pela mesma política):
   ```bash
   HG_RECOVERY_SECRET='<mesmo valor>' \
     node scripts/criar-usuario.mjs <admin> --recuperar --url https://<url-do-worker>
   ```
   O script chama `POST /recover {secret, username, password}`. Só funciona para um **admin que já existe**
   (`404` para editor ou nome inexistente). Todas as sessões desse admin caem.
3. **Apague o secret na hora:** `npx wrangler secret delete RECOVERY_SECRET`.
4. Entre no painel com a senha nova, confira a [auditoria](#auditoria) (`recover_ok`, e `recover_fail`
   se houve tentativa errada) e redefina a senha dos outros usuários, se preciso.

Limites: 5 tentativas por rede em 15 min (IPv6 por /64), comparação em tempo constante, log
`recovery_used` (`level: warn`).

## Rotacionar o token do GitHub

O Worker usa um token fine-grained guardado no secret `GITHUB_TOKEN`. Quem gera, em qual conta, qual
validade e quem renova é **A CONFIRMAR**.

**Quando:** antes da expiração (o painel avisa o admin quando faltam menos de 30 dias), quando alguém
com acesso ao token sair do projeto, ou em suspeita de vazamento.

1. No GitHub, crie um token fine-grained novo: só este repositório, permissão **Contents: Read and
   write**, com data de validade.
   <!-- VERIFY: Contents RW basta para todos os endpoints da Git Data API usados em api/src/github.ts -->
2. Grave o token novo no Worker. O comando substitui o valor anterior:
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```
   <!-- VERIFY: wrangler secret put publica uma nova versão do Worker e o novo valor vale para os pedidos seguintes sem deploy adicional -->
3. Confira: entre no painel como admin e abra o conteúdo (`GET /content`). Uma resposta de sucesso do
   GitHub atualiza a validade guardada em `meta` (`github_token_expires_at`). O `/me` também relê a
   validade quando a última checagem tem mais de 6 h. O aviso de expiração deve sumir.
4. **Revogue o token antigo** no GitHub. Se ainda não tiver revogado, o antigo continua valendo até
   expirar.
5. Se o motivo foi vazamento: revise o histórico do repositório desde a data suspeita, procurando
   commits que não têm o autor `<usuário> (painel)` nem correspondem a uma entrada `publish` ou
   `restore` na [auditoria](#auditoria). Lembre que o token dá escrita em qualquer arquivo do
   repositório, inclusive `admin/` ([R9](seguranca/ameacas-stride.md#r9-escopo-do-token-do-github)).

Sintomas de token inválido ou vencido: as rotas que falam com o GitHub respondem `502 upstream`, e o log
traz `{"event":"github_error","code":"github_401"}` (ou `github_403`) com `level: error`. Se o secret
estiver ausente, a resposta é `500 server`, e o log traz `{"event":"config_missing","error":"GITHUB_TOKEN ausente"}`.

## Rotacionar o pepper

Cada usuário guarda a versão do pepper do seu hash (`pepper_id`). A rotação **não zera o DO** e não
derruba ninguém: durante uma janela, o Worker aceita o pepper anterior e refaz o hash de cada usuário com o
pepper novo no próximo login ([ADR 0007](adr/0007-recuperacao-e-pepper-versionado.md)).

**Quando:** em suspeita de vazamento do pepper. Não há motivo para rotação periódica.

1. Anote a versão atual (`PASSWORD_PEPPER_ID` no `wrangler.toml`; se não estiver lá, é `1`).
2. Guarde o pepper atual como anterior e grave o novo (mínimo de 32 caracteres):
   ```bash
   npx wrangler secret put PASSWORD_PEPPER_PREV        # o valor ATUAL do PASSWORD_PEPPER
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   npx wrangler secret put PASSWORD_PEPPER             # o valor NOVO
   ```
3. No `api/wrangler.toml`, em `[vars]`: `PASSWORD_PEPPER_PREV_ID = "<versão antiga>"` e
   `PASSWORD_PEPPER_ID = "<versão antiga + 1>"`; depois `npx wrangler deploy`.
   <!-- VERIFY: ordem entre secret put e deploy de vars sem janela em que o Worker veja pepper novo com ID antigo -->
   Entre o passo 2 e o deploy, quem entrar pode falhar (pepper novo com a versão antiga). Faça os dois em
   seguida, num horário sem uso.
4. Acompanhe: `GET /users` mostra `pepper_current: false` para quem ainda não entrou desde a rotação; a
   auditoria registra `password_rehash` a cada usuário migrado.
5. Quando todos estiverem com `pepper_current: true` (ou ao fim do prazo que vocês definirem), apague o
   anterior: `npx wrangler secret delete PASSWORD_PEPPER_PREV` e tire `PASSWORD_PEPPER_PREV_ID` do
   `wrangler.toml`. Quem não entrou até lá não entra mais com a senha antiga: um admin redefine pelo painel.
6. Se o motivo foi vazamento do pepper **e** do DO juntos, os hashes antigos podem ser atacados offline
   durante a janela. Nesse caso, encurte a janela e peça a troca de senha a todos.

Sem `PASSWORD_PEPPER` (ou com menos de 32 caracteres), o Worker falha fechado: o log traz
`{"event":"config_missing","error":"PASSWORD_PEPPER ausente ou curto demais"}`. Perder o pepper sem
guardar o valor invalida a senha de todos: use a [recuperação de admin](#recuperar-o-acesso-de-admin) e,
a partir dele, redefina os demais.

## Restaurar uma versão do site

**Pelo painel** (tela de versões): lista até 30 commits que tocaram o `index.html` e restaura o escolhido
com `POST /restore`. Regras ([regras-de-negocio.md](regras-de-negocio.md), C7 a C10):

- o restore cria um **commit novo** em cima do HEAD. Nada é apagado do histórico;
- volta **só o `index.html`**. As fotos e o `cms/schema.json` ficam como estão;
- a versão escolhida precisa passar no esquema **atual**. Se não passar, a resposta é `409 schema_mismatch`;
- se outra pessoa publicou depois que o painel carregou, a resposta é `409 conflict`. Recarregue o
  painel e tente de novo.

**Fora do painel** (Worker fora do ar ou versão que não passa no esquema): um commit direto no
repositório, por exemplo `git revert` do commit problemático, seguido de push no branch publicado
(`main`). Depois, confira se a CI (`.github/workflows/cms.yml`) passou, principalmente os passos de
marcadores e de esquema. Se `index.html` e `cms/schema.json` não conferirem, o painel bloqueia a
edição com `409 schema_mismatch`.

**Limitação conhecida: fotos órfãs.** As fotos enviadas depois da versão restaurada continuam em
`assets/fotos/cms-*.{jpg,png,webp}` e seguem acessíveis pelo Pages, mesmo sem referência no site. O
mesmo vale para a foto antiga depois de uma troca. Não há limpeza automática. Para tirar do ar uma foto
publicada por engano, remova o arquivo por commit direto no repositório. Ela continua no histórico
git ([R5](seguranca/ameacas-stride.md#r5-fotos-órfãs-depois-de-restaurar)).

## Logs

O Worker escreve **uma linha JSON por evento** com `console.log` (`api/src/index.ts`, `api/src/log.ts`).
O `api/wrangler.toml` liga `[observability] enabled = true`. Retenção e acesso ao painel de logs da
Cloudflare são **A CONFIRMAR**.
<!-- VERIFY: retenção dos Workers Logs no plano de produção -->

Para acompanhar ao vivo:

```bash
npx wrangler tail hg-cms-api --format json
```

Só estes campos podem sair no log (`ALLOWED` em `api/src/log.ts`): `level`, `event`, `route`, `method`,
`status`, `ms`, `user`, `code`, `attempts`, `changed`, `error`. Nunca senha, token, pepper, conteúdo de
campo ou corpo de pedido.

| `event` | Quando | Campos úteis |
| --- | --- | --- |
| `request` | Todo pedido, no fim | `route` (rota conhecida ou `unknown`), `method`, `status`, `ms`, `user` (se autenticado), `code` (em erro). `level` é `warn` para 4xx e `error` para 5xx |
| `publish` | Publicação bem-sucedida | `user`, `attempts`, `changed` (quantidade de campos) |
| `github_error` | O GitHub falhou | `code` = `github_<status>` (`github_0` = falha de rede). `level: error` para 401 e 403 (credencial), `warn` nos demais |
| `config_missing` | Secret ausente ou inválido | `error` = `GITHUB_TOKEN ausente`, `PASSWORD_PEPPER ausente ou curto demais`, `GITHUB_API_BASE inválido (só https://api.github.com)`, `BOOTSTRAP_SECRET curto (mínimo 32 caracteres)` ou `RECOVERY_SECRET curto (mínimo 32 caracteres)` |
| `publish_integrity` | A verificação final da edição falhou (não deveria acontecer) | `error` = `<chave>: <motivo>`. A resposta ao cliente é `422 integrity` com o campo; nada é escrito |
| `recovery_used` | `POST /recover` redefiniu a senha de um admin | `user`, `level: warn` |
| `unhandled` | Exceção não prevista | `error` = nome da classe do erro |

O que observar:

- `github_error` com `github_401` ou `github_403`: token vencido, revogado ou sem permissão. Veja
  [Rotacionar o token do GitHub](#rotacionar-o-token-do-github).
- `config_missing`: secret faltando depois de um deploy.
- Muitos `request` com `code: rate_limited` ou `invalid_credentials`: tentativa de força bruta. Confira
  `login_fail` e `login_blocked` na [auditoria](#auditoria).
- `code: cors` frequente: o painel está numa origem que não está em `ALLOWED_ORIGINS`, ou alguém está
  chamando a API de outro site.

Não há alerta configurado no repositório (**A CONFIRMAR** quem recebe alertas e por qual canal).

## Auditoria

A auditoria fica na tabela `audit` do DO, com retenção de **365 dias** (limpeza automática no máximo uma
vez por minuto, `api/src/state.ts`). Cada entrada tem `id`, `ts` (ISO), `username`, `ip`
(`CF-Connecting-IP`), `action` e `detail`. O painel atual **não** mostra a auditoria. A leitura é feita
pela API, só por admin.

```bash
# 100 mais recentes (padrão); limit vai de 1 a 500
curl -sS "$API/audit?limit=500" -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN" | jq .

# página seguinte: before = menor id da página anterior
curl -sS "$API/audit?limit=500&before=<id>" -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN" | jq .
```

As entradas vêm da mais recente para a mais antiga.

| `action` | `username` | `detail` |
| --- | --- | --- |
| `login_ok` | quem entrou | — |
| `login_fail` | usuário digitado, se válido | se o nome digitado for inválido: `{invalid_username: true}` (o texto não é gravado) |
| `login_blocked` | usuário digitado, se válido | — (bloqueado pelo limite de tentativas) |
| `login_slowed` | usuário digitado | `{retryAfter}`: passou de 50 tentativas/h e caiu no atraso progressivo |
| `password_rehash` | quem entrou | `{from, to}`: versões do pepper (rotação) |
| `reauth_fail` | admin | senha do admin errada (ou ausente: `{missing: true}`) em `/users/create`, `/users/delete` ou `/users/password` |
| `recover_ok` | admin recuperado | `{sessionsRevoked, limitsCleared}` (limites de tentativa do admin zerados) |
| `recover_fail` | — | secret errado no `/recover` |
| `recover_reused` | — | `/recover` com um secret que já foi usado |
| `logout` | quem saiu | — |
| `publish` | quem publicou | `{commit, base, rebased, attempts, changes: [{key, old, new}]}`, com valores truncados em 300 caracteres |
| `restore` | quem restaurou | `{restored, commit}`: versão restaurada e commit novo |
| `user_create` | admin que criou (no bootstrap, o próprio admin criado) | `{username, role}`, mais `bootstrap: true` no primeiro admin |
| `user_delete` | admin que removeu | `{username}` |
| `password_change` | quem trocou a própria senha | `{sessionsRevoked}` |
| `password_fail` | quem errou a senha atual em `/password` | — |
| `password_reset` | admin que redefiniu | `{username, sessionsRevoked}` |
| `bootstrap_fail` | — | — (segredo errado no `/bootstrap`) |

Cuidados:

- O IP é dado pessoal. O enquadramento na LGPD (e a retenção de 365 dias) é **A CONFIRMAR**. O texto de
  um usuário inválido não é mais gravado.
- Não existe rota para apagar ou editar entradas, e não existe exportação além do `GET /audit`
  paginado. A política de backup é **A CONFIRMAR**.
- Commits feitos direto no repositório não aparecem aqui. Para cruzar, compare `detail.commit` das
  entradas `publish` e `restore` com o histórico do branch.

## Incidentes

### Worker fora do ar ou com erro

O site público **não depende do Worker**: o Pages continua servindo o `index.html`. Só a edição para.

1. Confira a saúde. Esta rota não precisa de `Origin`:
   ```bash
   curl -sS https://<url-do-worker>/health   # {"ok":true,"version":"3.0.0","time":"..."}
   ```
2. Veja os logs (`npx wrangler tail`) e procure `config_missing`, `github_error` ou `unhandled`.
3. Se o `/health` responde e as outras rotas dão `502 upstream`, o problema está no GitHub ou no token.
   Se dão `500 server`, procure `config_missing` (secret ausente).
4. Edição urgente com o Worker fora: commit direto no `index.html`, sem mexer nos marcadores `data-cms`,
   e conferência da CI (veja [Restaurar uma versão do site](#restaurar-uma-versão-do-site)).

O status da Cloudflare e do GitHub fica fora do repositório.
<!-- VERIFY: páginas de status https://www.cloudflarestatus.com e https://www.githubstatus.com -->

### Senha ou sessão de um usuário comprometida

1. Um admin redefine a senha do usuário (`POST /users/password`). Isso derruba **todas** as sessões dele.
   Se a conta não for mais necessária, remova o usuário: as sessões também caem.
2. Se a conta comprometida for de admin e houver outro admin, faça o mesmo a partir do outro admin.
3. Revise a [auditoria](#auditoria) desde a data suspeita: `publish`, `restore`, `user_create`,
   `password_reset` feitos por essa conta.
4. Desfaça publicações indevidas com uma restauração ou um commit direto.

Não existe rota para listar ou derrubar sessões de forma seletiva, nem uma forma de derrubar as sessões
de **todos** os usuários de uma vez, a não ser zerando o DO.

### Pepper vazado

Siga [Rotacionar o pepper](#rotacionar-o-pepper). Se o DO também pode ter vazado, considere todas as
senhas expostas e peça que os usuários troquem essa senha em qualquer outro serviço onde a usem.

### Token do GitHub vazado

Siga [Rotacionar o token do GitHub](#rotacionar-o-token-do-github), revogando o antigo **primeiro**.

## Pendências A CONFIRMAR

| Tema | O que falta decidir |
| --- | --- |
| Conta Cloudflare | Dono, plano, quem tem acesso a `wrangler` e aos logs |
| Token GitHub | Quem gera, conta, validade e quem renova |
| URL do Worker | Valor final em `admin/config.js` e na CSP do painel |
| Turnstile | Ligar ou não. Se ligar, o login por `curl` deixa de funcionar |
| Administradores | Quem são os admins (recomendado: pelo menos dois, de pessoas diferentes) |
| Recuperação | Quem pode definir `RECOVERY_SECRET` (acesso à conta Cloudflare) |
| Backup | Exportação periódica de usuários e auditoria |
| Alertas | Quem recebe e por qual canal |
| LGPD | Retenção de IP e de nomes digitados na auditoria |
