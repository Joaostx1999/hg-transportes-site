/* Roteador do painel: CORS, autenticação, limites de corpo, logs e rotas.
 * handle(request, env, deps) recebe fetch/relógio/log injetáveis (testes); o estado forte fica no DO CmsState.
 * O módulo de entrada do Worker é src/index.ts (só pode exportar handlers e classes). */
import {
  RATE,
  type CmsState,
  type NewHash,
  type RateRule,
  type SessionUser,
  type UserRecord,
} from './state.ts';
import { githubApiBase, readConfig, type Config, type Env } from './env.ts';
import { errorBody, HttpError, MSG, readJson, respond, str, type FieldErrors } from './http.ts';
import { logLine, type LogEntry, type Logger } from './log.ts';
import { hashPassword, PEPPER_MIN_LENGTH, PepperError, verifyPassword } from './password.ts';
import { createGitHub, GitHubError, type FetchLike, type GitApi } from './github.ts';
import {
  IntegrityError,
  loadContent,
  parsePublishRequest,
  publish,
  restore,
  type PublishContext,
} from './publish.ts';
import { verifyTurnstile } from './turnstile.ts';
import { b64url, randomBytes, sha256, sha256Hex, timingSafeEqual } from './util.ts';
import {
  isRole,
  MSG_USERNAME,
  normUsername,
  PASSWORD_MAX,
  passwordPolicy,
  validUsername,
  type Role,
} from './validate.ts';

export const VERSION = '3.0.0';
export const LIMITS = { login: 4 * 1024, json: 64 * 1024, publish: 12 * 1024 * 1024 } as const;
const TOKEN_RE = /^Bearer ([A-Za-z0-9_-]{43})$/;
const GITHUB_EXP_KEY = 'github_token_expires_at';
const GITHUB_CHECKED_KEY = 'github_token_checked_at';
const GITHUB_RECHECK_MS = 6 * 3600 * 1000;
/** BOOTSTRAP_SECRET e RECOVERY_SECRET: abaixo disso a rota falha fechada (S8, R10). */
export const SECRET_MIN_LENGTH = 32;
/** tentativas de segredo de recuperação por rede em 15 min */
const RECOVER_IP_MAX = 5;

export interface Deps {
  fetch: FetchLike;
  now: () => number;
  log: Logger;
}

type Stub = DurableObjectStub<CmsState>;

interface Ctx {
  request: Request;
  url: URL;
  env: Env;
  cfg: Config;
  deps: Deps;
  ip: string;
  state: Stub;
  body: Record<string, unknown>;
  user: SessionUser | null;
  tokenHash: string | null;
  tokenExpiration: string | null;
  git: () => GitApi;
}

interface Route {
  auth: 'none' | 'user' | 'admin';
  limit: number;
  /** aceita pedido sem cabeçalho Origin (não vem de navegador): /health e /bootstrap */
  noOrigin?: true;
  run: (c: Ctx) => Promise<Record<string, unknown>>;
}

const ok = (data: Record<string, unknown> = {}): Record<string, unknown> => ({ ok: true, ...data });

function stateOf(env: Env): Stub {
  return env.CMS_STATE.get(env.CMS_STATE.idFromName('global'));
}

function needUser(c: Ctx): SessionUser {
  if (!c.user) throw new HttpError('unauthenticated', 'Entre para continuar.');
  return c.user;
}

async function audit(c: Ctx, action: string, username: string | null, detail?: unknown): Promise<void> {
  await c.state.audit({ ts: c.deps.now(), username, ip: c.ip, action, detail });
}

/** Expande um IPv6 para 8 grupos (sem zeros à esquerda). null se não for IPv6 válido. */
function ipv6Groups(ip: string): string[] | null {
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const side = (s: string | undefined): string[] => (s ? s.split(':') : []);
  const head = side(parts[0]);
  const tail = side(parts[1]);
  const last = tail.at(-1) ?? head.at(-1) ?? '';
  // IPv4 no fim (ex.: 64:ff9b::1.2.3.4) ocupa 2 grupos
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(last);
  const n = head.length + tail.length + (v4 ? 1 : 0);
  if (parts.length === 1 ? n !== 8 : n > 7) return null;
  const groups = [...head, ...Array.from({ length: 8 - n }, () => '0'), ...tail];
  if (v4) groups.pop();
  const ok = groups.slice(0, v4 ? 6 : 8).every((g) => /^[0-9a-f]{1,4}$/i.test(g));
  return ok ? groups.map((g) => (/^[0-9a-f]+$/i.test(g) ? Number.parseInt(g, 16).toString(16) : g)) : null;
}

