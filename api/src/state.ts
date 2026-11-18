/* Durable Object SQLite global (idFromName("global")): usuários, sessões, limite de tentativas, auditoria.
 * Cada método RPC é síncrono no SQLite e roda inteiro sem await, então é atômico em relação aos demais
 * pedidos (o DO processa um evento por vez); os que mexem em mais de uma linha usam transactionSync.
 * O relógio vem do chamador (o Worker), o que deixa os testes controlarem o tempo. */
import { DurableObject } from 'cloudflare:workers';
import { readConfig, type Env } from './env.ts';
import type { Role } from './validate.ts';

export interface UserRecord {
  username: string;
  role: Role;
  salt: string;
  hash: string;
  iterations: number;
  created_at: number;
  last_login_at: number | null;
  password_changed_at: number;
  /** versão do PASSWORD_PEPPER usada no hash; null = linha de antes da migração v2 (pepper atual) */
  pepper_id: number | null;
}

export interface PublicUser {
  username: string;
  role: Role;
  created_at: string;
  last_login_at: string | null;
  pepper_id: number | null;
}

export interface NewHash {
  salt: string;
  hash: string;
  iterations: number;
  pepper_id: number;
}

export interface SessionUser {
  username: string;
  role: Role;
}

export interface RateRule {
  key: string;
  max: number;
}

export interface AuditEntry {
  id: number;
  ts: string;
  username: string | null;
  ip: string | null;
  action: string;
  /** JSON cru (o Worker faz o parse antes de responder) */
  detail: string | null;
}

/** Política do limite de tentativas (janela e bloqueio iguais para todas as chaves). */
export const RATE = { windowMs: 15 * 60 * 1000, blockMs: 15 * 60 * 1000, userMax: 5, ipMax: 20 } as const;
/**
 * Contador global por usuário (todas as origens): passou de `max` tentativas na janela, cada nova tentativa
 * espera 1 s, 2 s, 4 s... até `maxDelayMs` desde a anterior. Não trava a conta (o dono espera segundos);
 * com Turnstile verificado no pedido, a espera é dispensada.
 */
export const SLOW = { max: 50, windowMs: 3600 * 1000, maxDelayMs: 30 * 1000 } as const;
/** last_seen só é regravado depois deste intervalo: GET repetido não escreve no DO a cada pedido. */
export const SESSION_TOUCH_MS = 60 * 1000;
export const AUDIT_RETENTION_MS = 365 * 24 * 3600 * 1000;
const CLEANUP_EVERY_MS = 60 * 1000;

type Row = Record<string, SqlStorageValue>;

/** Valores do SQLite com tipo conferido (nunca "[object ArrayBuffer]"). */
function text(v: SqlStorageValue | undefined): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  throw new TypeError('coluna de texto inesperada');
}
function textOrNull(v: SqlStorageValue | undefined): string | null {
  return v === null || v === undefined ? null : text(v);
}

const iso = (ms: number): string => new Date(ms).toISOString();

