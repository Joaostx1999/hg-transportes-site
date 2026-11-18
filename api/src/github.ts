/* Cliente mínimo da Git Data API do GitHub (refs, commits, trees, blobs) + contents/commits para leitura.
 * Base configurável (GITHUB_API_BASE) para o mock local. fetch injetável. O token nunca sai em erro nem log.
 * Toda resposta com o cabeçalho github-authentication-token-expiration é repassada a onTokenExpiration. */
import { b64ToBytes, bytesToB64, isRecord } from './util.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export interface GitPerson {
  name: string;
  email: string;
  date: string;
}

export interface CommitInfo {
  sha: string;
  tree: string;
  parents: string[];
}

export interface HistoryEntry {
  commit: string;
  date: string | null;
  author: string;
  message: string;
}

export interface TreeEntry {
  path: string;
  sha: string;
}

/** Operações usadas pela publicação. Implementada por createGitHub (HTTP) e por fakes nos testes. */
export interface GitApi {
  getHead(): Promise<string>;
  getCommit(sha: string): Promise<CommitInfo | null>;
  getFile(commitSha: string, path: string): Promise<Uint8Array | null>;
  createBlob(bytes: Uint8Array): Promise<string>;
  createTree(baseTree: string, entries: TreeEntry[]): Promise<string>;
  createCommit(c: {
    message: string;
    tree: string;
    parents: string[];
    author: GitPerson;
    committer: GitPerson;
  }): Promise<string>;
  /** Avança o branch sem forçar. 'not_fast_forward' quando o GitHub recusa (422). */
  updateHead(sha: string): Promise<'ok' | 'not_fast_forward'>;
  history(path: string, perPage: number): Promise<HistoryEntry[]>;
}

export interface GitHubOptions {
  apiBase: string;
  owner: string;
  repo: string;
  branch: string;
  token: string;
  fetch: FetchLike;
  onTokenExpiration?: (iso: string) => void;
}

export const SHA_RE = /^[0-9a-f]{40}$/;

