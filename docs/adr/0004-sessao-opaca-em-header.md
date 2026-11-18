<!-- generated-by: gsd-doc-writer -->
# ADR 0004: sessão por token opaco no header `Authorization`, guardada como hash no DO

- **Status:** aceita
- **Componentes:** `api/src/app.ts` (`TOKEN_RE`, `bearer`, `handle`), `api/src/state.ts` (`createSession`, `touchSession`)

## Contexto

- O painel (`https://<usuário>.github.io/...`) e a API (`*.workers.dev`) estão em **origens
  diferentes**. Cookies entre origens exigiriam `SameSite=None; Secure` e abririam a superfície de
  CSRF.
- É preciso conseguir **revogar** sessões: no logout, na troca de senha e ao remover um usuário.
- Expiração por inatividade e expiração absoluta são requisitos (`SESSION_IDLE_SECONDS`,
  `SESSION_MAX_SECONDS`).

## Decisão

- No login, o Worker gera 32 bytes aleatórios e os codifica em **base64url (43 caracteres)**. O
  cliente recebe o token uma única vez.
- O DO guarda **só o SHA-256 do token** (`sessions.token_hash`), junto com `username`, `created_at`,
  `last_seen` e `ip`.
- O token vai em `Authorization: Bearer <token>`, e o Worker aceita só o formato
  `^Bearer ([A-Za-z0-9_-]{43})$`.
- O painel guarda o token em `sessionStorage`: ele morre com a aba e não é compartilhado entre abas.
  O painel não usa cookie.
- `touchSession` valida a sessão e grava `last_seen` a cada pedido. Ela recusa (e apaga) a sessão se
  `now - last_seen > idle` (padrão 1 h) ou `now - created_at > max` (padrão 12 h).
- **Rotação no login:** se o login chegar com um token antigo em `Authorization`, o token antigo é apagado.
- **Revogação:** `/logout` apaga a sessão. A troca de senha apaga as outras sessões do usuário (a
  atual continua). A redefinição por admin apaga todas as sessões do alvo, exceto a do próprio admin
  quando o alvo é ele mesmo. Remover um usuário apaga as sessões dele.
- **CORS** com allowlist exata (`ALLOWED_ORIGINS`) e `Vary: Origin`. Pedido sem `Origin` é recusado,
  exceto em `/health` e `/bootstrap`.

## Alternativas consideradas

| Alternativa | Por que não |
| --- | --- |
| **JWT** (stateless) | A revogação exigiria uma lista de bloqueio, ou seja, estado de novo. A inatividade exigiria renovar o token. O payload ainda carregaria papel e usuário, que podem ficar defasados (ex.: admin rebaixado). Como o DO já é consultado a cada pedido, um token opaco é mais simples e revogável na hora |
| **Cookie `HttpOnly` cross-site** | Exige `SameSite=None` entre Pages e `workers.dev`, além de proteção CSRF (token anti-CSRF ou checagem de origem como única barreira). Também depende do tratamento que o navegador dá a cookies de terceiros. Com header, não há envio automático de credencial, então CSRF não se aplica |
| Token em `localStorage` | Sobreviveria ao fechar a aba e seria visível a todas as abas da origem. `sessionStorage` reduz a janela. As duas opções são legíveis por um XSS no painel |

## Consequências

**Provas em teste** (`api/test/worker/api-auth.test.ts` e `api/test/worker/state.test.ts`):

- "login ok devolve token de 256 bits, user e expiresIn; /me; /logout apaga no servidor";
- "o DO guarda só o hash do token";
- "sessão expira por inatividade (1 h) e é renovada pelo uso";
- "sessão expira por tempo absoluto (12 h) mesmo com uso contínuo";
- "rotação: login com o token antigo no Authorization invalida o antigo";
- "token malformado: unauthenticated; token bem formado desconhecido: session_expired";
- "preflight de origem permitida: 204 com cabeçalhos exatos e de segurança";
- "origem não listada: 403 cors sem ACAO, inclusive no preflight e em /health";
- "sem Origin: 403 (o painel sempre manda), exceto /health e /bootstrap";
- `state.test.ts` › "touchSession: inatividade e tempo absoluto; renova last_seen" e "setPassword mantém só a sessão indicada".

**Riscos e custos**

- **XSS no painel rouba o token** enquanto a aba estiver aberta. As mitigações estão no front: CSP
  restritiva via `<meta>`, dados entrando só por `textContent` e atributos, `DOMParser` inerte. Não
  existe `HttpOnly` para proteger o token.
- **CORS não autentica.** Um cliente fora do navegador (ex.: `curl`) pode mandar qualquer `Origin`.
  A allowlist protege usuários de navegador, e a barreira real é o token.
- Cada pedido autenticado escreve no DO (`UPDATE sessions SET last_seen`). Veja o custo no [ADR 0002](0002-durable-object-sqlite.md).
- Não há rota de "sair de todos os dispositivos" para o próprio usuário. O efeito equivalente é
  trocar a senha, que derruba as outras sessões.