export class CmsState extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private lastCleanup = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
  }

  /** Migrações idempotentes; a versão fica em meta.schema_version (PRAGMA user_version não é permitido no DO). */
  private migrate(): void {
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const v = Number(this.getMeta('schema_version') ?? 0);
    if (v < 1) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`CREATE TABLE IF NOT EXISTS users (
          username TEXT PRIMARY KEY,
          role TEXT NOT NULL CHECK (role IN ('admin','editor')),
          salt TEXT NOT NULL,
          hash TEXT NOT NULL,
          iterations INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          last_login_at INTEGER,
          password_changed_at INTEGER NOT NULL
        )`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          ip TEXT
        )`);
        this.sql.exec('CREATE INDEX IF NOT EXISTS sessions_user ON sessions(username)');
        this.sql.exec(`CREATE TABLE IF NOT EXISTS rate_limits (
          key TEXT PRIMARY KEY,
          count INTEGER NOT NULL,
          window_start INTEGER NOT NULL,
          blocked_until INTEGER NOT NULL DEFAULT 0
        )`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          username TEXT,
          ip TEXT,
          action TEXT NOT NULL,
          detail TEXT
        )`);
        this.setMeta('schema_version', '1');
      });
    }
    if (v < 2) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('ALTER TABLE users ADD COLUMN pepper_id INTEGER');
        this.sql.exec(`CREATE TABLE IF NOT EXISTS slow_limits (
          key TEXT PRIMARY KEY,
          count INTEGER NOT NULL,
          window_start INTEGER NOT NULL,
          last_at INTEGER NOT NULL
        )`);
        this.setMeta('schema_version', '2');
      });
    }
  }

  /** Limpeza oportunista (no máximo 1x por minuto): sessões vencidas, limites vencidos, auditoria antiga. */
  private cleanup(now: number): void {
    if (now - this.lastCleanup < CLEANUP_EVERY_MS && now >= this.lastCleanup) return;
    this.lastCleanup = now;
    const c = readConfig(this.env);
    this.sql.exec(
      'DELETE FROM sessions WHERE last_seen < ? OR created_at < ?',
      now - c.idleMs,
      now - c.maxMs,
    );
    this.sql.exec(
      'DELETE FROM rate_limits WHERE blocked_until < ? AND window_start < ?',
      now,
      now - RATE.windowMs,
    );
    this.sql.exec('DELETE FROM slow_limits WHERE window_start < ?', now - SLOW.windowMs);
    this.sql.exec('DELETE FROM audit WHERE ts < ?', now - AUDIT_RETENTION_MS);
  }

  /* ---------------- usuários ---------------- */

  userCount(): number {
    return Number(this.sql.exec('SELECT COUNT(*) AS n FROM users').one().n);
  }

  getUser(username: string): UserRecord | null {
    const r = this.sql.exec('SELECT * FROM users WHERE username = ?', username).toArray()[0];
    return r ? toUser(r) : null;
  }

  listUsers(): PublicUser[] {
    return this.sql
      .exec('SELECT * FROM users ORDER BY created_at, username')
      .toArray()
      .map((r) => {
        const u = toUser(r);
        return {
          username: u.username,
          role: u.role,
          created_at: iso(u.created_at),
          last_login_at: u.last_login_at === null ? null : iso(u.last_login_at),
          pepper_id: u.pepper_id,
        };
      });
  }

  /** Cria usuário. onlyIfEmpty = bootstrap (só quando não existe nenhum usuário). */
  createUser(rec: UserRecord, onlyIfEmpty: boolean): 'ok' | 'exists' | 'not_empty' {
    return this.ctx.storage.transactionSync(() => {
      if (onlyIfEmpty && this.userCount() > 0) return 'not_empty';
      if (this.getUser(rec.username)) return 'exists';
      this.sql.exec(
        'INSERT INTO users (username, role, salt, hash, iterations, created_at, last_login_at, password_changed_at, pepper_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        rec.username,
        rec.role,
        rec.salt,
        rec.hash,
        rec.iterations,
        rec.created_at,
        rec.last_login_at,
        rec.password_changed_at,
        rec.pepper_id,
      );
      return 'ok';
    });
  }

  /** Remove usuário e as sessões dele. Recusa remover a si mesmo e o último admin. */
  deleteUser(actor: string, username: string): 'ok' | 'self' | 'not_found' | 'last_admin' {
    return this.ctx.storage.transactionSync(() => {
      if (actor === username) return 'self';
      const u = this.getUser(username);
      if (!u) return 'not_found';
      if (u.role === 'admin') {
        const admins = Number(this.sql.exec("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").one().n);
        if (admins <= 1) return 'last_admin';
      }
      this.sql.exec('DELETE FROM sessions WHERE username = ?', username);
      this.sql.exec('DELETE FROM users WHERE username = ?', username);
      return 'ok';
    });
  }

  /** Troca o hash e derruba as sessões do usuário, exceto keepTokenHash (a sessão de quem trocou). */
  setPassword(
    username: string,
    h: NewHash,
    now: number,
    keepTokenHash: string | null,
  ): { ok: boolean; sessionsRevoked: number } {
    return this.ctx.storage.transactionSync(() => {
      const cur = this.sql.exec(
        'UPDATE users SET salt = ?, hash = ?, iterations = ?, pepper_id = ?, password_changed_at = ? WHERE username = ?',
        h.salt,
        h.hash,
        h.iterations,
        h.pepper_id,
        now,
        username,
      );
      if (cur.rowsWritten === 0) return { ok: false, sessionsRevoked: 0 };
      const del = this.sql.exec(
        'DELETE FROM sessions WHERE username = ? AND token_hash IS NOT ?',
        username,
        keepTokenHash,
      );
      return { ok: true, sessionsRevoked: del.rowsWritten };
    });
  }

  /**
   * Re-hash transparente (mesma senha, pepper/iterações novos) depois de um login certo. Só grava se o
   * hash que foi verificado (`oldHash`) ainda é o atual: não sobrescreve uma troca de senha concorrente.
   */
  rehash(username: string, oldHash: string, h: NewHash): boolean {
    return (
      this.sql.exec(
        'UPDATE users SET salt = ?, hash = ?, iterations = ?, pepper_id = ? WHERE username = ? AND hash = ?',
        h.salt,
        h.hash,
        h.iterations,
        h.pepper_id,
        username,
        oldHash,
      ).rowsWritten > 0
    );
  }

  /* ---------------- sessões ---------------- */

  /** Cria sessão (guarda só o hash do token). revokeTokenHash: token antigo apresentado no login (rotação). */
  createSession(
    tokenHash: string,
    username: string,
    now: number,
    ip: string,
    revokeTokenHash: string | null,
  ): void {
    this.cleanup(now);
    this.ctx.storage.transactionSync(() => {
      if (revokeTokenHash) this.sql.exec('DELETE FROM sessions WHERE token_hash = ?', revokeTokenHash);
      this.sql.exec(
        'INSERT INTO sessions (token_hash, username, created_at, last_seen, ip) VALUES (?, ?, ?, ?, ?)',
        tokenHash,
        username,
        now,
        now,
        ip,
      );
      this.sql.exec('UPDATE users SET last_login_at = ? WHERE username = ?', now, username);
    });
  }

  /** Valida e renova a sessão (inatividade e tempo absoluto). null = inexistente ou vencida (e apagada). */
  touchSession(tokenHash: string, now: number): SessionUser | null {
    const c = readConfig(this.env);
    const r = this.sql
      .exec(
        'SELECT s.created_at, s.last_seen, u.username, u.role FROM sessions s JOIN users u ON u.username = s.username WHERE s.token_hash = ?',
        tokenHash,
      )
      .toArray()[0];
    if (!r) return null;
    const created = Number(r.created_at);
    const seen = Number(r.last_seen);
    if (now - seen > c.idleMs || now - created > c.maxMs) {
      this.sql.exec('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
      return null;
    }
    if (now - seen >= SESSION_TOUCH_MS)
      this.sql.exec('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', now, tokenHash);
    return { username: text(r.username), role: r.role === 'admin' ? 'admin' : 'editor' };
  }

  deleteSession(tokenHash: string): void {
    this.sql.exec('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
  }

  sessionCount(username: string): number {
    return Number(this.sql.exec('SELECT COUNT(*) AS n FROM sessions WHERE username = ?', username).one().n);
  }

  /* ---------------- limite de tentativas ---------------- */

  /**
   * Reserva uma tentativa ANTES da verificação da senha (conta como falha até rateFinish dizer o contrário).
   * Como a reserva é atômica, N pedidos simultâneos não conseguem mais do que `max` verificações.
   */
  rateAcquire(rules: RateRule[], now: number): { ok: true } | { ok: false; retryAfter: number } {
    this.cleanup(now);
    return this.ctx.storage.transactionSync(() => {
      const rows = rules.map((r) => ({
        rule: r,
        row: this.sql.exec('SELECT * FROM rate_limits WHERE key = ?', r.key).toArray()[0],
      }));
      let until = 0;
      for (const { row } of rows)
        if (row && Number(row.blocked_until) > now) until = Math.max(until, Number(row.blocked_until));
      if (until) return { ok: false, retryAfter: Math.ceil((until - now) / 1000) };
      for (const { rule, row } of rows) {
        const fresh = !row || now - Number(row.window_start) > RATE.windowMs;
        const count = (fresh ? 0 : Number(row.count)) + 1;
        const start = fresh ? now : Number(row.window_start);
        const blocked = count > rule.max ? now + RATE.blockMs : 0;
        if (blocked) until = Math.max(until, blocked);
        this.sql.exec(
          'INSERT INTO rate_limits (key, count, window_start, blocked_until) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_start = excluded.window_start, blocked_until = excluded.blocked_until',
          rule.key,
          count,
          start,
          blocked,
        );
      }
      return until ? { ok: false, retryAfter: Math.ceil((until - now) / 1000) } : { ok: true };
    });
  }

  /** Fecha a tentativa: sucesso zera a chave do usuário e devolve a reserva do IP; falha pode bloquear. */
  rateFinish(rules: RateRule[], success: boolean, now: number, clearKeys: string[] = []): void {
    this.ctx.storage.transactionSync(() => {
      if (success) {
        for (const k of clearKeys) this.sql.exec('DELETE FROM rate_limits WHERE key = ?', k);
        for (const r of rules) {
          if (clearKeys.includes(r.key)) continue;
          this.sql.exec('UPDATE rate_limits SET count = MAX(count - 1, 0) WHERE key = ?', r.key);
        }
        return;
      }
      for (const r of rules) {
        this.sql.exec(
          'UPDATE rate_limits SET blocked_until = ? WHERE key = ? AND count >= ? AND blocked_until < ?',
          now + RATE.blockMs,
          r.key,
          r.max,
          now,
        );
      }
    });
  }

  /**
   * Contador global por usuário (SLOW). `bypass` (Turnstile verificado) conta a tentativa sem exigir espera.
   * Atômico como o rateAcquire (método síncrono do DO).
   */
  slowAcquire(key: string, now: number, bypass: boolean): { ok: true } | { ok: false; retryAfter: number } {
    this.cleanup(now);
    return this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec('SELECT * FROM slow_limits WHERE key = ?', key).toArray()[0];
      const fresh = !row || now - Number(row.window_start) > SLOW.windowMs;
      const count = fresh ? 0 : Number(row.count);
      const start = fresh ? now : Number(row.window_start);
      if (!bypass && count >= SLOW.max && row) {
        const delay = Math.min(SLOW.maxDelayMs, 1000 * 2 ** Math.min(count - SLOW.max, 30));
        const next = Number(row.last_at) + delay;
        if (now < next) return { ok: false, retryAfter: Math.ceil((next - now) / 1000) };
      }
      this.sql.exec(
        'INSERT INTO slow_limits (key, count, window_start, last_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_start = excluded.window_start, last_at = excluded.last_at',
        key,
        count + 1,
        start,
        now,
      );
      return { ok: true };
    });
  }

  /**
   * Apaga os limites de tentativa de UM usuário: as chaves usuário+rede (`login:u:<usuário>:*`) e o contador
   * global (`login:g:<usuário>`). As chaves só de rede ficam (são de quem estiver na rede). Usado pelo
   * /recover. Compara prefixo com substr (não LIKE: `_` do nome de usuário seria curinga).
   */
  clearUserLimits(username: string): number {
    return this.ctx.storage.transactionSync(() => {
      const prefix = 'login:u:' + username + ':';
      const a = this.sql.exec(
        'DELETE FROM rate_limits WHERE substr(key, 1, ?) = ?',
        prefix.length,
        prefix,
      ).rowsWritten;
      const b = this.sql.exec('DELETE FROM slow_limits WHERE key = ?', 'login:g:' + username).rowsWritten;
      return a + b;
    });
  }

  /** Login certo não conta no contador global (mas não o zera: um ataque em curso continua lento). */
  slowSuccess(key: string): void {
    this.sql.exec('UPDATE slow_limits SET count = MAX(count - 1, 0) WHERE key = ?', key);
  }

  /* ---------------- auditoria e meta ---------------- */

  audit(e: {
    ts: number;
    username: string | null;
    ip: string | null;
    action: string;
    detail?: unknown;
  }): void {
    this.sql.exec(
      'INSERT INTO audit (ts, username, ip, action, detail) VALUES (?, ?, ?, ?, ?)',
      e.ts,
      e.username,
      e.ip,
      e.action,
      e.detail === undefined || e.detail === null ? null : JSON.stringify(e.detail),
    );
  }

  listAudit(limit: number, beforeId: number | null): AuditEntry[] {
    const n = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows =
      beforeId === null
        ? this.sql.exec('SELECT * FROM audit ORDER BY id DESC LIMIT ?', n).toArray()
        : this.sql.exec('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?', beforeId, n).toArray();
    return rows.map((r) => ({
      id: Number(r.id),
      ts: iso(Number(r.ts)),
      username: textOrNull(r.username),
      ip: textOrNull(r.ip),
      action: text(r.action),
      detail: textOrNull(r.detail),
    }));
  }

  getMeta(key: string): string | null {
    const r = this.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
    return r ? text(r.value) : null;
  }

  /** Grava a chave só se ela ainda não existe (uso único). true = esta chamada gravou. */
  claimOnce(key: string, value: string): boolean {
    return (
      this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', key, value)
        .rowsWritten > 0
    );
  }

  /** Grava só se o valor mudou (C7: GET repetido não escreve). true = gravou. */
  setMeta(key: string, value: string): boolean {
    return (
      this.sql.exec(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE meta.value IS NOT excluded.value',
        key,
        value,
      ).rowsWritten > 0
    );
  }
}

function toUser(r: Row): UserRecord {
  return {
    username: text(r.username),
    role: r.role === 'admin' ? 'admin' : 'editor',
    salt: text(r.salt),
    hash: text(r.hash),
    iterations: Number(r.iterations),
    created_at: Number(r.created_at),
    last_login_at: r.last_login_at === null ? null : Number(r.last_login_at),
    password_changed_at: Number(r.password_changed_at),
    pepper_id: r.pepper_id === null || r.pepper_id === undefined ? null : Number(r.pepper_id),
  };
}
