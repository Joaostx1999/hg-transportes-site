<!-- generated-by: gsd-doc-writer -->
# ADR 0003: senhas com HMAC-SHA256 (pepper) → PBKDF2-SHA256, 100.000 iterações

- **Status:** aceita; a parte "pepper único" foi substituída pelo [ADR 0007](0007-recuperacao-e-pepper-versionado.md) (pepper com versão por usuário e recuperação de admin)
- **Componentes:** `api/src/password.ts`, `api/src/env.ts` (`readConfig`), `api/wrangler.toml` (`PBKDF2_ITERATIONS`)

## Contexto

- Os usuários do painel são próprios (não há IdP). Por isso o Worker precisa guardar hash de senha.
- O Worker roda no runtime da Cloudflare. A primitiva nativa e rápida de derivação de chave lá é o
  **WebCrypto** (`crypto.subtle`), que oferece PBKDF2, mas não Argon2, scrypt nem bcrypt.
- O WebCrypto da plataforma Cloudflare tem um **teto de iterações para PBKDF2**. O código fixa
  `PBKDF2_MAX_ITERATIONS = 100_000`. O teste `api/test/worker/password.test.ts` registra que o binário
  do workerd contém a mensagem `Pbkdf2 failed: iteration counts above <max> are not supported`, mas
  que **o workerd local não aplica o teto**: localmente, 100.001 e 1.000.000 passam.
- 100.000 iterações de PBKDF2-SHA256 está abaixo do que recomendações atuais pedem para PBKDF2
  isolado. <!-- VERIFY: recomendação OWASP vigente para PBKDF2-HMAC-SHA256 (600.000 iterações na edição de 2023) -->
  Por isso é preciso uma camada a mais.

## Decisão

```
material = HMAC-SHA256(key = PASSWORD_PEPPER, msg = senha)
hash     = PBKDF2-SHA256(material, salt = 16 bytes aleatórios por usuário, iterações, 256 bits)
```

- **Pepper** (`PASSWORD_PEPPER`) é um secret do Worker com no mínimo 32 caracteres
  (`PEPPER_MIN_LENGTH`). Se faltar ou for curto, `PepperError` faz o Worker responder `500 server`
  genérico (falha fechada). Como o pepper não fica no DO, um vazamento só do banco não permite
  testar senhas offline.
- **Iterações gravadas por usuário** (`users.iterations`). `clampIterations` nunca passa de 100.000, e
  valores abaixo de 10.000 (ou inválidos) voltam para 100.000. Isso permite subir as iterações no
  futuro, se o teto da plataforma mudar, sem invalidar hashes antigos.
- **Tempo constante:** `timingSafeEqual` (XOR sobre o maior comprimento). Para usuário inexistente,
  o PBKDF2 roda contra um registro `DUMMY` com sal fixo, para igualar o tempo de resposta.
- Registro adulterado (iterações que o runtime recusa) faz o `verifyPassword` devolver `false` em vez
  de derrubar o login.

## Alternativas consideradas

| Alternativa | Por que não |
| --- | --- |
| Argon2id / scrypt / bcrypt via WASM | Não são nativos no Workers. Rodar em WASM aumenta o tamanho do bundle e o custo de CPU por login, e o plano gratuito tem limite de CPU por pedido (motivo registrado no contrato v3). <!-- VERIFY: limite de CPU por pedido do plano Workers usado em produção --> O plano de produção é **A CONFIRMAR** |
| PBKDF2 com mais de 100.000 iterações | Recusado pela plataforma acima do teto (comentário e teste em `password.test.ts`). Seria aceito localmente e quebraria em produção |
| PBKDF2 sem pepper | Com só 100.000 iterações, um vazamento do DO permitiria ataque de dicionário offline com custo baixo demais |
| Delegar autenticação (Cloudflare Access, OAuth) | Exigiria contas externas para os editores do cliente. Não foi o caminho escolhido (**A CONFIRMAR** se foi avaliado formalmente) |

## Consequências

**Provas em teste** (`api/test/worker/password.test.ts`):

- "hash: sal de 16 bytes por usuário, 32 bytes, 100000 iterações";
- "o pepper entra no cálculo: sem ele (ou com outro) a senha não confere";
- "pepper ausente ou curto: recusa (falha fechada)";
- "iterações: o código nunca passa de 100000; registro adulterado não derruba o login";
- "limite do runtime: 100000 funciona no workerd";
- `api/test/worker/api-auth.test.ts` › "sem PASSWORD_PEPPER o login falha fechado (500) sem vazar o motivo".

**Riscos e custos**

- **O teto de 100.000 não é testável localmente.** O teste "medição do workerd LOCAL: o teto de
  produção (100000) não está ativo aqui" afirma o contrário: que 100.001 *passa* no workerd local.
  Nenhum teste prova que 100.001 falha em produção. O valor está fixado por cautela.
  <!-- VERIFY: teto de iterações PBKDF2 do WebCrypto na plataforma Cloudflare Workers em produção -->
- ~~Rotacionar o pepper invalida todas as senhas~~: resolvido pelo [ADR 0007](0007-recuperacao-e-pepper-versionado.md).
  Com `PASSWORD_PEPPER_PREV` durante a rotação, cada usuário é re-hasheado no próximo login, sem zerar o
  DO. O procedimento está em [operacao.md](../operacao.md#rotacionar-o-pepper).
- Perder o pepper (sem guardar o valor) continua invalidando as senhas de quem estava nele. A saída é a
  recuperação de admin (`RECOVERY_SECRET`, ADR 0007) e, a partir dele, a redefinição dos demais.
