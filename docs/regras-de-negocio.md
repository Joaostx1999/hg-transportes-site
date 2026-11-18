<!-- generated-by: gsd-doc-writer -->
# Regras de negócio do painel

Cada regra traz onde ela está no código e o teste que a cobre. Os testes ficam em `api/test/` e são
citados como `arquivo › "nome do teste"`. Onde não há teste, a linha diz **sem teste**.

## Papéis

| # | Regra | Código | Teste |
| --- | --- | --- | --- |
| P1 | Há dois papéis: `admin` e `editor` (`CHECK (role IN ('admin','editor'))` no DO) | `validate.ts` (`ROLES`), `state.ts` | `api-users.test.ts` › "admin cria editor; validação com política de senha; duplicado 409; lista sem hash" |
| P2 | Os dois papéis podem: ver o conteúdo, publicar, ver o histórico, restaurar versões, trocar a própria senha, sair | `app.ts` (`auth: 'user'`) | `api-users.test.ts` › "editor: rotas de admin negadas (403); edita conteúdo e troca a própria senha"; `api-content.test.ts` › "publish e restore com sessão de editor: commit com o nome dele e auditoria" |
| P3 | Só admin pode: listar, criar e remover usuários, redefinir a senha de outro e ler a auditoria. Editor recebe `403 forbidden` | `app.ts` (`auth: 'admin'`) | `api-users.test.ts` › "editor: rotas de admin negadas (403)…" |
| P4 | Só admin vê `githubTokenExpiresAt` no `/me` | `app.ts` (`GET /me`) | `api-content.test.ts` › "/me para admin traz githubTokenExpiresAt (cabeçalho do GitHub); editor não vê" |
| P5 | O primeiro usuário é sempre admin e só pode ser criado por `/bootstrap`, com `BOOTSTRAP_SECRET` configurado (**mínimo de 32 caracteres**, senão a rota falha fechada com `403` e log `config_missing`) e o DO vazio | `app.ts` (`POST /bootstrap`, `SECRET_MIN_LENGTH`), `state.ts` (`createUser(…, true)`) | `api-users.test.ts` › "S8: BOOTSTRAP_SECRET com menos de 32 caracteres: 403 mesmo com o segredo certo", "sem BOOTSTRAP_SECRET: sempre 403", "segredo errado 403 (conta no limite); certo cria admin; depois sempre 403"; `state.test.ts` › "bootstrap atômico: dois pedidos simultâneos com o DO vazio criam um admin só" |
| P6 | Ninguém pode remover a si mesmo | `state.ts` (`deleteUser` → `'self'`) | `api-users.test.ts` › "não remove a si mesmo nem o último admin; remover derruba as sessões do removido" |
| P7 | O **último admin** não pode ser removido, nem com remoções simultâneas | `state.ts` (`deleteUser`, contagem em `transactionSync`) | `api-users.test.ts` › "último admin é protegido mesmo com dois admins removendo um ao outro ao mesmo tempo" |
| P8 | Remover um usuário derruba as sessões dele | `state.ts` (`deleteUser`) | idem P6 |
| P9 | Não existe rota para mudar o papel de um usuário existente. Para isso, remova e crie de novo | `app.ts` (nenhuma rota) | **sem teste** (ausência de rota) |
| P10 | Criar usuário, remover usuário e redefinir a senha de outro exigem a **senha atual do admin** (`currentPassword`). Errar conta no mesmo limite do login (5 por usuário+rede, 20 por rede) e fica na auditoria (`reauth_fail`) | `app.ts` (`reauth`) | `api-users.test.ts` › "/users/create sem a senha atual do admin, ou com ela errada: 422 em currentPassword; nada muda" (e o mesmo para `/users/delete` e `/users/password`), "5 senhas atuais erradas bloqueiam (429) as três rotas, mesmo com a certa depois"; E2E cenário 10 |
| P11 | `/users/password` não serve para a própria senha: `400` mandando usar "Minha senha" (`/password`, que pede a senha atual) | `app.ts` (`POST /users/password`) | `api-users.test.ts` › "/users/password no próprio usuário: 400 mandando usar /password (Minha senha)" |
| P12 | **Recuperação de admin** (ninguém consegue entrar): `POST /recover` só existe com `RECOVERY_SECRET` (>= 32 caracteres) definido, compara em tempo constante, tem limite de 5 tentativas por rede em 15 min, é auditada e cada valor do secret vale **uma vez**. Só redefine a senha de um admin existente, derruba todas as sessões dele e **zera os limites de tentativa dele** (usuário+rede e contador global; os limites só de rede e os de outros usuários ficam) | `app.ts` (`POST /recover`), `state.ts` (`claimOnce`) | `recover.test.ts` › "recuperação zera os limites de tentativa do admin (rede e global), e não os de outro usuário", "sem o secret definido, ou com menos de 32 caracteres: 403 sempre", "segredo certo redefine a senha do admin, derruba as sessões e audita…", "uso único: o mesmo secret não funciona de novo (gere outro)", "só admin existente; política de senha; Origin estranha recusada", "força bruta: 5 segredos errados por IP bloqueiam (429), mesmo com o certo" |