/**
 * Chave de rede do limite de tentativas (S4): IPv6 vira o prefixo /64 (um cliente comum tem o /64 inteiro e
 * trocaria de endereço a cada tentativa); IPv4 mapeado (::ffff:a.b.c.d) vira o IPv4. Outros: como vieram.
 */
export function ipKey(ip: string): string {
  const s = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return mapped[1] ?? s;
  if (!s.includes(':')) return s;
  const g = ipv6Groups(s);
  return g ? g.slice(0, 4).join(':') + '::/64' : s;
}

function rateRules(prefix: string, ip: string, username: string | null): RateRule[] {
  const net = ipKey(ip);
  const rules: RateRule[] = [{ key: prefix + ':ip:' + net, max: RATE.ipMax }];
  if (username) rules.unshift({ key: prefix + ':u:' + username + ':' + net, max: RATE.userMax });
  return rules;
}

function rateLimited(retryAfter: number): HttpError {
  return new HttpError('rate_limited', MSG.rate, undefined, {
    'Retry-After': String(Math.max(1, retryAfter)),
  });
}

function bearer(request: Request): string | null {
  return TOKEN_RE.exec(request.headers.get('Authorization') ?? '')?.[1] ?? null;
}

function publishCtx(c: Ctx, username: string): PublishContext {
  return {
    git: c.git(),
    username,
    page: c.cfg.page,
    schemaPath: c.cfg.schemaPath,
    maxImageBytes: c.cfg.maxUploadBytes,
    now: c.deps.now,
  };
}

/** Hash novo sempre com o pepper ATUAL (e o id dele). */
async function newHash(password: string, c: Ctx): Promise<NewHash> {
  const h = await hashPassword(password, c.env.PASSWORD_PEPPER, c.cfg.iterations);
  return { ...h, pepper_id: c.cfg.pepperId };
}

async function newRecord(username: string, password: string, role: Role, c: Ctx): Promise<UserRecord> {
  const h = await newHash(password, c);
  const now = c.deps.now();
  return { username, role, ...h, created_at: now, last_login_at: null, password_changed_at: now };
}

/**
 * Confere a senha com o pepper da versão gravada no usuário (R10): o atual, ou o PASSWORD_PEPPER_PREV
 * durante uma rotação. Linha antiga sem pepper_id: tenta o atual e, se houver, o anterior. Senha certa com
 * pepper que não é o atual: re-hash transparente com o atual (sem derrubar sessões).
 */
async function checkPassword(c: Ctx, rec: UserRecord | null, password: string): Promise<boolean> {
  const cur = c.env.PASSWORD_PEPPER;
  const prevSecret = c.env.PASSWORD_PEPPER_PREV;
  const prevId = c.cfg.pepperPrevId;
  const prev =
    prevId !== null && prevId !== c.cfg.pepperId && prevSecret && prevSecret.length >= PEPPER_MIN_LENGTH
      ? prevSecret
      : null;
  const onPrev = rec?.pepper_id === prevId && prevId !== null && prev !== null;
  let used = onPrev ? prev : cur;
  let good = await verifyPassword(password, used, rec);
  if (!good && rec?.pepper_id === null && prev) {
    good = await verifyPassword(password, prev, rec);
    used = prev;
  }
  good = good && password.length > 0;
  if (good && rec && (used !== cur || rec.pepper_id !== c.cfg.pepperId)) {
    const h = await newHash(password, c);
    if (await c.state.rehash(rec.username, rec.hash, h))
      await audit(c, 'password_rehash', rec.username, { from: rec.pepper_id, to: h.pepper_id });
  }
  return good;
}

/**
 * C4/S3: ações sobre usuários pedem a senha atual de quem está logado (currentPassword), com o mesmo limite
 * de tentativas do login (usuário+rede e rede). Sessão roubada sozinha não cria admin nem troca senha.
 */