/** "2026-12-31 23:59:59 UTC" ou "2026-12-31 23:59:59 -0800" -> ISO. null se não reconhecer. */
export function parseTokenExpiration(v: string | null): string | null {
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/.exec(v.trim());
  if (!m) return null;
  let tz = m[3] ?? 'Z';
  if (tz === 'UTC') tz = 'Z';
  else if (/^[+-]\d{4}$/.test(tz)) tz = tz.slice(0, 3) + ':' + tz.slice(3);
  const t = Date.parse(m[1] + 'T' + (m[2]?.length === 5 ? m[2] + ':00' : m[2]) + tz);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function createGitHub(o: GitHubOptions): GitApi {
  const base = o.apiBase.replace(/\/+$/, '');
  const repo = '/repos/' + encodeURIComponent(o.owner) + '/' + encodeURIComponent(o.repo);
  const encPath = (p: string): string => p.split('/').map(encodeURIComponent).join('/');
  const branchRef = 'heads/' + encodeURIComponent(o.branch);

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      const init: RequestInit = {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + o.token,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'hg-cms-worker',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      res = await o.fetch(base + repo + path, init);
    } catch {
      throw new GitHubError(0, 'falha de rede');
    }
    const exp = parseTokenExpiration(res.headers.get('github-authentication-token-expiration'));
    if (exp && o.onTokenExpiration) o.onTokenExpiration(exp);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  function fail(status: number, json: unknown): never {
    const msg = isRecord(json) && typeof json.message === 'string' ? json.message : 'HTTP ' + status;
    throw new GitHubError(status, msg.slice(0, 200));
  }

  async function ok(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const r = await call(method, path, body);
    if (r.status < 200 || r.status >= 300) fail(r.status, r.json);
    if (!isRecord(r.json)) throw new GitHubError(502, 'resposta inesperada');
    return r.json;
  }

  const shaOf = (j: Record<string, unknown>): string => {
    const s = j.sha;
    if (typeof s !== 'string' || !SHA_RE.test(s)) throw new GitHubError(502, 'sha inesperado');
    return s;
  };

  return {
    async getHead() {
      const j = await ok('GET', '/git/ref/' + branchRef);
      const obj = j.object;
      if (!isRecord(obj)) throw new GitHubError(502, 'ref inesperada');
      return shaOf(obj);
    },

    async getCommit(sha) {
      if (!SHA_RE.test(sha)) return null;
      const r = await call('GET', '/git/commits/' + sha);
      if (r.status === 404 || r.status === 422) return null;
      if (r.status !== 200 || !isRecord(r.json)) fail(r.status, r.json);
      const j = r.json;
      const tree = isRecord(j.tree) ? j.tree.sha : null;
      if (typeof tree !== 'string' || !SHA_RE.test(tree)) throw new GitHubError(502, 'commit inesperado');
      const parents = Array.isArray(j.parents)
        ? j.parents.map((p) => (isRecord(p) && typeof p.sha === 'string' ? p.sha : '')).filter(Boolean)
        : [];
      return { sha: shaOf(j), tree, parents };
    },

    async getFile(commitSha, path) {
      const r = await call('GET', '/contents/' + encPath(path) + '?ref=' + encodeURIComponent(commitSha));
      if (r.status === 404 || r.status === 422) return null;
      if (r.status !== 200 || !isRecord(r.json)) fail(r.status, r.json);
      const j = r.json;
      if (j.type !== undefined && j.type !== 'file') return null;
      if (j.encoding === 'base64' && typeof j.content === 'string') return b64ToBytes(j.content);
      // arquivos > 1 MB vêm sem conteúdo: busca pelo blob
      if (typeof j.sha === 'string' && SHA_RE.test(j.sha)) {
        const b = await ok('GET', '/git/blobs/' + j.sha);
        if (b.encoding === 'base64' && typeof b.content === 'string') return b64ToBytes(b.content);
      }
      throw new GitHubError(502, 'conteúdo inesperado');
    },

    async createBlob(bytes) {
      return shaOf(await ok('POST', '/git/blobs', { content: bytesToB64(bytes), encoding: 'base64' }));
    },

    async createTree(baseTree, entries) {
      return shaOf(
        await ok('POST', '/git/trees', {
          base_tree: baseTree,
          tree: entries.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha })),
        }),
      );
    },

    async createCommit(c) {
      return shaOf(await ok('POST', '/git/commits', c));
    },

    async updateHead(sha) {
      const r = await call('PATCH', '/git/refs/' + branchRef, { sha, force: false });
      if (r.status === 200) return 'ok';
      if (r.status === 422 || r.status === 409) return 'not_fast_forward';
      fail(r.status, r.json);
    },

    async history(path, perPage) {
      const r = await call(
        'GET',
        '/commits?path=' +
          encodeURIComponent(path) +
          '&sha=' +
          encodeURIComponent(o.branch) +
          '&per_page=' +
          String(perPage),
      );
      if (r.status !== 200) fail(r.status, r.json);
      if (!Array.isArray(r.json)) throw new GitHubError(502, 'histórico inesperado');
      return r.json.filter(isRecord).map((x) => {
        const c = isRecord(x.commit) ? x.commit : {};
        const a = isRecord(c.author) ? c.author : {};
        const cm = isRecord(c.committer) ? c.committer : {};
        const login = isRecord(x.author) && typeof x.author.login === 'string' ? x.author.login : '';
        const date = typeof a.date === 'string' ? a.date : typeof cm.date === 'string' ? cm.date : null;
        return {
          commit: typeof x.sha === 'string' ? x.sha : '',
          date,
          author: typeof a.name === 'string' ? a.name : login,
          message: (typeof c.message === 'string' ? c.message : '').slice(0, 500),
        };
      });
    },
  };
}