## Usuário e senha

| # | Regra | Código | Teste |
| --- | --- | --- | --- |
| U1 | Nome de usuário: 3 a 32 caracteres `[a-z0-9._-]`, após trim e conversão para minúsculas | `validate.ts` (`USERNAME_RE`, `normUsername`) | `validate.test.ts` › "usuário" |
| U2 | Senha: 10 a 200 caracteres | `validate.ts` (`PASSWORD_MIN`, `PASSWORD_MAX`) | `validate.test.ts` › "senha: tamanho, caracteres distintos, nome de usuário, lista de comuns" |
| U3 | Senha com pelo menos 3 caracteres diferentes | `passwordPolicy` | idem U2 |
| U4 | A senha não pode conter o nome de usuário (sem diferenciar maiúsculas) | `passwordPolicy` | idem U2 |
| U5 | A senha não pode estar na lista embutida de senhas comuns: as **10 mil** senhas vazadas mais comuns (lista "passwords" do zxcvbn, MIT, gerada em `src/senhas-comuns.ts` por `scripts/gerar-senhas-comuns.mjs`, sem rede) mais as óbvias da HG (`hgtransportes2026`, `cegonha123` etc.). A comparação ignora maiúsculas e tudo que não é letra ou número (`P@ss-Word!` = `password`) | `validate.ts` (`COMMON_PASSWORDS`, `squash`) | `validate.test.ts` › "lista com 10 mil senhas normalizadas (sem rede); as óbvias da HG continuam", "recusa senhas da lista mesmo com maiúsculas, espaços e pontuação; aceita senha forte"; `scripts.test.ts` › "normaliza, tira repetidas e curtas, respeita --top; o arquivo versionado tem 10 mil" |
| U6 | Na troca da própria senha, a nova precisa ser diferente da atual, e a atual precisa estar certa | `app.ts` (`POST /password`) | `api-users.test.ts` › "atual errada: 422 e conta no limite; nova fraca ou igual: 422" |
| U7 | Trocar a própria senha derruba as **outras** sessões. A atual continua, e a senha velha deixa de entrar | `state.ts` (`setPassword` com `keepTokenHash`) | `api-users.test.ts` › "troca certa invalida as OUTRAS sessões; a atual continua; senha velha não entra mais" |
| U8 | Admin redefinindo a senha de outro derruba **todas** as sessões do alvo | `app.ts` (`POST /users/password`) | `api-users.test.ts` › "admin redefine a senha de outro: todas as sessões dele caem" |
| U9 | O script `criar-usuario.mjs` aplica a mesma política antes de chamar o `/bootstrap` (importa `src/validate.ts`) | `api/scripts/criar-usuario.mjs` | **sem teste** dedicado ao script |
| U10 | Hash: HMAC-SHA256 com pepper, seguido de PBKDF2-SHA256 com 100.000 iterações, sal de 16 bytes e 32 bytes de saída | `password.ts` | `password.test.ts` (veja o [ADR 0003](adr/0003-pbkdf2-com-pepper.md)) |
| U11 | Cada usuário guarda a **versão do pepper** (`pepper_id`) do seu hash. Durante uma rotação (`PASSWORD_PEPPER_PREV` + `PASSWORD_PEPPER_PREV_ID`), quem ainda está no pepper anterior entra normalmente e o hash é refeito com o atual, sem derrubar sessões (`password_rehash` na auditoria). Linha antiga sem `pepper_id` vale como pepper atual. Quem estiver num pepper que não é nem o atual nem o anterior não entra | `app.ts` (`checkPassword`), `state.ts` (`rehash`, migração v2) | `recover.test.ts` › "rotação: pepper novo + PREV; login com o antigo funciona e re-hasheia com o novo; depois tira o PREV", "usuário ainda no pepper antigo sem PREV configurado: não entra (precisa de redefinição)", "linha antiga sem pepper_id (antes da migração) entra com o pepper atual e ganha o id", "troca de senha e /users/password gravam o pepper atual" ([ADR 0007](adr/0007-recuperacao-e-pepper-versionado.md)) |

