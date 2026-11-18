<!-- generated-by: gsd-doc-writer -->
# ADR 0006: edição cirúrgica do `index.html` guiada por marcadores `data-cms` validados contra `cms/schema.json`

- **Status:** aceita
- **Componentes:** `api/src/html-editor.ts`, `api/src/schema.ts`, `api/src/validate.ts`, `cms/schema.json`, `api/scripts/gerar-schema.mjs`, `api/scripts/validar-marcadores.mjs`

## Contexto

- O site já existia como um `index.html` escrito à mão (cerca de 64 KB), com design próprio. O
  conteúdo editável está espalhado pelo HTML: textos, `<meta>`, links de WhatsApp, `tel:`, `mailto:`,
  mapas, contadores e fotos.
- O protótipo do painel já editava o HTML por regex sobre marcadores `data-cms`, `data-cms-type`,
  `data-cms-label`, `data-cms-group`, `data-cms-href` e `data-sep`. A UX foi aprovada.
- Uma edição por regex num HTML arbitrário pode corromper o arquivo: marcador dentro de comentário ou
  `<script>`, `>` dentro de atributo, elemento aninhado do mesmo tipo, atributo sem aspas duplas.

## Decisão

1. **Marcadores no próprio HTML.** Cada trecho editável tem `data-cms="<chave>"`. O tipo (`text`,
   `meta`, `address`, `number`, `phone`, `whatsapp`, `email`, `link`, `image`) define o que muda: o
   conteúdo interno, ou o atributo `content`/`href`/`src`/`data-count`. Links derivados
   (`data-cms-href`) são recalculados: `tel:`, `mailto:`, Google Maps e `phone=` do WhatsApp.
2. **Edição cirúrgica** (`html-editor.ts`, porta fiel do protótipo): só os trechos marcados mudam, e o
   resto do arquivo fica igual byte a byte. Texto e atributo são sempre escapados. As substituições
   usam função, nunca string, então `$&` e `$1` entram como texto.
3. **Esquema versionado** `cms/schema.json` (`version: 1`, 98 campos), gerado a partir dos marcadores
   pelo **mesmo código** do Worker (`scripts/gerar-schema.mjs` importa `src/schema.ts`, que o Node
   ≥ 22.18 executa direto).
4. **Duas leituras independentes** do HTML (`checkAgainstSchema`): a regex de tag igual à do editor
   e um tokenizador mínimo que entende comentários, `<script>`, `<style>`, `<title>`, `<textarea>` e
   aninhamento. Se as duas divergirem, o HTML é recusado. Também são recusados: marcador faltando,
   duplicado, de outro tipo ou fora do esquema; atributo editado sem aspas duplas; `data-cms-href`
   apontando para um tipo que não deriva link.
5. **O esquema é verificado em três momentos:** na CI (`validar-marcadores` e `gerar-schema --check`),
   em toda publicação contra o esquema do **mesmo commit** do HEAD (`409 schema_mismatch` se falhar) e
   no resultado da edição, antes do commit (`IntegrityError`).
6. O esquema pode **apertar** o limite de tamanho de um tipo (`max`), nunca afrouxar (`parseSchema`
   exige `max ≤ TYPE_MAX[type]`).

## Alternativas consideradas

| Alternativa | Por que não |
| --- | --- |
| CMS headless (conteúdo em API externa) | Conteúdo em runtime e dependência externa no carregamento do site ([ADR 0001](0001-pages-mais-worker.md)) |
| JSON de conteúdo separado + template/gerador estático | Exige reescrever o site como template e adicionar um passo de build ao Pages. Aumenta o escopo sobre um HTML já aprovado |
| JSON de conteúdo lido pelo JS do site | Conteúdo depende de JS, com "flash" de conteúdo e impacto em SEO |
| Parser HTML completo (DOM) para reescrever | Serializar o DOM reformata o arquivo inteiro (aspas, espaços, entidades), e o diff deixa de ser cirúrgico. A abordagem escolhida usa o tokenizador só para **recusar** o que a regex trataria mal |

## Consequências

**Provas em teste**

- `api/test/worker/properties.test.ts`, sobre as 98 chaves do site real: "aplicar o valor original
  devolve o arquivo idêntico byte a byte", "aplicar v e depois o original volta ao byte original",
  "aplicar v duas vezes = aplicar uma vez (idempotência)", "strings hostis aleatórias nunca criam tag
  nova nem mexem fora do trecho do campo" e "valor válido volta idêntico na leitura (forma canônica do tipo)".
- `api/test/worker/html-editor.test.ts`: escape (`<script>`, aspas, `$&`), links derivados por tipo,
  marcador quebrado.
- `api/test/worker/schema.test.ts`: "cms/schema.json versionado é exatamente o que o gerador produz
  hoje (sem desvio)", "marcador dentro de comentário ou script conta como duplicado/lugar inválido" e
  "estruturas que a edição por regex corromperia são recusadas".
- `api/test/worker/api-content.test.ts` › "/publish: esquema do mesmo commit" (4 testes).
- `api/test/node/scripts.test.ts`: os scripts saem com código 1 quando há problema.

**Riscos e custos**

- **Quem edita o `index.html` à mão precisa manter os marcadores e rodar `npm run gerar-schema`.** Se
  o HTML publicado divergir do esquema, o painel fica bloqueado (`schema_mismatch`) até um técnico
  corrigir. A CI pega isso antes do merge, mas não impede um push direto no branch.
- Adicionar um campo novo é uma mudança de código (marcador + esquema), não uma configuração do painel.
- A abordagem vale para uma página (`SITE_PAGE`). Múltiplas páginas exigiriam generalizar `page`/`schemaPath`.
