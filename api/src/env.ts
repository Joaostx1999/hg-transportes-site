/* Variáveis, segredos e bindings do Worker, e leitura tipada da configuração. */
import type { CmsState } from './state.ts';
import type * as MainModule from './index.ts';
import { clampIterations, PBKDF2_MAX_ITERATIONS } from './password.ts';

export interface Env {
  CMS_STATE: DurableObjectNamespace<CmsState>;
  // segredos (wrangler secret put)
  GITHUB_TOKEN?: string;
  PASSWORD_PEPPER?: string;
  /** pepper anterior, só durante a rotação (re-hash no login); apagar quando todos tiverem entrado */
  PASSWORD_PEPPER_PREV?: string;
  /** efêmero: só durante a criação do 1º admin; apagar depois (>= 32 caracteres) */
  BOOTSTRAP_SECRET?: string;
  /** efêmero e de uso único: recuperação de admin (POST /recover); apagar depois (>= 32 caracteres) */
  RECOVERY_SECRET?: string;
  TURNSTILE_SECRET?: string;
  /** "1" libera GITHUB_API_BASE em 127.0.0.1/localhost (mock do dev). Nunca em produção. */
  DEV_ALLOW_LOCAL_GITHUB?: string;
  /** versão do PASSWORD_PEPPER atual (inteiro >= 1; padrão 1) e do anterior */
  PASSWORD_PEPPER_ID?: string;
  PASSWORD_PEPPER_PREV_ID?: string;
  // variáveis ([vars] do wrangler.toml)
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  GITHUB_API_BASE: string;
  ALLOWED_ORIGINS: string;
  SITE_PAGE: string;
  SCHEMA_PATH: string;
  SESSION_IDLE_SECONDS: string;
  SESSION_MAX_SECONDS: string;
  MAX_UPLOAD_BYTES: string;
  PBKDF2_ITERATIONS: string;
}

export interface Config {
  idleMs: number;
  maxMs: number;
  maxUploadBytes: number;
  iterations: number;
  page: string;
  schemaPath: string;
  origins: string[];
  pepperId: number;
  /** null quando não há rotação em curso */
  pepperPrevId: number | null;
}

function int(v: string | undefined, d: number): number {
  const x = Number.parseInt(v ?? '', 10);
  return Number.isFinite(x) && x > 0 ? x : d;
}

export function readConfig(env: Partial<Env>): Config {
  return {
    idleMs: int(env.SESSION_IDLE_SECONDS, 3600) * 1000,
    maxMs: int(env.SESSION_MAX_SECONDS, 43200) * 1000,
    maxUploadBytes: int(env.MAX_UPLOAD_BYTES, 3 * 1024 * 1024),
    iterations: clampIterations(int(env.PBKDF2_ITERATIONS, PBKDF2_MAX_ITERATIONS)),
    page: env.SITE_PAGE ?? 'index.html',
    schemaPath: env.SCHEMA_PATH ?? 'cms/schema.json',
    origins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    pepperId: int(env.PASSWORD_PEPPER_ID, 1),
    pepperPrevId: env.PASSWORD_PEPPER_PREV_ID ? int(env.PASSWORD_PEPPER_PREV_ID, 0) || null : null,
  };
}

export const GITHUB_API = 'https://api.github.com';

/**
 * S9: o token do GitHub só sai para https://api.github.com. O mock do dev (http em 127.0.0.1/localhost) só
 * com DEV_ALLOW_LOCAL_GITHUB=1. Qualquer outra coisa: null (o Worker falha fechado, sem chamar ninguém).
 */
export function githubApiBase(env: Partial<Env>): string | null {
  const raw = (env.GITHUB_API_BASE ?? '').trim().replace(/\/+$/, '') || GITHUB_API;
  if (raw === GITHUB_API) return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  const plain = !u.username && !u.password && (u.pathname === '/' || u.pathname === '') && !u.search;
  if (
    env.DEV_ALLOW_LOCAL_GITHUB === '1' &&
    local &&
    plain &&
    (u.protocol === 'http:' || u.protocol === 'https:')
  )
    return u.origin;
  return null;
}

declare global {
  // Tipa `env` de cloudflare:workers / cloudflare:test nos testes.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends AppEnv {}
    interface GlobalProps {
      mainModule: typeof MainModule;
      durableNamespaces: 'CmsState';
    }
  }
}
type AppEnv = Env;