## Login e limite de tentativas

| # | Regra | Código | Teste |
| --- | --- | --- | --- |
| L1 | Usuário inexistente e senha errada dão a mesma resposta (`401`, "Usuário ou senha incorretos.") e levam tempo semelhante (PBKDF2 contra registro `DUMMY`) | `app.ts`, `password.ts` | `api-auth.test.ts` › "senha errada e usuário inexistente: mesma resposta genérica" |
| L2 | **5 falhas por usuário+IP** em 15 min bloqueiam aquele par por 15 min, mesmo com a senha certa. Outros IPs não são afetados | `state.ts` (`RATE.userMax = 5`, `windowMs`, `blockMs`) | `api-auth.test.ts` › "5 falhas por usuário+IP bloqueiam (mesmo com a senha certa), só aquele IP, por 15 min" |
| L3 | **20 falhas por IP** (com usuários variados) em 15 min bloqueiam o IP inteiro por 15 min | `RATE.ipMax = 20` | `api-auth.test.ts` › "20 falhas por IP (usuários variados) bloqueiam o IP inteiro" |
| L4 | Um acerto zera a contagem do usuário e devolve a reserva do IP | `state.ts` (`rateFinish`) | `api-auth.test.ts` › "login certo zera a contagem do usuário (4 erros + acerto + 4 erros não bloqueia)" |
| L5 | A tentativa é reservada **antes** de verificar a senha. N pedidos simultâneos não passam de `max` verificações | `state.ts` (`rateAcquire`) | `api-auth.test.ts` › "atômico: 12 tentativas simultâneas erradas fazem no máximo 5 verificações; o resto é 429"; `state.test.ts` › "rate limit: reserva antes de verificar, janela de 15 min, bloqueio de 15 min" |
| L6 | Falhas espalhadas além da janela de 15 min não acumulam | `rateAcquire` (`fresh`) | `state.test.ts` › "falhas espalhadas além da janela não acumulam" |
| L7 | `/password` usa as **mesmas** chaves do login: errar a senha atual conta no limite de login | `app.ts` (`rateRules('login', …)`) | `api-users.test.ts` › "5 erros de senha atual bloqueiam com 429 (mesmo com a senha certa)" |
| L8 | `/bootstrap` tem limite próprio: 20 falhas por IP | `app.ts` (`rateRules('boot', …)`) | `api-users.test.ts` › "força bruta no segredo: 20 erros por IP bloqueiam" |
| L9 | `429` traz `Retry-After` em segundos (mínimo 1) | `app.ts` (`rateLimited`) | `api-auth.test.ts` › "5 falhas por usuário+IP bloqueiam…" (`Retry-After` > 0); `state.test.ts` › "rate limit: reserva antes de verificar…" (valor de `retryAfter`) |
| L10 | O IP vem de `CF-Connecting-IP`. Na ausência do cabeçalho (dev), vale `127.0.0.1`. Na chave do limite, **IPv6 vira o prefixo /64** (qualquer grafia do mesmo endereço dá a mesma chave) e IPv4 mapeado (`::ffff:a.b.c.d`) vira o IPv4. A auditoria guarda o IP completo | `app.ts` (`ipKey`, `rateRules`) | `api-auth.test.ts` › "ipKey: IPv6 vira o prefixo /64 (qualquer grafia); IPv4 e IPv4 mapeado ficam como IPv4", "trocar de endereço dentro do mesmo /64 não zera o limite por usuário+IP" |
| L11 | **Turnstile opcional**: só é exigido se o secret `TURNSTILE_SECRET` existir. A validação usa `siteverify` com `remoteip` | `app.ts`, `turnstile.ts` | `api-auth.test.ts` › "sem TURNSTILE_SECRET o login funciona sem token", "com TURNSTILE_SECRET: exige token, valida no siteverify com remoteip, recusa inválido" |
| L12 | Não há rate limit em `/publish` e `/restore`. Essas rotas exigem sessão válida. As rotas de admin que mexem em usuários passam pelo limite do login (P10) | `app.ts` | **sem teste** da ausência |
| L13 | **Contador global por usuário** (todas as redes): passou de 50 tentativas em 1 h, cada nova tentativa espera 1 s, 2 s, 4 s… (teto de 30 s) desde a anterior. A conta **não trava**: esperando, a senha certa entra. Login certo não conta. Com Turnstile ligado e verificado no pedido, a espera é dispensada. **Recusa do atraso não é de graça:** conta como falha no limite da rede (20/15 min), então uma rede que insiste fica bloqueada; a chave usuário+rede é devolvida (o dono que insiste não se tranca). A recusa **não** regrava o instante da última tentativa: o atraso não se estende. **Limite garantido ao dono:** a senha certa entra assim que acaba o atraso contado da última tentativa *admitida* (no máximo 30 s), por mais recusas que haja no meio. Um atacante com N redes consegue no máximo 5N tentativas admitidas por 15 min (cada uma ocupando até 30 s), ou seja, segurar o login por até ~2,5N min a cada 15 min se cronometrar perfeitamente; com Turnstile não há atraso | `state.ts` (`SLOW`, `slowAcquire`, `slowSuccess`), `app.ts` (`login_slowed`) | `api-auth.test.ts` › "50 falhas/h de IPs diferentes: a partir daí atraso progressivo, sem travar a conta", "DoS: redes insistindo no atraso gastam o próprio limite e não empurram o atraso; o dono entra em até SLOW.maxDelayMs", "com Turnstile ligado, o token verificado dispensa o atraso progressivo" |

