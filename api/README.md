# API do painel HG Transportes (Cloudflare Worker, v3)

O painel (`admin/`, no GitHub Pages) fala só com este Worker. O Worker guarda usuários, sessões, limite de
tentativas e auditoria num Durable Object SQLite (`CmsState`) e publica no GitHub pela Git Data API: **um
commit por publicação** (fotos + `index.html`), com checagem de base, conflito por campo e esquema
(`cms/schema.json`) validado no mesmo commit.

A documentação completa (deploy, segredos, ADRs, modelo de ameaças, API e regras de negócio) fica em
[`../docs/`](../docs/). Este arquivo só resume o dia a dia do código.

## Estrutura

| caminho                              | o que é                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `src/app.ts`                         | roteador: CORS, autenticação, limites de corpo, logs JSON, rotas                                          |
| `src/index.ts`                       | entrada do Worker (só exporta o `fetch` que chama `src/app.ts` e a classe `CmsState`)                     |
| `src/state.ts`                       | Durable Object `CmsState` (usuários, sessões, rate limit, auditoria)                                      |
| `src/publish.ts`                     | publicação/restauração atômica (rebase, conflito por campo, até 3 tentativas)                             |
| `src/github.ts`                      | cliente da Git Data API (base configurável para o mock)                                                   |
| `src/html-editor.ts`                 | edição cirúrgica do HTML (porta fiel do protótipo)                                                        |
| `src/schema.ts`                      | leitura dos marcadores `data-cms` e checagem contra `cms/schema.json`                                     |
| `src/validate.ts`, `src/password.ts` | validação por tipo, política de senha, PBKDF2 + pepper                                                    |
| `src/senhas-comuns.ts`               | 10 mil senhas vazadas (gerado por `scripts/gerar-senhas-comuns.mjs`, não editar à mão)                    |
| `src/image.ts`                       | conferência das fotos e remoção de metadados/bytes depois do fim (JPEG, PNG, WebP)                        |
| `scripts/`                           | `gerar-schema`, `validar-marcadores`, `criar-usuario` (`--recuperar` = `/recover`), `gerar-senhas-comuns` |
| `dev/`                               | mock do GitHub sobre git real, `start-dev.sh`, `stop-dev.sh`, `build-admin-dev.mjs` (CSP de dev)          |
| `e2e/`                               | E2E no Chromium (`npm run e2e`, 14 cenários; `HG_E2E_ONLY=1,3` roda só alguns)                            |
| `test/worker/`                       | testes no runtime real do Workers (workerd, com o Durable Object)                                         |
| `test/node/`                         | mock git + pipeline real, scripts, workflow de CI e paridade `admin/rules.js` x servidor                  |

## Comandos (dentro de `api/`)

```sh
npm ci
npm run check            # validar-marcadores + typecheck + lint + format:check + test
npm run gerar-schema     # depois de mexer em marcadores data-cms do index.html
dev/start-dev.sh         # mock (8788) + wrangler dev (8787) + site/painel (8781); --reset recria api/.dev-repo
npm run e2e              # sobe o ambiente do zero, roda o E2E no Chromium e derruba
HG_SENHA='...' node scripts/criar-usuario.mjs <usuario>   # primeiro admin via POST /bootstrap
dev/stop-dev.sh
```

O ambiente local nunca toca o GitHub nem a Cloudflare reais: o mock só escreve em `api/.dev-repo` (repo git
próprio, fora do repositório do site) e o estado do Durable Object fica em `api/.wrangler/state`. O `/admin`
servido na 8781 é `api/.dev-admin/` (gerado por `dev/build-admin-dev.mjs`): o `admin/index.html` versionado
tem só a CSP de produção, e a cópia de dev soma o Worker local (`http://127.0.0.1:8787`).
