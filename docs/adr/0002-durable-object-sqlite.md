<!-- generated-by: gsd-doc-writer -->
# ADR 0002: Durable Object SQLite (`CmsState`) para usuários, sessões, rate limit e auditoria

- **Status:** aceita (substitui o desenho com Workers KV do contrato v2)
- **Componentes:** `api/src/state.ts`, `api/wrangler.toml` (`[[durable_objects.bindings]]`, `[[migrations]] new_sqlite_classes`)

## Contexto

O Worker não tem estado entre pedidos e precisa guardar:

- usuários (hash de senha, papel);
- sessões (hash do token, último uso);
- contadores de tentativas de login, que precisam ser **exatos sob concorrência** (sem isso, o rate
  limit pode ser contornado com pedidos em paralelo);
- auditoria das ações.

O desenho anterior (contrato v2) usava **Workers KV**, com chaves `user:*`, `sess:*`, `rl:*`, `audit:*`
e um índice `users:index` mantido à mão. O próprio contrato registrava: "KV não tem transação,
aceitável, documentar". Ele também exigia TTL mínimo de 60 s para o rate limit, uma limitação do KV.

## Decisão

Um único **Durable Object com storage SQLite**, a classe `CmsState`, com uma instância global
(`env.CMS_STATE.idFromName('global')`, em `api/src/app.ts`). Todas as operações de usuários,
sessões, rate limit, auditoria e metadados passam por métodos RPC do DO.

- **Tabelas** (`migrate()` em `state.ts`): `meta`, `users`, `sessions` (índice `sessions_user`),
  `rate_limits` e `audit`. A versão do esquema fica em `meta.schema_version`, porque
  `PRAGMA user_version` não é permitido no DO.
- **Atomicidade:** cada método RPC roda inteiro sem `await` sobre o SQLite síncrono, e o DO processa
  um evento por vez. Os métodos que mexem em mais de uma linha usam `ctx.storage.transactionSync`.
- **Relógio injetado:** o tempo vem do chamador (`deps.now()`), o que deixa os testes controlarem
  expiração e janelas.
- **Limpeza oportunista**, no máximo 1 vez por minuto, em `createSession` e `rateAcquire`. Ela apaga
  sessões vencidas, contadores vencidos e auditoria com mais de 365 dias (`AUDIT_RETENTION_MS`). Não
  há `alarm`.

## Alternativas consideradas

| Alternativa | Por que não |
| --- | --- |
| **Workers KV** (desenho v2) | Consistência eventual e sem transação. Um rate limit em KV deixa passar tentativas extras sob concorrência, "último admin" e "bootstrap só uma vez" viram corridas, e o índice de usuários pode divergir |
| **D1** (SQLite gerenciado) | Daria SQL e transações, mas não serializa automaticamente a lógica de *ler e decidir* entre pedidos concorrentes. As garantias de "reserva atômica antes de verificar" precisariam de outros mecanismos. Para um único conjunto pequeno de dados, um DO resolve com menos peças. Avaliação comparativa formal: **A CONFIRMAR** (não há registro de benchmark ou prova de conceito com D1 no repositório) |
| Guardar usuários no próprio repositório GitHub | Hash de senha em repositório e escrita de sessão a cada pedido via commit: inviável |

## Consequências

**Positivas**, cada uma provada em teste no runtime real (workerd + DO):

- Rate limit sem tentativa a mais: `api/test/worker/api-auth.test.ts` › "atômico: 12 tentativas
  simultâneas erradas fazem no máximo 5 verificações; o resto é 429".
- Bootstrap atômico: `api/test/worker/state.test.ts` › "bootstrap atômico: dois pedidos simultâneos
  com o DO vazio criam um admin só".
- Último admin protegido sob concorrência: `api/test/worker/api-users.test.ts` › "último admin é
  protegido mesmo com dois admins removendo um ao outro ao mesmo tempo".
- Limpeza e retenção: `state.test.ts` › "limpeza: sessão vencida e auditoria com mais de 365 dias são
  apagadas na operação seguinte".

**Negativas e custos**

- **Ponto único de serialização.** Todo pedido autenticado faz pelo menos um RPC ao DO global
  (`touchSession`, que também grava `last_seen` a cada pedido). Para o volume de um painel com poucos
  editores, isso é aceitável. A capacidade real não foi medida (**A CONFIRMAR**).
- **Backup.** Usuários e auditoria vivem só no DO. Não há rota de exportação além de `GET /audit`
  (paginado, só admin) e `GET /users` (sem hash). Uma política de backup do DO é **A CONFIRMAR**. Já o
  conteúdo do site está todo no git.
- **Migrações** são código: novas versões precisam de um bloco `if (v < N)` em `migrate()` e, se mudar a
  classe, de uma nova entrada em `[[migrations]]` no `wrangler.toml`.
- O DO grava o **IP** em `sessions.ip` e em `audit.ip`, retido por até 365 dias na auditoria. O
  enquadramento na LGPD é **A CONFIRMAR**.