## Sessão

| # | Regra | Código | Teste |
| --- | --- | --- | --- |
| S1 | Token opaco de 256 bits (43 caracteres base64url), devolvido só no login. O DO guarda só o SHA-256 | `app.ts`, `state.ts` | `api-auth.test.ts` › "login ok devolve token de 256 bits…", "o DO guarda só o hash do token" |
| S2 | **Expiração por inatividade**: 1 h sem uso (`SESSION_IDLE_SECONDS = 3600`). O uso renova, mas o `last_seen` só é regravado de minuto em minuto (`SESSION_TOUCH_MS`): `GET` repetido não escreve no DO a cada pedido, e a sessão pode vencer até 60 s antes da hora exata | `state.ts` (`touchSession`) | `api-auth.test.ts` › "sessão expira por inatividade (1 h) e é renovada pelo uso"; `state.test.ts` › "touchSession: inatividade e tempo absoluto; renova last_seen", "C7: touchSession só regrava last_seen depois de SESSION_TOUCH_MS (60 s)" |
| S3 | **Expiração absoluta**: 12 h após o login (`SESSION_MAX_SECONDS = 43200`), mesmo com uso contínuo | `touchSession` | `api-auth.test.ts` › "sessão expira por tempo absoluto (12 h) mesmo com uso contínuo" |
| S4 | Login com um token antigo no `Authorization` revoga o antigo | `state.ts` (`createSession`, `revokeTokenHash`) | `api-auth.test.ts` › "rotação: login com o token antigo no Authorization invalida o antigo" |
| S5 | `/logout` apaga a sessão no servidor | `state.ts` (`deleteSession`) | `api-auth.test.ts` › "login ok devolve token…; /me; /logout apaga no servidor" |
| S6 | Token malformado dá `unauthenticated`. Token bem formado e desconhecido ou vencido dá `session_expired` | `app.ts` | `api-auth.test.ts` › "token malformado: unauthenticated; token bem formado desconhecido: session_expired" |
| S7 | Um usuário pode ter várias sessões simultâneas (não há limite) | `state.ts` | **sem teste** dedicado |
| S8 | Sessões vencidas são apagadas de forma oportunista (no máximo 1 vez por minuto) | `state.ts` (`cleanup`) | `state.test.ts` › "limpeza: sessão vencida e auditoria com mais de 365 dias são apagadas na operação seguinte" |
| S9 | Metadados do DO (validade do token do GitHub) só são gravados quando o valor muda | `state.ts` (`setMeta`) | `state.test.ts` › "C7: setMeta só grava quando o valor muda (o DO não escreve a cada GET)" |

