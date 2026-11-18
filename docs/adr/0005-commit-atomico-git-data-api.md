<!-- generated-by: gsd-doc-writer -->
# ADR 0005: publicação em um commit atômico via Git Data API, com base e conflito por campo

- **Status:** aceita (substitui o fluxo `PUT /contents` + `/upload` do contrato v2)
- **Componentes:** `api/src/publish.ts` (`parsePublishRequest`, `publish`, `restore`), `api/src/github.ts` (`GitApi`, `createGitHub`)

## Contexto

- Uma publicação pode trocar textos **e** fotos. No desenho v2, cada foto era um commit (`/upload`
  via Contents API) e o `index.html` era outro. Se o segundo falhasse, as fotos ficavam órfãs, e o
  histórico mostrava estados intermediários.
- Duas pessoas podem abrir o painel na mesma versão e publicar alterações diferentes. Recusar sempre
  que a base for antiga incomoda à toa. Sobrescrever sem olhar perde trabalho.
- O branch pode andar *durante* a publicação (outro editor, ou um push manual).

## Decisão

`POST /publish {base, changes, images}` executa, em até `MAX_ATTEMPTS = 3` tentativas:

1. **Lê o HEAD** (`GET git/ref/heads/<branch>`), o commit dele, o `index.html` e o
   `cms/schema.json` **do mesmo commit**. Se o HTML do HEAD não conferir com o esquema, responde
   `409 schema_mismatch` ([ADR 0006](0006-edicao-cirurgica-por-marcadores.md)).
2. **Valida** as chaves e os valores pelo esquema do HEAD (tipo e `max`). Uma chave `image` em
   `changes` é recusada, porque foto só entra por `images`.
3. **Base ≠ HEAD:** compara, para cada chave pedida, o valor (e o tipo) em `base` e em `HEAD`. Se algum
   mudou, responde `409 conflict` com `fields[chave]`. Se nenhum mudou, faz **rebase**: aplica sobre o
   HEAD e preserva a alteração do outro editor. Base inexistente também dá `409 conflict`.
4. **Aplica** a edição cirúrgica sobre o HEAD. Um valor igual ao atual (na forma canônica do tipo) não
   é reaplicado. Se nada mudar de fato, responde `400 "Nenhuma alteração."`.
5. **Confere o resultado** antes de escrever: o esquema continua íntegro, os campos alterados têm o
   valor pedido e todos os outros campos estão iguais ao HEAD. Se falhar, lança `IntegrityError` → `500`.
6. **Um commit:** blobs das fotos (caminho `assets/fotos/cms-<16 hex>.<ext>` gerado pelo servidor e
   reaproveitado entre tentativas) e do `index.html`, depois `POST git/trees` com `base_tree` = tree do
   HEAD, `POST git/commits` com `parents: [HEAD]` e autor/committer `"<usuário> (painel)"`, e por fim
   `PATCH git/refs/heads/<branch>` com `force: false`.
7. Se o `PATCH` for recusado (`422`/`409`, não fast-forward), recomeça do passo 1 sobre o novo HEAD.
   Depois de 3 tentativas, responde `409 conflict`.

`POST /restore {commit, base}` usa a mesma lógica, mas é mais estrito: `base` precisa ser **igual**
ao HEAD (não há rebase). O HTML antigo precisa passar no esquema **atual**. O commit novo contém só o
`index.html` daquela versão.

## Alternativas consideradas

| Alternativa | Por que não |
| --- | --- |
| **Contents API** (`PUT /contents/:path` com `sha`), um commit por arquivo (desenho v2) | Não é atômica entre arquivos (foto + HTML). Fotos ficam órfãs em falha parcial, e o histórico ganha commits intermediários |
| Conflito pelo `sha` do arquivo inteiro (v2) | Recusa qualquer publicação com base antiga, mesmo que o outro editor tenha mexido em campos diferentes |
| Merge de texto (diff3) do HTML | Pode gerar HTML inválido ou misturar trechos. O conflito por **campo** usa a unidade que o usuário entende |
| `force: true` no ref | Sobrescreveria commits feitos por outra pessoa entre a leitura e a escrita |
| Lock no DO durante a publicação | Não protege contra push feito fora do painel. O `PATCH` sem force já é o controle de concorrência do próprio GitHub |

## Consequências

**Provas em teste** (`api/test/worker/api-content.test.ts`, GitHub falso em memória):

- "muda só o trecho marcado; autor, committer e mensagem do painel; um único commit";
- "fotos vão no MESMO commit do index.html; o servidor gera o caminho";
- "base diferente do HEAD, campos diferentes: rebase sobre o HEAD (mantém a mudança do outro)";
- "outra pessoa mudou o MESMO campo: 409 conflict com o campo em fields; nada é escrito";
- "foto: conflito também vale para campo image";
- "base que não existe: 409";
- "corrida entre a leitura e o PATCH: refaz sobre o HEAD novo (2ª tentativa), um commit só";
- "corrida mexendo no MESMO campo durante o PATCH: 409 na nova tentativa";
- "branch andando sem parar: desiste depois de 3 tentativas com 409";
- "restore: mesmo pipeline (um commit, base = HEAD, esquema validado)".

Contra um **git real** (mock em `api/dev/github-mock.mjs`), em `api/test/node/github-mock.test.ts`:
"publish com foto: UM commit com a foto e o index.html; autor do painel; working tree atualizado",
"conflito por campo e rebase passando pelo git real" e "history e restore pelo mesmo pipeline".

**Riscos e custos**

- Cada publicação faz cerca de 8 a 10 chamadas à API do GitHub, mais 1 blob por foto, e repete isso a
  cada nova tentativa. O consumo de cota da API não foi medido (**A CONFIRMAR**, mas é irrelevante no
  volume esperado).
- **O restore restaura só o `index.html`.** Fotos enviadas depois daquela versão continuam em
  `assets/fotos/`, sem referência. Não existe limpeza de fotos órfãs.
- O restore não faz rebase. Se outra pessoa publicou depois que o painel carregou, o restore dá `409`
  e o usuário precisa recarregar.
- O corpo do `/publish` vai até 12 MB (fotos em base64), lido inteiro em memória no Worker.
  <!-- VERIFY: limite de memória do isolate do Workers no plano de produção comporta 12 MB de corpo + decodificação -->

## Atualização (revisão de código, C1 e C10)

- O pedido ganhou `expected` (o valor publicado que o painel mostrava em cada campo enviado). O servidor
  compara com o HEAD na forma canônica do tipo e responde `409 conflict` no campo que não bate, **mesmo
  quando `base` já é o HEAD**. Isso fecha o caso em que o painel avançava a base depois de um rebase sem
  recarregar os campos e a edição seguinte apagava a mudança de outra pessoa sem conflito.
- A resposta traz `rebased` e, quando houve rebase, `othersChanged`; o painel recarrega o conteúdo novo
  (mantendo o que ainda não foi publicado) e avisa quais campos mudaram.
- A comparação de tipo no conflito (`b.type === h.type`) ficou, com teste: tipo trocado no HEAD com o
  mesmo texto (ex.: `phone` → `text`) é mudança de outra pessoa.
- Prova: `api-content.test.ts` › "B4: base já avançada pelo rebase, mas o valor que o painel viu está
  velho: 409 no campo", "rebase: a resposta diz rebased e quais campos outra pessoa mudou entre a base e
  o HEAD", "outra pessoa trocou o tipo do campo (phone -> text) sem mudar o valor: 409 no campo"; E2E
  cenário 8 (B1 a B4).