async function reauth(c: Ctx, u: SessionUser): Promise<void> {
  const raw = c.body.currentPassword;
  const pw = typeof raw === 'string' && raw.length <= PASSWORD_MAX ? raw : '';
  if (!pw) {
    await audit(c, 'reauth_fail', u.username, { missing: true });
    throw new HttpError('validation', MSG.review, { currentPassword: 'Digite a sua senha para confirmar.' });
  }
  const rules = rateRules('login', c.ip, u.username);
  const now = c.deps.now();
  const gate = await c.state.rateAcquire(rules, now);
  if (!gate.ok) throw rateLimited(gate.retryAfter);
  let good = false;
  try {
    good = await checkPassword(c, await c.state.getUser(u.username), pw);
  } finally {
    await c.state.rateFinish(rules, good, now, good ? [rules[0]?.key ?? ''] : []);
  }
  if (!good) {
    await audit(c, 'reauth_fail', u.username);
    throw new HttpError('validation', MSG.review, { currentPassword: 'Sua senha está incorreta.' });
  }
}

function configLog(c: Ctx, error: string): void {
  c.deps.log(logLine({ level: 'error', event: 'config_missing', error }));
}

function newUserFields(
  body: Record<string, unknown>,
  withRole: boolean,
): { username: string; password: string; role: Role } {
  const username = normUsername(body.username);
  const fields: FieldErrors = {};
  if (!validUsername(username)) fields.username = MSG_USERNAME;
  const pw = passwordPolicy(body.password, username);
  if (pw) fields.password = pw;
  if (withRole && !isRole(body.role)) fields.role = 'Escolha administrador ou editor.';
  if (Object.keys(fields).length) throw new HttpError('validation', MSG.review, fields);
  return {
    username,
    password: str(body.password),
    role: withRole && isRole(body.role) ? body.role : 'admin',
  };
}

/* ---------------- rotas ---------------- */