## Validação de campos

O servidor é a autoridade. Os limites por tipo (`TYPE_MAX` em `validate.ts`) podem ser **apertados**
pelo `max` do `cms/schema.json`, nunca afrouxados.

| # | Regra | Teste |
| --- | --- | --- |
| V1 | Nenhum campo pode ficar vazio | `validate.test.ts` › "vazio é proibido em todos os tipos" |
| V2 | Sem caracteres de controle. Quebra de linha (`\n`) só é aceita em `address`, e CRLF/CR são normalizados para LF | `validate.test.ts` › "text e meta: limite e caracteres de controle; quebra de linha só em address", "address aceita \n (CRLF normalizado), máximo 300" |
| V3 | Limites: `text` 600, `meta` 300, `address` 300, `number` 9, `phone` 30, `whatsapp` 30, `email` 120, `link` 300, `image` 200 | idem V2; `validate.test.ts` › "limite do esquema aperta o do tipo"; `api-content.test.ts` › "limite apertado no esquema do HEAD vale na validação" |
| V4 | `number`: só dígitos (`^\d{1,9}$`). Com `data-sep`, é exibido com separador de milhar pt-BR | `validate.test.ts` › "number, phone, whatsapp, email, link, image"; `html-editor.test.ts` › "number: data-count e texto; data-sep usa separador pt-BR" |
| V5 | `phone`: 10 a 13 dígitos. O `href` vira `tel:+55…` (prefixa 55 quando há 10 ou 11 dígitos) | idem V4; `html-editor.test.ts` › "phone: texto e href tel: derivado; os outros telefones intactos" |
| V6 | **WhatsApp**: depois de normalizar (10 ou 11 dígitos ganham o prefixo `55`), precisa casar com `^55\d{10,11}$`. O atributo `content` recebe o número normalizado, e o `phone=` de todos os links `data-cms-href` é reescrito, preservando o `&text=…`. Na leitura, o valor aparece como `(51) 99377-5912` | `validate.test.ts` (idem V4); `html-editor.test.ts` › "whatsapp: content normalizado e phone= dos dois links, preservando &text" |
| V7 | `email`: formato simples, sem espaço, `<`, `>` ou `"`. O link vira `mailto:` | `validate.test.ts` (idem V4); `html-editor.test.ts` › "email, link e image: só o trecho certo muda" |
| V8 | `link`: só `https://`, sem espaço, `"`, `<` ou `>` (recusa `http:` e `javascript:`) | `validate.test.ts` (idem V4) |
| V9 | `address`: as linhas viram `<br>`, e o link derivado aponta para o Google Maps | `html-editor.test.ts` › "address: linhas viram <br>, link do mapa derivado, outros endereços intactos" |
| V10 | `image`: o valor tem que casar com `^assets/fotos/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$`. O cliente não manda caminho: o servidor gera `assets/fotos/cms-<16 hex>.<ext>` | `validate.test.ts` (idem V4); `api-content.test.ts` › "fotos vão no MESMO commit do index.html; o servidor gera o caminho" |
| V11 | Texto é sempre escapado (`<script>` e aspas viram texto), e `$&`/`$1` não viram padrão de substituição | `html-editor.test.ts` › "escape: <script> e aspas viram texto…", "$ é texto: $&, $1, $\` e $' não viram padrão de substituição" |
| V12 | Chave desconhecida, campo `image` em `changes` ou chave de `images` que não é `image`: `422` sem escrever nada | `api-content.test.ts` › "valores inválidos, chave desconhecida e foto em changes: 422 com fields; nada é escrito" |
| V13 | Valor igual ao atual (na forma canônica do tipo) não é reaplicado. Se nada mudou, `400 "Nenhuma alteração."` | `api-content.test.ts` › "campo com valor igual ao atual não é reaplicado; nada mudou de fato: 400" |
| V14 | No máximo **200 alterações** por publicação | `api-content.test.ts` › "limite de MAX_CHANGES (200) campos por pedido: 200 passa do limite, 201 é recusado antes do GitHub" |
| V15 | O painel usa **a mesma regra** do servidor para decidir se um campo mudou (forma canônica: espaço repetido num texto não é alteração) e para validar; o limite de cada campo vem do `/content` (esquema do commit), não de números repetidos no front | `admin/rules.js`, `GET /content` (`fields`) | `regras-painel.test.ts` › "mesma normalização, forma canônica e validade em 8 mil valores (8 tipos)", "o caso da revisão: espaço duplo num texto não é mudança nos dois lados"; `api-content.test.ts` › "C6: devolve as regras por campo do esquema do MESMO commit (tipo e limite) para o painel"; E2E cenário 9 |
| V16 | O fechamento `</tag>` é procurado no texto original, sem `toLowerCase()` (que muda o tamanho de letras como `İ`). Texto com `İ`, `ß`, `ﬁ` etc. publica sem corromper o HTML | `html-editor.ts` (`indexOfCloseTag`), `schema.ts` | `api-content.test.ts` › '"İstanbul" num texto publica certo e o HTML continua batendo com o esquema'; `properties.test.ts` (alfabeto com `İ`, `ı`, `ß`, `ẞ`, `ﬁ`, `ŉ`, `Σ`, `K`, `Å`) |
| V17 | Se a verificação final do resultado falhar (não deveria acontecer), a resposta é **`422 integrity`** com o campo em `fields`, e nada é publicado. Não é mais um `500` genérico. São duas barreiras: o resultado inteiro tem que passar no esquema (ex.: marcador duplicado) e cada campo tem que ter o valor pedido | `publish.ts` (`IntegrityError`), `app.ts` (`toHttpError`) | `api-content.test.ts` › "editor que mantém os valores mas quebra a estrutura (marcador duplicado): 422 integrity, sem commit, log" e 'verificação de integridade forçada a falhar: erro claro 422 "integrity" com o campo, sem commit' |

