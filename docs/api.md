<!-- generated-by: gsd-doc-writer -->
# API do painel (Cloudflare Worker `hg-cms-api`, v3.0.0)

Fonte da verdade: `api/src/app.ts` (rotas e entrada), `api/src/http.ts` (erros e cabeçalhos),
`api/src/publish.ts` (publicação), `api/src/state.ts` (estado). A URL base de produção é
**A CONFIRMAR** (hoje `admin/config.js` tem o placeholder `https://hg-cms-api.SEU-SUBDOMINIO.workers.dev`).
Local: `http://127.0.0.1:8787`.

## Convenções

- **Formato.** Toda resposta é JSON (`application/json; charset=utf-8`). Sucesso: `{ "ok": true, ... }`.
  Erro: `{ "ok": false, "error": "<mensagem pt-BR>", "code": "<código>", "fields"?: { "<chave>": "<mensagem>" } }`.
- **Autenticação.** `Authorization: Bearer <token>`, onde o token tem exatamente 43 caracteres base64url
  (`^Bearer ([A-Za-z0-9_-]{43})$`). Sem cookie.
- **Corpo.** Todo `POST` com corpo exige `Content-Type: application/json` e um objeto JSON em UTF-8
  estrito. Corpo vazio vale `{}`.
- **Limites de corpo** (`LIMITS` em `app.ts`): `/login`, `/bootstrap` e `/recover` 4 KB; `/publish` 12 MB; demais
  `POST` 64 KB. O limite é aplicado lendo o stream, não só pelo `Content-Length`. Acima dele: `413 too_large`.
- **Ordem de checagem** em `handle()`: CORS → rota/método → sessão → papel → leitura do corpo → regra
  da rota. Por isso um `413` em `/publish` acontece antes de qualquer chamada ao GitHub.
- **Rota** é comparada sem a barra final (`/me/` = `/me`).

### CORS

- Só as origens de `ALLOWED_ORIGINS` (separadas por vírgula), com **comparação exata**.
- Origem presente e fora da lista: `403 cors` em qualquer rota, inclusive no preflight e em `/health`,
  e **sem** `Access-Control-Allow-Origin`.
- Pedido **sem** `Origin`: `403 cors`, exceto `GET /health`, `POST /bootstrap` e `POST /recover` (`noOrigin`).
- Preflight `OPTIONS` de origem permitida responde `204` com
  `Access-Control-Allow-Methods: GET,POST,OPTIONS`, `Access-Control-Allow-Headers: Authorization,Content-Type`
  e `Access-Control-Max-Age: 600`.
- Respostas a origens permitidas levam `Access-Control-Allow-Origin: <origem>` e
  `Access-Control-Expose-Headers: Retry-After`.

### Cabeçalhos em toda resposta

Sucesso, erro, preflight e recusa de CORS (`SECURITY_HEADERS` em `http.ts`):

```
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
Strict-Transport-Security: max-age=31536000
Cross-Origin-Opener-Policy: same-origin
Vary: Origin
```

`429` traz também `Retry-After: <segundos>`.

## Códigos de erro