const ROUTES: Record<string, Route> = {
  'GET /health': {
    auth: 'none',
    limit: 0,
    noOrigin: true,
    run: (c) => Promise.resolve(ok({ version: VERSION, time: new Date(c.deps.now()).toISOString() })),
  },

  'POST /login': {
    auth: 'none',
    limit: LIMITS.login,
    async run(c) {
      const raw = c.body.username;
      const username = normUsername(raw);
      const valid = validUsername(username);
      const password =
        typeof c.body.password === 'string' && c.body.password.length <= PASSWORD_MAX ? c.body.password : '';
      const secret = c.env.TURNSTILE_SECRET;
      let human = false;
      if (secret) {
        const t = c.body.turnstileToken;
        const msg = { turnstileToken: 'Confirme que você não é um robô e tente de novo.' };
        if (typeof t !== 'string' || !t || t.length > 2048)
          throw new HttpError('validation', MSG.review, msg);
        const r = await verifyTurnstile(c.deps.fetch, secret, t, c.ip);
        if (r === 'unavailable')
          throw new HttpError('upstream', 'A verificação anti-robô não respondeu. Tente de novo.');
        if (r === 'invalid') throw new HttpError('validation', MSG.review, msg);
        human = true;
      }
      const rules = rateRules('login', c.ip, valid ? username : null);
      const now = c.deps.now();
      const gate = await c.state.rateAcquire(rules, now);
      if (!gate.ok) {
        await audit(c, 'login_blocked', valid ? username : null);
        throw rateLimited(gate.retryAfter);
      }
      // S4: contador global do usuário (todas as redes): passou de SLOW.max/h, atraso progressivo curto
      const slowKey = 'login:g:' + username;
      if (valid) {
        const sg = await c.state.slowAcquire(slowKey, now, human);
        if (!sg.ok) {
          // Recusa do atraso NÃO é de graça (rodada 2): conta como falha no limite da REDE (20/15 min), então
          // insistir bloqueia a rede atacante. A chave usuário+rede é devolvida (não houve verificação), para o
          // dono que insiste algumas vezes não se trancar. A recusa não grava last_at (slowAcquire).
          const userRules = rules.filter((r) => r.key.startsWith('login:u:'));
          const netRules = rules.filter((r) => !r.key.startsWith('login:u:'));
          await c.state.rateFinish(userRules, true, now);
          await c.state.rateFinish(netRules, false, now);
          await audit(c, 'login_slowed', username, { retryAfter: sg.retryAfter });
          throw rateLimited(sg.retryAfter);
        }
      }
      const rec = valid ? await c.state.getUser(username) : null;
      let good = false;
      try {
        good = await checkPassword(c, rec, password);
      } finally {
        await c.state.rateFinish(rules, good, now, good ? [rules[0]?.key ?? ''] : []);
      }
      if (good && valid) await c.state.slowSuccess(slowKey);
      if (!good || !rec) {
        // S5: texto digitado em "usuário" inválido pode ser a senha colada no campo errado: não grava
        await audit(c, 'login_fail', valid ? username : null, valid ? undefined : { invalid_username: true });
        throw new HttpError('invalid_credentials', MSG.badLogin);
      }
      const old = bearer(c.request);
      const token = b64url(randomBytes(32));
      await c.state.createSession(
        await sha256Hex(token),
        username,
        now,
        c.ip,
        old ? await sha256Hex(old) : null,
      );
      await audit(c, 'login_ok', username);
      return ok({ token, user: { username, role: rec.role }, expiresIn: Math.floor(c.cfg.idleMs / 1000) });
    },
  },

  'POST /logout': {
    auth: 'user',
    limit: LIMITS.json,
    async run(c) {
      if (c.tokenHash) await c.state.deleteSession(c.tokenHash);
      await audit(c, 'logout', needUser(c).username);
      return ok();
    },
  },

  'GET /me': {
    auth: 'user',
    limit: 0,
    async run(c) {
      const u = needUser(c);
      const out: Record<string, unknown> = { user: { username: u.username, role: u.role } };
      if (u.role === 'admin') {
        let exp = await c.state.getMeta(GITHUB_EXP_KEY);
        const checked = Number((await c.state.getMeta(GITHUB_CHECKED_KEY)) ?? 0);
        if (c.env.GITHUB_TOKEN && (!exp || c.deps.now() - checked > GITHUB_RECHECK_MS)) {
          try {
            await c.git().getHead(); // só para ler o cabeçalho de validade do token
          } catch {
            /* GitHub fora do ar não impede o /me */
          }
          await c.state.setMeta(GITHUB_CHECKED_KEY, String(c.deps.now()));
          exp = c.tokenExpiration ?? exp;
        }
        if (exp) out.githubTokenExpiresAt = exp;
      }
      return ok(out);
    },
  },

  'GET /content': {
    auth: 'user',
    limit: 0,
    async run(c) {
      return ok(await loadContent({ git: c.git(), page: c.cfg.page, schemaPath: c.cfg.schemaPath }));
    },
  },

  'POST /publish': {
    auth: 'user',
    limit: LIMITS.publish,
    async run(c) {
      const u = needUser(c);
      const req = parsePublishRequest(c.body, c.cfg.maxUploadBytes);
      const r = await publish(publishCtx(c, u.username), req);
      await audit(c, 'publish', u.username, {
        commit: r.commit,
        base: req.base,
        rebased: r.rebased,
        attempts: r.attempts,
        changes: r.records,
      });
      c.deps.log(
        logLine({
          level: 'info',
          event: 'publish',
          user: u.username,
          attempts: r.attempts,
          changed: r.changed.length,
        }),
      );
      const out: Record<string, unknown> = { commit: r.commit, changed: r.changed, rebased: r.rebased };
      if (r.rebased) out.othersChanged = r.othersChanged;
      if (Object.keys(r.paths).length) out.paths = r.paths;
      return ok(out);
    },
  },

  'GET /history': {
    auth: 'user',
    limit: 0,
    async run(c) {
      return ok({ versions: await c.git().history(c.cfg.page, 30) });
    },
  },

  'POST /restore': {
    auth: 'user',
    limit: LIMITS.json,
    async run(c) {
      const u = needUser(c);
      const r = await restore(publishCtx(c, u.username), str(c.body.commit), str(c.body.base));
      await audit(c, 'restore', u.username, { restored: r.restored, commit: r.commit });
      return ok({ commit: r.commit });
    },
  },

  'GET /users': {
    auth: 'admin',
    limit: 0,
    async run(c) {
      const users = (await c.state.listUsers()).map(({ pepper_id, ...u }) => ({
        ...u,
        // false = ainda no pepper anterior (não entrou desde a rotação)
        pepper_current: pepper_id === null || pepper_id === c.cfg.pepperId,
      }));
      return ok({ users });
    },
  },

  'POST /users/create': {
    auth: 'admin',
    limit: LIMITS.json,
    async run(c) {
      const u = needUser(c);
      const actor = u.username;
      const n = newUserFields(c.body, true);
      await reauth(c, u);
      const r = await c.state.createUser(await newRecord(n.username, n.password, n.role, c), false);
      if (r !== 'ok')
        throw new HttpError('conflict', 'Já existe um usuário com esse nome.', { username: 'Já existe.' });
      await audit(c, 'user_create', actor, { username: n.username, role: n.role });
      return ok({ user: { username: n.username, role: n.role } });
    },
  },

  'POST /users/delete': {
    auth: 'admin',
    limit: LIMITS.json,
    async run(c) {
      const u = needUser(c);
      const actor = u.username;
      const username = normUsername(c.body.username);
      if (!validUsername(username)) throw new HttpError('bad_request', 'Usuário inválido.');
      if (username === actor)
        throw new HttpError('bad_request', 'Você não pode remover o seu próprio usuário.');
      await reauth(c, u);
      const r = await c.state.deleteUser(actor, username);
      if (r === 'self') throw new HttpError('bad_request', 'Você não pode remover o seu próprio usuário.');
      if (r === 'last_admin')
        throw new HttpError('bad_request', 'Não é possível remover o último administrador.');
      if (r === 'not_found') throw new HttpError('not_found', 'Usuário não encontrado.');
      await audit(c, 'user_delete', actor, { username });
      return ok();
    },
  },

  'POST /users/password': {
    auth: 'admin',
    limit: LIMITS.json,
    async run(c) {
      const u = needUser(c);
      const actor = u.username;
      const username = normUsername(c.body.username);
      if (!validUsername(username)) throw new HttpError('bad_request', 'Usuário inválido.');
      // a própria senha só pela troca com a senha atual (POST /password, "Minha senha")
      if (username === actor)
        throw new HttpError(
          'bad_request',
          'Para trocar a sua própria senha, use "Minha senha" (POST /password, com a senha atual).',
        );
      const pw = passwordPolicy(c.body.password, username);
      if (pw) throw new HttpError('validation', MSG.review, { password: pw });
      await reauth(c, u);
      const h = await newHash(str(c.body.password), c);
      const r = await c.state.setPassword(username, h, c.deps.now(), null);
      if (!r.ok) throw new HttpError('not_found', 'Usuário não encontrado.');
      await audit(c, 'password_reset', actor, { username, sessionsRevoked: r.sessionsRevoked });
      return ok();
    },
  },

  'POST /password': {
    auth: 'user',
    limit: LIMITS.json,
    async run(c) {
      const u = needUser(c);
      const rules = rateRules('login', c.ip, u.username);
      const now = c.deps.now();
      const gate = await c.state.rateAcquire(rules, now);
      if (!gate.ok) throw rateLimited(gate.retryAfter);
      const current =
        typeof c.body.current === 'string' && c.body.current.length <= PASSWORD_MAX ? c.body.current : '';
      const rec = await c.state.getUser(u.username);
      let good = false;
      try {
        good = current.length > 0 && (await checkPassword(c, rec, current));
      } finally {
        await c.state.rateFinish(rules, good, now, good ? [rules[0]?.key ?? ''] : []);
      }
      if (!good) {
        await audit(c, 'password_fail', u.username);
        throw new HttpError('validation', MSG.review, { current: 'Senha atual incorreta.' });
      }
      const next = c.body.new;
      const pw = passwordPolicy(next, u.username);
      if (pw) throw new HttpError('validation', MSG.review, { new: pw });
      if (next === current) {
        throw new HttpError('validation', MSG.review, {
          new: 'A nova senha precisa ser diferente da atual.',
        });
      }
      const h = await newHash(str(next), c);
      const r = await c.state.setPassword(u.username, h, now, c.tokenHash);
      await audit(c, 'password_change', u.username, { sessionsRevoked: r.sessionsRevoked });
      return ok();
    },
  },

  'GET /audit': {
    auth: 'admin',
    limit: 0,
    async run(c) {
      const limit = Number.parseInt(c.url.searchParams.get('limit') ?? '100', 10);
      const before = Number.parseInt(c.url.searchParams.get('before') ?? '', 10);
      const rows = await c.state.listAudit(
        Number.isFinite(limit) ? limit : 100,
        Number.isFinite(before) ? before : null,
      );
      const entries = rows.map((r) => ({
        ...r,
        detail: r.detail === null ? null : (JSON.parse(r.detail) as unknown),
      }));
      return ok({ entries });
    },
  },

  'POST /bootstrap': {
    auth: 'none',
    limit: LIMITS.login,
    noOrigin: true,
    async run(c) {
      const deny = (): HttpError => new HttpError('forbidden', 'Não permitido.');
      const secret = c.env.BOOTSTRAP_SECRET;
      if (!secret) throw deny();
      if (secret.length < SECRET_MIN_LENGTH) {
        configLog(c, 'BOOTSTRAP_SECRET curto (mínimo ' + SECRET_MIN_LENGTH + ' caracteres)');
        throw deny();
      }
      const rules = rateRules('boot', c.ip, null);
      const now = c.deps.now();
      const gate = await c.state.rateAcquire(rules, now);
      if (!gate.ok) throw rateLimited(gate.retryAfter);
      const good = timingSafeEqual(await sha256(str(c.body.secret)), await sha256(secret));
      await c.state.rateFinish(rules, good, now);
      if (!good) {
        await audit(c, 'bootstrap_fail', null);
        throw deny();
      }
      if ((await c.state.userCount()) > 0) throw deny();
      const n = newUserFields(c.body, false);
      const r = await c.state.createUser(await newRecord(n.username, n.password, 'admin', c), true);
      if (r !== 'ok') throw deny();
      await audit(c, 'user_create', n.username, { username: n.username, role: 'admin', bootstrap: true });
      return ok({ user: { username: n.username, role: 'admin' } });
    },
  },

  /* R10: recuperação de admin quando ninguém consegue entrar. Só existe com RECOVERY_SECRET definido
   * (>= 32), compara em tempo constante, limite por rede, auditada e de USO ÚNICO por valor do secret. */
  'POST /recover': {
    auth: 'none',
    limit: LIMITS.login,
    noOrigin: true,
    async run(c) {
      const deny = (m = 'Não permitido.'): HttpError => new HttpError('forbidden', m);
      const secret = c.env.RECOVERY_SECRET;
      if (!secret) throw deny();
      if (secret.length < SECRET_MIN_LENGTH) {
        configLog(c, 'RECOVERY_SECRET curto (mínimo ' + SECRET_MIN_LENGTH + ' caracteres)');
        throw deny();
      }
      const rules: RateRule[] = [{ key: 'recover:ip:' + ipKey(c.ip), max: RECOVER_IP_MAX }];
      const now = c.deps.now();
      const gate = await c.state.rateAcquire(rules, now);
      if (!gate.ok) throw rateLimited(gate.retryAfter);
      const good = timingSafeEqual(await sha256(str(c.body.secret)), await sha256(secret));
      await c.state.rateFinish(rules, good, now);
      if (!good) {
        await audit(c, 'recover_fail', null);
        throw deny();
      }
      const usedKey = 'recovery_used:' + (await sha256Hex('hg-cms-recover:' + secret));
      if ((await c.state.getMeta(usedKey)) !== null) {
        await audit(c, 'recover_reused', null);
        throw deny('Este RECOVERY_SECRET já foi usado. Gere outro, configure e tente de novo.');
      }
      const username = normUsername(c.body.username);
      const rec = validUsername(username) ? await c.state.getUser(username) : null;
      if (rec?.role !== 'admin') throw new HttpError('not_found', 'Administrador não encontrado.');
      const pw = passwordPolicy(c.body.password, username);
      if (pw) throw new HttpError('validation', MSG.review, { password: pw });
      if (!(await c.state.claimOnce(usedKey, new Date(now).toISOString())))
        throw deny('Este RECOVERY_SECRET já foi usado. Gere outro, configure e tente de novo.');
      const r = await c.state.setPassword(username, await newHash(str(c.body.password), c), now, null);
      // o admin recuperado volta a poder entrar na hora: zera os limites DELE (usuário+rede e global)
      const cleared = await c.state.clearUserLimits(username);
      await audit(c, 'recover_ok', username, { sessionsRevoked: r.sessionsRevoked, limitsCleared: cleared });
      c.deps.log(logLine({ level: 'warn', event: 'recovery_used', user: username }));
      return ok({ user: { username, role: 'admin' }, sessionsRevoked: r.sessionsRevoked });
    },
  },
};