## Fotos

| # | Regra | Teste |
| --- | --- | --- |
| F1 | Tipos aceitos: JPEG, PNG e WebP | `validate.test.ts` › "bytes mágicos, tipo declarado, base64 estrito e tamanho" |
| F2 | Os bytes mágicos precisam bater com o `type` declarado (`FF D8 FF`; `89 50 4E 47 0D 0A 1A 0A`; `RIFF….WEBP`) | idem F1; `api-content.test.ts` › "fotos inválidas: bytes mágicos falsos, tipo divergente, grande demais (413), tipo não aceito" |
| F3 | Até **3 MiB** por foto decodificada (`MAX_UPLOAD_BYTES = 3145728`). O tamanho é checado antes de decodificar o base64 | idem F2 |
| F4 | Até **6 fotos** por publicação (`MAX_IMAGES`) | `api-content.test.ts` › "pedido malformado: base ausente/errada, nada para mudar, foto demais" |
| F5 | O corpo inteiro do `/publish` vai até **12 MB**. Acima disso, `413` antes de qualquer chamada ao GitHub | `api-content.test.ts` › "corpo acima de 12 MB: 413 antes de qualquer chamada ao GitHub" |
| F6 | Base64 estrito (sem espaços e com padding correto). O prefixo `data:<type>;base64,` é aceito | `validate.test.ts` (idem F1) |
| F7 | O painel redimensiona (largura máxima `maxImageWidth: 2000` em `admin/config.js`) e re-encoda via `canvas` antes de enviar. O servidor **não re-encoda**, mas **limpa** toda foto (vinda do painel ou da API): JPEG perde os APPn que não são JFIF/ICC/Adobe (EXIF/GPS, XMP, IPTC) e os comentários; PNG perde `tEXt`/`zTXt`/`iTXt`/`eXIf`/`tIME` e chunks desconhecidos; WebP perde `EXIF`/`XMP ` (e as flags no `VP8X`). Bytes depois do fim da imagem (EOI, IEND, tamanho do RIFF) são cortados. Estrutura quebrada: `422` | `image.test.ts` (todos os testes); E2E cenário 4 (PNG do navegador passa e aparece no site) |
| F8 | As fotos entram no **mesmo commit** do `index.html` | `api-content.test.ts` › "fotos vão no MESMO commit do index.html…"; `github-mock.test.ts` › "publish com foto: UM commit com a foto e o index.html…" |