| `code` | HTTP | Quando |
| --- | --- | --- |
| `bad_request` | 400 | Pedido malformado; JSON inválido; `Content-Type` diferente de JSON; `base` ausente ou malformada; `expected` inválido; "Nenhuma alteração."; mais de 200 alterações ou mais de 6 fotos; remover a si mesmo ou o último admin; `/users/password` no próprio usuário; restaurar a versão que já é a atual; usuário inválido em `/users/delete` e `/users/password` |
| `unauthenticated` | 401 | `Authorization` ausente ou fora do formato |
| `session_expired` | 401 | Token bem formado, mas desconhecido, vencido (inatividade ou tempo absoluto), revogado ou de usuário removido |
| `invalid_credentials` | 401 | Login errado. Mensagem sempre "Usuário ou senha incorretos." |
| `forbidden` | 403 | Editor numa rota de admin; `/bootstrap` ou `/recover` recusado (sem secret, secret curto, errado ou já usado) |
| `cors` | 403 | Origem fora da lista, ou sem `Origin` onde é exigido |
| `not_found` | 404 | Rota inexistente; usuário inexistente; no `/restore`, versão inexistente **ou fora do histórico do branch que tocou o `index.html`**; no `/recover`, admin inexistente |
| `method` | 405 | Caminho existe, método não |
| `conflict` | 409 | Conflito por campo no `/publish` (outra pessoa mudou o campo desde a `base`, ou o `expected` do campo não é o valor do HEAD); `base` inexistente; branch andou 3 vezes; `/restore` com `base` ≠ HEAD; usuário duplicado |
| `schema_mismatch` | 409 | HTML do HEAD (ou da versão a restaurar) não confere com o `cms/schema.json` do HEAD; esquema ausente ou inválido no HEAD. `fields` = `{chave: problema}` ou `{"cms/schema.json": problema}` |
| `too_large` | 413 | Corpo acima do limite da rota; foto acima de `MAX_UPLOAD_BYTES` (`fields[chave]`) |
| `integrity` | 422 | A verificação final do resultado da edição falhou (não deveria acontecer). `fields` = `{chave: "Este campo não ficou como esperado depois da edição."}`; nada é publicado |
| `validation` | 422 | Campos inválidos (`fields`). Inclui `turnstileToken` ausente ou inválido, senha atual errada em `/password` (`fields.current`) e senha do admin ausente ou errada nas rotas `/users/*` (`fields.currentPassword`) |
| `rate_limited` | 429 | Bloqueio por tentativas, ou atraso progressivo do contador global do usuário (`Retry-After` de 1 a 30 s), com `Retry-After` |
| `server` | 500 | Erro interno com mensagem genérica: `PASSWORD_PEPPER`/`GITHUB_TOKEN` ausente, `GITHUB_API_BASE` fora da lista permitida, exceção não tratada |
| `upstream` | 502 | GitHub falhou (rede, 4xx/5xx, resposta inesperada), arquivo do site não encontrado ou fora de UTF-8, Turnstile `siteverify` indisponível |

## Rotas

| Método | Caminho | Auth | Limite de corpo |
| --- | --- | --- | --- |
| GET | `/health` | nenhuma (Origin opcional) | — |
| POST | `/login` | nenhuma | 4 KB |
| POST | `/logout` | usuário | 64 KB |
| GET | `/me` | usuário | — |
| GET | `/content` | usuário | — |
| POST | `/publish` | usuário | 12 MB |
| GET | `/history` | usuário | — |
| POST | `/restore` | usuário | 64 KB |
| POST | `/password` | usuário | 64 KB |
| GET | `/users` | admin | — |
| POST | `/users/create` | admin | 64 KB |
| POST | `/users/delete` | admin | 64 KB |
| POST | `/users/password` | admin | 64 KB |
| GET | `/audit` | admin | — |
| POST | `/bootstrap` | nenhuma (Origin opcional) | 4 KB |
| POST | `/recover` | nenhuma (Origin opcional), só com `RECOVERY_SECRET` | 4 KB |

Não existe `/upload`: as fotos vão em `images` no `/publish`.

### `GET /health`

```json
{ "ok": true, "version": "3.0.0", "time": "2026-11-17T12:00:00.000Z" }
```

### `POST /login`

Pedido:

```json
{ "username": "ana", "password": "••••••••••", "turnstileToken": "<só se TURNSTILE_SECRET existir>" }
```

Resposta 200:

```json
{ "ok": true, "token": "<43 chars base64url>", "user": { "username": "ana", "role": "admin" }, "expiresIn": 3600 }
```

- `username` passa por trim e fica em minúsculas. Senha com mais de 200 caracteres é tratada como vazia.
- Com `TURNSTILE_SECRET`: token ausente, vazio, com mais de 2048 caracteres ou inválido dá
  `422 fields.turnstileToken`. Se o `siteverify` estiver fora do ar, `502 upstream`. A checagem do
  Turnstile acontece **antes** do rate limit.
