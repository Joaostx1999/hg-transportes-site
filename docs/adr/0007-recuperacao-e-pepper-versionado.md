# ADR 0007: pepper com versão por usuário e recuperação de admin por segredo efêmero

- **Status:** aceita (complementa o [ADR 0003](0003-pbkdf2-com-pepper.md), que tinha um pepper único)
- **Componentes:** `api/src/app.ts` (`checkPassword`, `POST /recover`), `api/src/state.ts` (migração v2,
  `rehash`, `claimOnce`), `api/src/env.ts` (`PASSWORD_PEPPER_ID`, `PASSWORD_PEPPER_PREV_ID`)

## Contexto

O ADR 0003 deixou duas consequências que a revisão de segurança (R10) apontou:

1. **Trocar o pepper invalidava todas as senhas** ao mesmo tempo, inclusive as dos admins. A única saída
   documentada era zerar o Durable Object (usuários, sessões e auditoria).
2. **Não havia recuperação** quando nenhum admin consegue entrar: o `/bootstrap` só funciona com o DO
   vazio e não existe rota sem sessão para redefinir senha.

## Decisão

**Pepper versionado.** Cada usuário guarda `pepper_id` (coluna nova, migração v2 do DO). O Worker conhece
o pepper atual (`PASSWORD_PEPPER`, versão `PASSWORD_PEPPER_ID`, padrão 1) e, só durante uma rotação, o
anterior (`PASSWORD_PEPPER_PREV`, versão `PASSWORD_PEPPER_PREV_ID`). No login, a senha é conferida com o
pepper da versão gravada no usuário; deu certo com um pepper que não é o atual, o hash é refeito com o
atual na hora (re-hash transparente, sem derrubar sessões, auditado como `password_rehash`). Toda senha
nova (troca, redefinição, criação, recuperação) já sai com o pepper atual. Linha antiga sem `pepper_id`
vale como pepper atual (e, se houver, tenta o anterior). `GET /users` mostra `pepper_current` para saber
quem ainda não entrou desde a rotação.

**Recuperação por segredo efêmero.** `POST /recover {secret, username, password}` redefine a senha de um
**admin existente** quando o secret `RECOVERY_SECRET` está definido. Regras: secret com 32 caracteres ou
mais (senão a rota falha fechada); comparação em tempo constante (SHA-256 dos dois lados); limite de 5
tentativas por rede (IPv6 por /64) em 15 min; auditoria (`recover_ok`, `recover_fail`, `recover_reused`)
e log `recovery_used`; **uso único por valor** (o hash do secret usado fica em `meta`, gravado com
`INSERT … ON CONFLICT DO NOTHING`, então nem dois pedidos simultâneos usam o mesmo valor). Derruba todas
as sessões do admin. O secret deve ser apagado depois do uso.

## Alternativas consideradas

| Alternativa | Por que não |
| --- | --- |
| Pepper derivado com id = hash do próprio pepper | Grava no DO um valor calculado a partir do segredo; com pepper fraco vira oráculo offline. Id numérico explícito não revela nada |
| Recuperação por e-mail | Não há envio de e-mail no projeto nem conta de e-mail definida para os admins |
| Reaproveitar o `/bootstrap` (liberar com usuários existentes) | Mistura criação inicial com recuperação; um `BOOTSTRAP_SECRET` esquecido configurado viraria porta de entrada permanente |
| Recuperação sem uso único | Um secret esquecido no Worker continuaria valendo; o uso único limita a janela ao primeiro uso |

## Consequências

**Provas em teste** (`api/test/worker/recover.test.ts`): rotação com PREV e re-hash; usuário no pepper
antigo sem PREV não entra; linha sem `pepper_id`; troca e redefinição gravam o pepper atual; recuperação
sem secret, com secret curto, errado, certo, reusado, para não-admin, com senha fraca, com Origin
estranha e por força bruta. Mutações de controle (desligar re-hash, ignorar o PREV, tirar o uso único,
comparar sem tempo constante) derrubam esses testes.

**Riscos e custos**

- Enquanto `RECOVERY_SECRET` estiver definido, quem o tiver redefine a senha de qualquer admin. Por isso
  ele é efêmero: definir, usar uma vez, apagar ([operacao.md](../operacao.md#recuperar-o-acesso-de-admin)).
- Durante a rotação, quem tiver o pepper antigo ainda consegue testar senhas de quem não entrou. A janela
  termina quando o `PASSWORD_PEPPER_PREV` é apagado; quem não entrou até lá precisa de redefinição.
- O re-hash custa um PBKDF2 a mais no primeiro login depois da rotação.