## Publicação, conflito e restauração

| # | Regra | Teste |
| --- | --- | --- |
| C1 | Cada publicação gera **um commit**, com autor e committer `<usuário> (painel)` e a mensagem `Painel: <usuário> alterou N campo(s)` | `api-content.test.ts` › "muda só o trecho marcado; autor, committer e mensagem do painel; um único commit" |
| C2 | `base` é o commit lido no `/content`. Se for antiga e outra pessoa mexeu em **outros** campos, o servidor faz rebase e preserva as duas alterações | `api-content.test.ts` › "base diferente do HEAD, campos diferentes: rebase sobre o HEAD (mantém a mudança do outro)" |
| C3 | **Conflito por campo**: se outra pessoa mudou um dos **mesmos** campos, `409 conflict` com `fields[chave]` e nada é escrito. Vale também para foto | `api-content.test.ts` › "outra pessoa mudou o MESMO campo…", "foto: conflito também vale para campo image" |
| C4 | `base` inexistente no repositório: `409` | `api-content.test.ts` › "base que não existe: 409" |
| C5 | Se o branch andar entre a leitura e o `PATCH`, o servidor refaz a partir do HEAD novo, em até 3 tentativas no total. Depois disso, `409` | `api-content.test.ts` › "corrida entre a leitura e o PATCH…", "corrida mexendo no MESMO campo durante o PATCH…", "branch andando sem parar: desiste depois de 3 tentativas com 409" |
| C6 | O HTML do HEAD tem que conferir com o `cms/schema.json` do **mesmo** commit, senão `409 schema_mismatch` e o painel bloqueia a edição | `api-content.test.ts` › "HEAD com marcador faltando…", "marcador duplicado e tipo diferente no HEAD…", "o esquema lido é o do MESMO commit…" |
| C7 | Restaurar exige `base` = HEAD atual (sem rebase), gera um commit novo com o `index.html` da versão e exige que essa versão passe no esquema **atual** | `api-content.test.ts` › "restore: mesmo pipeline (um commit, base = HEAD, esquema validado)", "restore de versão que não passa no esquema atual: 409 schema_mismatch" |
| C8 | Restaurar a versão que já é a atual: `400`. Versão inexistente: `404`. `base` velha: `409`. **Só é versão o commit do histórico do branch que tocou o `index.html`** (as 100 mais novas): commit de outro ref (ex.: `refs/pull/N/head` de PR não mesclado) ou que não tocou o `index.html` dá `404` | `api-content.test.ts` › "restore: mesmo pipeline…", "S1: restore só aceita commit do histórico do branch que tocou o index.html; fora: 404"; `github-mock.test.ts` › "S1: restore de commit fora do branch (refs/pull/N/head) é 404 também no mock git real"; E2E cenário 7 |
| C9 | O restore volta **só o `index.html`**. Fotos enviadas depois continuam no repositório | `api-content.test.ts` › "restore: mesmo pipeline…" (confere `changedFiles()` = `['index.html']`). A permanência de fotos órfãs não tem teste específico |
| C10 | O histórico mostra até 30 commits que tocaram o `index.html` | `api-content.test.ts` › "histórico lista commits do index.html com data, autor e mensagem" |
| C11 | O painel manda em `expected` o valor publicado que mostrava para cada campo enviado. Se o HEAD tiver outro valor (forma canônica), `409 conflict` naquele campo, **mesmo com `base` = HEAD**. Protege contra painel com base nova e campo velho | `publish.ts` (passo 2) | `api-content.test.ts` › "B4: base já avançada pelo rebase, mas o valor que o painel viu está velho: 409 no campo", "expected compara na forma canônica do tipo e vale para foto; formato inválido é 400"; E2E cenário 8 (B4) |
| C12 | Publicação com rebase responde `rebased: true` e `othersChanged` (campos que outra pessoa mudou entre a base e o HEAD). O painel recarrega o conteúdo novo, mostra o aviso e marca esses campos | `publish.ts`, `app.ts`, `admin/admin.js` | `api-content.test.ts` › "rebase: a resposta diz rebased e quais campos outra pessoa mudou entre a base e o HEAD"; E2E cenário 8 (B1 a B3) |
| C13 | Campo cujo **tipo** mudou no HEAD (ex.: `phone` → `text` com o mesmo texto) também é conflito: a edição foi pensada para o tipo antigo | `publish.ts` (`b.type === h.type`) | `api-content.test.ts` › "outra pessoa trocou o tipo do campo (phone -> text) sem mudar o valor: 409 no campo" |