- Erros: `401 invalid_credentials` (usuário inexistente e senha errada dão a mesma resposta), `429 rate_limited`.
- Limites: 5 falhas por usuário+rede e 20 por rede em 15 min (a rede é o IPv4, ou o /64 do IPv6). Além
  disso, um contador por usuário (todas as redes): passou de 50 tentativas em 1 h, cada nova tentativa
  espera 1 s, 2 s, 4 s… até 30 s desde a anterior *admitida* (`429` com `Retry-After` curto). Essa recusa
  conta como falha no limite da rede (20/15 min) e não estende o atraso. Com Turnstile verificado no
  pedido, essa espera é dispensada.
- Se o pedido trouxer um `Authorization: Bearer <token antigo>`, esse token é revogado (rotação).
- `expiresIn` é o tempo de inatividade em segundos (`SESSION_IDLE_SECONDS`).

### `POST /logout`

Apaga a sessão no servidor. Resposta: `{ "ok": true }`.

### `GET /me`

```json
{ "ok": true, "user": { "username": "ana", "role": "admin" }, "githubTokenExpiresAt": "2027-01-15T12:00:00.000Z" }
```

`githubTokenExpiresAt` só aparece para **admin**, e só quando o GitHub informou a validade pelo
cabeçalho `github-authentication-token-expiration`. O valor vem de `meta` no DO. Se não houver valor,
ou se a última checagem tiver mais de 6 h, o `/me` faz uma leitura do ref no GitHub para atualizar
(falha do GitHub é ignorada). O valor também é atualizado em qualquer rota bem-sucedida que fale com o GitHub.

### `GET /content`

```json
{ "ok": true, "html": "<!doctype html>…", "commit": "<sha40 do HEAD>", "schemaVersion": 1,
  "fields": [ { "key": "topo.selo2", "type": "text", "max": 600 } ] }
```

`fields` traz tipo e limite de cada campo, do esquema do **mesmo** commit; o painel usa o `max` daqui
(com as regras de `admin/rules.js`, iguais às do servidor). `schemaVersion` e `fields` são `null` se o
`cms/schema.json` do HEAD estiver ausente ou inválido. Erros: `502 upstream`.

### `POST /publish`

Pedido:

```json
{
  "base": "<sha40 recebido no /content>",
  "changes": { "contato.whatsapp": "(51) 99377-5912", "topo.titulo1": "Novo título" },
  "images": { "<chave de campo image>": { "type": "image/jpeg", "data": "<base64>" } },
  "expected": { "contato.whatsapp": "(51) 99999-0000", "topo.titulo1": "Título publicado que o painel via" }
}
```

Resposta 200:

```json
{ "ok": true, "commit": "<sha40 novo>", "changed": ["topo.titulo1", "<chave image>"], "rebased": true,
  "othersChanged": ["topo.titulo3"], "paths": { "<chave image>": "assets/fotos/cms-0123456789abcdef.jpg" } }
```

`paths` só aparece quando houve foto. `rebased` diz se a `base` era antiga (outra pessoa publicou outros
campos); nesse caso `othersChanged` lista os campos que mudaram entre a `base` e o HEAD, e o painel
recarrega o `/content`. Regras de entrada (`parsePublishRequest`):

- `base`: 40 hex (o valor é convertido para minúsculas). Senão `400`.
- `changes` e `images` precisam ser objetos. Os dois vazios dão `400 "Nenhuma alteração."`. Mais de 200
  `changes` ou mais de 6 `images` dão `400`.
