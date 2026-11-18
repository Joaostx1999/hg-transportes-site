<!-- generated-by: gsd-doc-writer -->
# ADR 0001: GitHub Pages para site e painel, Cloudflare Worker como única ponte para o GitHub

- **Status:** aceita (implementada em `api/`, `admin/`)
- **Componentes:** `admin/config.js`, `admin/index.html`, `api/src/app.ts`, `api/src/github.ts`, `api/wrangler.toml`

## Contexto

- O site da HG Transportes é uma página estática (`index.html` + `assets/`) hospedada no GitHub Pages
  (arquivo `.nojekyll` na raiz). Não há servidor de aplicação.
- O cliente precisa editar textos, contatos e fotos sem mexer em código e sem ter conta no GitHub.
- O protótipo anterior do painel falava **direto com o GitHub a partir do navegador**, com um token
  guardado no cliente e cifrado (AES/DEK, arquivo de acesso, "tela de chave"). O contrato da v2
  mandou remover tudo isso: `gh()`, `getFile/putFile`, acesso cifrado e renovação de chave.
- Qualquer token do GitHub que chega ao navegador pode ser extraído por quem tem o painel aberto,
  por uma extensão ou por um XSS. O site e o painel são públicos no Pages.

## Decisão

1. Site **e** painel continuam estáticos no GitHub Pages (`admin/` sem build, JS puro).
2. Uma API em **Cloudflare Worker** (`api/`, `name = "hg-cms-api"`) é o único componente que conhece o
   `GITHUB_TOKEN`, guardado como **secret** do Worker (`wrangler secret put`, nunca no `wrangler.toml`).
3. O painel só conhece a URL do Worker (`admin/config.js`, arquivo público, sem segredo). Ele se
   autentica com usuário e senha próprios do painel, não do GitHub.
4. O token é fine-grained, restrito a este repositório, com permissão Contents RW e data de validade.
   O Worker lê o cabeçalho `github-authentication-token-expiration` de toda resposta do GitHub
   (`api/src/github.ts`, `parseTokenExpiration`) e devolve `githubTokenExpiresAt` no `/me` só para
   admin. O painel mostra um aviso quando faltam menos de 30 dias.

## Alternativas consideradas

| Alternativa | Por que não |
| --- | --- |
| Token do GitHub no navegador (o protótipo) | O segredo fica exposto no cliente. Cifrar o token no navegador não resolve, porque a chave de decifrar também está lá. Removido no contrato v2 |
| CMS Git-based (Decap, Sveltia, Tina) | Exigem conta GitHub (ou OAuth do GitHub) por usuário editor, o que o cliente não tem (motivo registrado no contrato v3) |
| Conteúdo em runtime (ex.: Supabase lido pelo JS do site) | O site passaria a depender de uma API no carregamento. O conteúdo aparece só depois do JS (pior para SEO e com "flash" de conteúdo). Hoje o HTML publicado já traz o texto final |
| Backend PHP ou servidor próprio (VPS, hospedagem compartilhada) | Mais um servidor para manter, atualizar e proteger, e o site sairia do Pages ou ganharia uma dependência. Não há PHP nem Docker no projeto (contrato v2: "Sem PHP, sem Docker") |
| Worker que serve o site | Desnecessário: o Pages já serve o estático. O Worker fica restrito à escrita |

## Consequências

**Positivas**

- O site público **não depende do Worker**. Se a API cair, só a edição para (veja [operacao.md](../operacao.md)).
- O token do GitHub nunca sai do Worker. O cliente HTTP só o envia como `Authorization: Bearer` para
  `GITHUB_API_BASE`. Erros do GitHub viram `502 upstream` com mensagem genérica, e o log guarda só
  `github_<status>`. Provas: `api/test/worker/api-content.test.ts` › "GitHub fora do ar ou 500: 502
  upstream genérico, sem vazar token" e "o token vai como Bearer só para o GitHub; credencial recusada
  vira 502 com log de erro".
- O histórico do conteúdo é o próprio histórico git, com autor `<usuário> (painel)` em cada commit.

**Negativas e custos**

- Dois provedores (GitHub e Cloudflare) e duas origens (Pages e `workers.dev`). Por isso o Worker
  precisa de CORS com allowlist exata, e o painel precisa de `connect-src` na CSP.
- Depois de cada commit, o site público só muda quando o Pages termina o build. O painel compensa na
  prévia, igualando o DOM do iframe ao HTML do servidor. O tempo real de propagação do Pages é **A CONFIRMAR**.
- O token fine-grained expira e precisa ser renovado manualmente. Quem é o responsável é **A CONFIRMAR**
  (veja [operacao.md](../operacao.md#rotacionar-o-token-do-github)).
- A pasta `api/` também vai para o Pages, porque está no mesmo repositório. Ela não tem segredo
  (`.dev.vars` está no `.gitignore`), mas o código da API fica público.