## Rascunho e prévia no painel

| # | Regra | Teste |
| --- | --- | --- |
| D1 | O rascunho fica em `localStorage` numa chave **por usuário** (`hg-cms-draft:<usuário>`) com `{user, base, values, originals}`. O formato antigo sem dono (`hg-cms-draft`) é apagado ao abrir | E2E cenário 11 |
| D2 | **Sair** (botão) descarta o rascunho e as fotos escolhidas, depois de confirmar quando há algo pendente. **Sessão vencida** guarda o rascunho para a mesma pessoa | E2E cenários 11 e 12 |
| D3 | Rascunho de um usuário nunca aparece para outro no mesmo navegador | E2E cenário 11 (a) e (b) |
| D4 | Ao repor o rascunho, se o site mudou aquele campo desde que a pessoa editou, o campo fica **em conflito visível** (mostra o que foi publicado), publicar fica bloqueado e ela escolhe "Manter o meu" ou "Usar o publicado". Nada é aplicado em silêncio | E2E cenários 6, 8 (B4) e 11 (b) |
| D5 | A prévia é um iframe `sandbox="allow-same-origin"` sem `allow-scripts`: o JS do site não roda dentro do painel; prévia ao vivo, clique-para-campo, Celular/Computador e foto continuam funcionando | E2E cenário 3 (atributo, html sem `.js`, blocos `.rv` visíveis), 4, 13 |

## Auditoria

| # | Regra | Teste |
| --- | --- | --- |
| A1 | Ações registradas: `login_ok`, `login_fail`, `login_blocked`, `login_slowed`, `logout`, `publish`, `restore`, `user_create`, `user_delete`, `password_change`, `password_fail`, `password_reset`, `password_rehash`, `reauth_fail`, `bootstrap_fail`, `recover_ok`, `recover_fail`, `recover_reused` | `api-users.test.ts` › "ações registradas, mais recente primeiro, paginação por before/limit"; as novas nos testes de P10, P12, U11 e L13 |
| A2 | `publish` guarda `{commit, base, rebased, attempts, changes:[{key, old, new}]}`, com valores truncados em 300 caracteres, sem token | `api-content.test.ts` › "publish e restore entram na auditoria com valor antigo/novo, sem token" |
| A3 | Login com usuário malformado **não** registra o texto digitado (pode ser uma senha colada no campo errado): só `detail = {invalid_username: true}` | `api-auth.test.ts` › "não grava o texto digitado, só invalid_username: true" |
| A4 | Retenção: 365 dias | `state.test.ts` › "limpeza: … auditoria com mais de 365 dias são apagadas…" |

## Token do GitHub

| # | Regra | Teste |
| --- | --- | --- |
| G1 | O Worker lê `github-authentication-token-expiration` de qualquer resposta do GitHub, guarda em `meta` e expõe no `/me` (só para admin) | `api-content.test.ts` › "/me para admin traz githubTokenExpiresAt…" |
| G2 | O painel mostra aviso ao admin quando faltam **menos de 30 dias** | `admin/admin.js` (`30 * DAY`): **sem teste automatizado no repositório** |
| G3 | GitHub fora do ar ou credencial recusada: `502 upstream` genérico, sem vazar o token. `401`/`403` do GitHub viram log `level: error` | `api-content.test.ts` › "GitHub fora do ar ou 500…", "o token vai como Bearer só para o GitHub…" |
| G4 | O token só sai para `https://api.github.com`. `GITHUB_API_BASE` diferente só vale para `http(s)://127.0.0.1` ou `localhost` **e** com `DEV_ALLOW_LOCAL_GITHUB=1` (o mock do dev). Qualquer outro valor: `500 server` sem chamar ninguém e log `config_missing` | `env.ts` (`githubApiBase`), `app.ts` | `api-auth.test.ts` › "GITHUB_API_BASE só aceita o GitHub de verdade (S9)" (7 valores recusados e os 2 aceitos) |