- Valor de `changes` que não seja string: `422 "Valor inválido."`. Os valores são normalizados
  (CRLF/CR → LF, trim) e validados pelo tipo e pelo `max` do esquema do HEAD (veja
  [regras-de-negocio.md](regras-de-negocio.md#validação-de-campos)).
- `images[k]`: `type` ∈ `image/jpeg|image/png|image/webp` e `data` em base64 estrito (prefixo
  `data:<type>;base64,` aceito). O tamanho decodificado precisa ser ≤ `MAX_UPLOAD_BYTES` (3 MiB), senão
  `413` com `fields[k]`. Os bytes mágicos precisam bater com `type`, senão `422`. A mesma chave não pode
  estar em `changes`.
- Chave desconhecida: `422 "Campo desconhecido."`. Campo `image` em `changes`: `422 "Para trocar a
  foto, envie a imagem."`. Chave de `images` que não é `image`: `422`.
- `expected` (opcional, mas o painel sempre manda): objeto `{chave: texto}` só com chaves que estão em
  `changes` ou `images`, valores em texto (até 2000 caracteres); senão `400`. Para cada chave, o valor é
  comparado com o do HEAD na forma canônica do tipo (espaço repetido num texto não conta; WhatsApp
  comparado pelos dígitos normalizados; foto pelo caminho). Diferente: `409 conflict` naquele campo,
  **mesmo com `base` = HEAD**.
- As fotos são gravadas **sem metadados**: o servidor tira EXIF/GPS, XMP, IPTC, comentários e textos PNG e
  corta qualquer byte depois do fim da imagem. Estrutura quebrada (sem EOI/IEND, segmento maior que o
  arquivo): `422` em `fields[k]`.

Erros de fluxo: `409 conflict` (com `fields` nos campos em conflito), `409 schema_mismatch`,
`422 integrity` (verificação final; `fields` com o campo) e `502 upstream`. O processo completo está no [ADR 0005](adr/0005-commit-atomico-git-data-api.md).

Mensagem do commit:

```
Painel: <usuário> alterou N campo(s)

- <chave>: <rótulo do esquema>
```

Autor e committer: `{ name: "<usuário> (painel)", email: "<usuário>@painel.hgtransportes.invalid" }`.

### `GET /history`

```json
{ "ok": true, "versions": [ { "commit": "<sha40>", "date": "<ISO ou null>", "author": "ana (painel)", "message": "Painel: ana alterou 1 campo(s)\n\n- …" } ] }
```

Lista até 30 commits que tocaram `SITE_PAGE` no branch. `message` é truncada em 500 caracteres.

### `POST /restore`

Pedido: `{ "commit": "<sha40 da versão>", "base": "<sha40 do HEAD visto pelo painel>" }`. Resposta: `{ "ok": true, "commit": "<sha40 novo>" }`.

Erros: `400` (SHA malformado ou versão igual à atual), `409 conflict` (`base` ≠ HEAD ou o branch andou
no `PATCH`), `404` (versão inexistente, sem o arquivo, ou que **não está entre as 100 versões mais novas do
`index.html` no branch**: um commit de outro ref, como `refs/pull/N/head`, não é versão),
`409 schema_mismatch` (a versão não passa no esquema atual). Mensagem do commit: `Painel: <usuário> voltou o site para a versão <7 hex>`.

### `POST /password` (o próprio usuário)

Pedido: `{ "current": "…", "new": "…" }`. Resposta: `{ "ok": true }`.

- Usa o **mesmo rate limit do login** (chaves `login:u:<usuário>:<ip>` e `login:ip:<ip>`). Bloqueado: `429`.
- Senha atual errada: `422 fields.current = "Senha atual incorreta."` (conta como falha).
- Nova senha fora da política, ou igual à atual: `422 fields.new`.
- Em caso de sucesso, apaga as **outras** sessões do usuário. A atual continua.

### `GET /users` (admin)

```json
{ "ok": true, "users": [ { "username": "ana", "role": "admin", "created_at": "<ISO>", "last_login_at": "<ISO ou null>", "pepper_current": true } ] }
```

A lista nunca traz hash, sal ou iterações. `pepper_current: false` = o hash ainda usa o pepper anterior
(a pessoa não entrou desde a rotação; veja [operacao.md](operacao.md#rotacionar-o-pepper)).

**As três rotas abaixo exigem `currentPassword`** (a senha atual do admin logado). Ausente:
`422 fields.currentPassword = "Digite a sua senha para confirmar."`; errada:
`422 fields.currentPassword = "Sua senha está incorreta."`. As tentativas usam o mesmo limite do login
(`429` com `Retry-After`) e aparecem na auditoria como `reauth_fail`.

### `POST /users/create` (admin)

Pedido: `{ "username": "edu", "password": "…", "role": "editor", "currentPassword": "<senha do admin>" }`. Resposta: `{ "ok": true, "user": { "username": "edu", "role": "editor" } }`.
Erros: `422` (`fields.username`, `fields.password`, `fields.role`, `fields.currentPassword`), `429` e `409 conflict` (usuário já existe).

### `POST /users/delete` (admin)

Pedido: `{ "username": "edu", "currentPassword": "<senha do admin>" }`. Resposta: `{ "ok": true }`. Apaga também as sessões do usuário.
Erros: `400` (usuário inválido, remover a si mesmo, último admin), `422 fields.currentPassword`, `429` e `404`.

### `POST /users/password` (admin redefine a senha de alguém)

Pedido: `{ "username": "edu", "password": "…", "currentPassword": "<senha do admin>" }`. Resposta: `{ "ok": true }`.
Apaga todas as sessões do alvo. **Não vale para o próprio admin**: `400` mandando usar "Minha senha"
(`POST /password`, que pede a senha atual). Erros: `400`, `422 fields.password`, `422 fields.currentPassword`,
`429` e `404`.

### `GET /audit` (admin)

Query: `limit` (1 a 500, padrão 100) e `before` (id, para paginar).

```json
{ "ok": true, "entries": [ { "id": 42, "ts": "<ISO>", "username": "ana", "ip": "203.0.113.5", "action": "publish", "detail": { "commit": "…", "base": "…", "rebased": false, "attempts": 1, "changes": [ { "key": "…", "old": "…", "new": "…" } ] } } ] }
```

As entradas vêm da mais recente para a mais antiga. As ações estão em [operacao.md](operacao.md#auditoria).
O painel atual **não** chama esta rota (não há `'/audit'` em `admin/admin.js`): a leitura é feita pela API.

### `POST /bootstrap`

Pedido: `{ "secret": "<BOOTSTRAP_SECRET>", "username": "ana", "password": "…" }`. Resposta: `{ "ok": true, "user": { "username": "ana", "role": "admin" } }`.

- Sem `BOOTSTRAP_SECRET` configurado, ou com menos de 32 caracteres: sempre `403` (o segundo caso também
  registra `config_missing` no log). Apague o secret depois do bootstrap.
- Rate limit próprio: 20 falhas por IP em 15 min (chave `boot:ip:<ip>`).
- O segredo é comparado em tempo constante (SHA-256 dos dois lados).
- Se já existir qualquer usuário: `403`. A criação é atômica no DO (`onlyIfEmpty`).
- Usuário e senha passam pela mesma validação de `/users/create` (`422`).

### `POST /recover` (recuperação de admin)

Só existe enquanto o secret `RECOVERY_SECRET` está definido ([ADR 0007](adr/0007-recuperacao-e-pepper-versionado.md),
procedimento em [operacao.md](operacao.md#recuperar-o-acesso-de-admin)). Use o
`scripts/criar-usuario.mjs <admin> --recuperar`, que lê a senha sem eco.

Pedido: `{ "secret": "<RECOVERY_SECRET>", "username": "chefe", "password": "<senha nova>" }`.
Resposta: `{ "ok": true, "user": { "username": "chefe", "role": "admin" }, "sessionsRevoked": 1 }`.

- Sem `RECOVERY_SECRET`, ou com menos de 32 caracteres: sempre `403`.
- O segredo é comparado em tempo constante (SHA-256 dos dois lados). Errado: `403` (`recover_fail`).
- Limite: 5 tentativas por rede (IPv6 por /64) em 15 min (`429`).
- **Uso único:** cada valor do secret redefine uma vez (vale também para dois pedidos simultâneos); de novo
  com o mesmo valor: `403 "Este RECOVERY_SECRET já foi usado…"` (`recover_reused`).
- Só para **admin existente** (`404` para editor ou nome inexistente). Senha fora da política: `422 fields.password`.
- Derruba todas as sessões do admin e zera os limites de tentativa dele (usuário+rede e o contador global).
  Audita `recover_ok` (sem a senha, com `limitsCleared`) e loga `recovery_used`.