const PATHS = new Set(Object.keys(ROUTES).map((k) => k.split(' ')[1]));

/* ---------------- entrada ---------------- */

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const started = deps.now();
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const cfg = readConfig(env);
  const origin = request.headers.get('Origin');
  const allowed = origin !== null && cfg.origins.includes(origin);
  const route = ROUTES[request.method + ' ' + path];
  const entry: LogEntry = {
    level: 'info',
    event: 'request',
    route: PATHS.has(path) ? path : 'unknown',
    method: request.method,
  };
  let status = 500;
  let user: string | undefined;
  try {
    const res = await dispatch();
    status = res.status;
    return res;
  } finally {
    entry.status = status;
    entry.ms = deps.now() - started;
    if (user) entry.user = user;
    if (status >= 500) entry.level = 'error';
    else if (status >= 400) entry.level = 'warn';
    deps.log(logLine(entry));
  }

  async function dispatch(): Promise<Response> {
    const corsFail = (): Response => {
      entry.code = 'cors';
      return respond(403, { ok: false, error: 'Origem não permitida.', code: 'cors' }, null);
    };
    if (origin !== null && !allowed) return corsFail();
    if (request.method === 'OPTIONS') {
      if (!allowed) return corsFail();
      return respond(204, null, origin, {
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type',
        'Access-Control-Max-Age': '600',
      });
    }
    if (!allowed && !route?.noOrigin) return corsFail();
    const replyOrigin = allowed ? origin : null;
    const c: Ctx = {
      request,
      url,
      env,
      cfg,
      deps,
      ip: request.headers.get('CF-Connecting-IP') ?? '127.0.0.1',
      state: stateOf(env),
      body: {},
      user: null,
      tokenHash: null,
      tokenExpiration: null,
      git: () => {
        if (!env.GITHUB_TOKEN) throw new ConfigError('GITHUB_TOKEN ausente');
        const apiBase = githubApiBase(env);
        if (!apiBase) throw new ConfigError('GITHUB_API_BASE inválido (só https://api.github.com)');
        return createGitHub({
          apiBase,
          owner: env.GITHUB_OWNER,
          repo: env.GITHUB_REPO,
          branch: env.GITHUB_BRANCH || 'main',
          token: env.GITHUB_TOKEN,
          fetch: deps.fetch,
          onTokenExpiration: (iso) => {
            c.tokenExpiration = iso;
          },
        });
      },
    };
    try {
      if (!route) {
        if (PATHS.has(path)) throw new HttpError('method', 'Método não permitido.');
        throw new HttpError('not_found', 'Rota não encontrada.');
      }
      if (route.auth !== 'none') {
        const token = bearer(request);
        if (!token) throw new HttpError('unauthenticated', 'Entre para continuar.');
        c.tokenHash = await sha256Hex(token);
        c.user = await c.state.touchSession(c.tokenHash, deps.now());
        if (!c.user) throw new HttpError('session_expired', MSG.expired);
        user = c.user.username;
        if (route.auth === 'admin' && c.user.role !== 'admin')
          throw new HttpError('forbidden', MSG.forbidden);
      }
      if (request.method === 'POST') c.body = await readJson(request, route.limit);
      const body = await route.run(c);
      if (c.tokenExpiration) await rememberTokenExpiration(c, c.tokenExpiration);
      return respond(200, body, replyOrigin);
    } catch (e) {
      const err = toHttpError(e, (le) => {
        deps.log(logLine({ ...le, route: entry.route ?? 'unknown', ...(user ? { user } : {}) }));
      });
      entry.code = err.code;
      return respond(err.status, errorBody(err), replyOrigin, err.headers);
    }
  }
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

async function rememberTokenExpiration(c: Ctx, iso: string): Promise<void> {
  await c.state.setMeta(GITHUB_EXP_KEY, iso);
}

/** Erro qualquer -> resposta. Exportado só para o teste do mapeamento (integridade, GitHub, config). */
export function toHttpError(e: unknown, log: (e: LogEntry) => void): HttpError {
  if (e instanceof IntegrityError) {
    log({ level: 'error', event: 'publish_integrity', error: e.detail.slice(0, 200) });
    return e;
  }
  if (e instanceof HttpError) return e;
  if (e instanceof GitHubError) {
    log({
      level: e.status === 401 || e.status === 403 ? 'error' : 'warn',
      event: 'github_error',
      code: 'github_' + String(e.status),
    });
    return new HttpError('upstream', MSG.upstream);
  }
  if (e instanceof PepperError || e instanceof ConfigError) {
    log({ level: 'error', event: 'config_missing', error: e.message });
    return new HttpError('server', MSG.server);
  }
  log({ level: 'error', event: 'unhandled', error: e instanceof Error ? e.name : typeof e });
  return new HttpError('server', MSG.server);
}
