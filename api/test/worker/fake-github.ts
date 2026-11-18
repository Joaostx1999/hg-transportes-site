/* GitHub falso em memória para os testes no runtime do Workers: subconjunto da Git Data API + contents +
 * commits, com os mesmos formatos de resposta do GitHub. Permite simular outra pessoa publicando no meio
 * (hooks), falhas e o cabeçalho de validade do token. */
import { b64ToBytes, bytesToB64, toHex, utf8 } from '../../src/util.ts';

interface Commit {
  tree: string;
  parents: string[];
  message: string;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
}

export interface Call {
  method: string;
  path: string;
}

type Hook = (gh: FakeGitHub) => Promise<void> | void;

async function sha1(s: string | Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-1', typeof s === 'string' ? utf8(s) : s));
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export class FakeGitHub {
  readonly owner = 'Joaostx1999';
  readonly repo = 'hg-transportes-site';
  readonly branch = 'main';
  token = 'dev-token';
  tokenExpiration: string | null = '2027-01-15 12:00:00 UTC';
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, Map<string, string>>();
  commits = new Map<string, Commit>();
  head = '';
  calls: Call[] = [];
  /** roda antes do PATCH do ref (ex.: outra pessoa publica no meio) */
  beforePatch: Hook | null = null;
  /** devolve este status em qualquer pedido cujo "MÉTODO caminho" casar */
  failWhen: { re: RegExp; status: number } | null = null;
  down = false;

  static async create(files: Record<string, string | Uint8Array>): Promise<FakeGitHub> {
    const gh = new FakeGitHub();
    gh.head = await gh.commitFiles(files, 'Estado inicial', null, true);
    return gh;
  }

  async putBlob(bytes: Uint8Array): Promise<string> {
    const sha = await sha1(new Uint8Array([...utf8('blob ' + bytes.length + '\0'), ...bytes]));
    this.blobs.set(sha, bytes);
    return sha;
  }

  async putTree(entries: Map<string, string>): Promise<string> {
    const sorted = [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const sha = await sha1('tree ' + JSON.stringify(sorted));
    this.trees.set(sha, new Map(sorted));
    return sha;
  }

  async putCommit(c: Commit): Promise<string> {
    const sha = await sha1('commit ' + JSON.stringify(c) + Math.random());
    this.commits.set(sha, c);
    return sha;
  }

  /** Commit direto no branch (simula outra pessoa ou o estado inicial). Devolve o sha. */
  async commitFiles(
    files: Record<string, string | Uint8Array>,
    message: string,
    parent: string | null = this.head,
    replaceAll = false,
  ): Promise<string> {
    const base = parent && !replaceAll ? this.treeOf(parent) : new Map<string, string>();
    const entries = new Map(base);
    for (const [p, v] of Object.entries(files))
      entries.set(p, await this.putBlob(typeof v === 'string' ? utf8(v) : v));
    const who = { name: 'outra pessoa', email: 'x@y.invalid', date: new Date().toISOString() };
    const sha = await this.putCommit({
      tree: await this.putTree(entries),
      parents: parent ? [parent] : [],
      message,
      author: who,
      committer: who,
    });
    this.head = sha;
    return sha;
  }

  /** Commit que NÃO entra no branch (ex.: refs/pull/N/head de um PR não mesclado). Devolve o sha. */
  async commitDetached(files: Record<string, string | Uint8Array>, message: string): Promise<string> {
    const head = this.head;
    const sha = await this.commitFiles(files, message, head);
    this.head = head;
    return sha;
  }

  treeOf(commit: string): Map<string, string> {
    const c = this.commits.get(commit);
    const t = c ? this.trees.get(c.tree) : undefined;
    if (!t) throw new Error('commit/tree inexistente ' + commit);
    return t;
  }

  file(path: string, ref = this.head): Uint8Array | null {
    const sha = this.treeOf(ref).get(path);
    return sha ? (this.blobs.get(sha) ?? null) : null;
  }

  text(path: string, ref = this.head): string {
    const b = this.file(path, ref);
    if (!b) throw new Error('arquivo inexistente ' + path);
    return new TextDecoder().decode(b);
  }

  commit(sha = this.head): Commit {
    const c = this.commits.get(sha);
    if (!c) throw new Error('commit inexistente');
    return c;
  }

  /** Arquivos que mudaram entre o commit e o pai. */
  changedFiles(sha = this.head): string[] {
    const c = this.commit(sha);
    const now = this.treeOf(sha);
    const before = c.parents[0] ? this.treeOf(c.parents[0]) : new Map<string, string>();
    const all = new Set([...now.keys(), ...before.keys()]);
    return [...all].filter((p) => now.get(p) !== before.get(p)).sort();
  }

  private isAncestor(anc: string, of: string): boolean {
    const seen = new Set<string>();
    const stack = [of];
    while (stack.length) {
      const s = stack.pop() ?? '';
      if (s === anc) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...(this.commits.get(s)?.parents ?? []));
    }
    return false;
  }

  /** Implementação de fetch para injetar no Worker. */
  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const prefix = '/repos/' + this.owner + '/' + this.repo;
    this.calls.push({ method, path: url.pathname + url.search });
    if (this.down) throw new TypeError('network down');
    const hdr: Record<string, string> = this.tokenExpiration
      ? { 'github-authentication-token-expiration': this.tokenExpiration }
      : {};
    const auth = new Headers(init?.headers).get('Authorization');
    if (auth !== 'Bearer ' + this.token) return json(401, { message: 'Bad credentials' });
    if (this.failWhen?.re.test(method + ' ' + url.pathname))
      return json(this.failWhen.status, { message: 'falha simulada' }, hdr);
    if (!url.pathname.startsWith(prefix + '/')) return json(404, { message: 'Not Found' }, hdr);
    const p = url.pathname.slice(prefix.length);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    let m: RegExpExecArray | null;

    if (method === 'GET' && p === '/git/ref/heads/' + this.branch) {
      return json(200, { ref: 'refs/heads/' + this.branch, object: { sha: this.head, type: 'commit' } }, hdr);
    }
    if (method === 'PATCH' && p === '/git/refs/heads/' + this.branch) {
      if (this.beforePatch) {
        const h = this.beforePatch;
        this.beforePatch = null;
        await h(this);
      }
      const sha = String(body.sha);
      if (!this.commits.has(sha)) return json(422, { message: 'Object does not exist' }, hdr);
      if (body.force !== false && body.force !== undefined)
        return json(400, { message: 'só force:false' }, hdr);
      if (!this.isAncestor(this.head, sha))
        return json(422, { message: 'Update is not a fast forward' }, hdr);
      this.head = sha;
      return json(200, { ref: 'refs/heads/' + this.branch, object: { sha, type: 'commit' } }, hdr);
    }
    if (method === 'GET' && (m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(p))) {
      const sha = m[1] ?? '';
      const c = this.commits.get(sha);
      if (!c) return json(404, { message: 'Not Found' }, hdr);
      return json(
        200,
        {
          sha,
          tree: { sha: c.tree },
          parents: c.parents.map((s) => ({ sha: s })),
          message: c.message,
          author: c.author,
          committer: c.committer,
        },
        hdr,
      );
    }
    if (method === 'GET' && (m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(p))) {
      const b = this.blobs.get(m[1] ?? '');
      if (!b) return json(404, { message: 'Not Found' }, hdr);
      return json(200, { sha: m[1], size: b.length, encoding: 'base64', content: bytesToB64(b) }, hdr);
    }
    if (method === 'POST' && p === '/git/blobs') {
      if (body.encoding !== 'base64' || typeof body.content !== 'string')
        return json(422, { message: 'Invalid' }, hdr);
      return json(201, { sha: await this.putBlob(b64ToBytes(body.content)) }, hdr);
    }
    if (method === 'POST' && p === '/git/trees') {
      const baseSha = String(body.base_tree);
      const base = this.trees.get(baseSha);
      if (!base) return json(422, { message: 'base_tree inválida' }, hdr);
      const entries = new Map(base);
      for (const e of body.tree as { path: string; sha: string; mode: string; type: string }[]) {
        if (e.mode !== '100644' || e.type !== 'blob' || !this.blobs.has(e.sha))
          return json(422, { message: 'entrada inválida' }, hdr);
        if (e.path.split('/').some((s) => !s || s === '..' || s === '.'))
          return json(422, { message: 'path inválido' }, hdr);
        entries.set(e.path, e.sha);
      }
      return json(201, { sha: await this.putTree(entries) }, hdr);
    }
    if (method === 'POST' && p === '/git/commits') {
      const parents = body.parents as string[];
      if (!this.trees.has(String(body.tree)) || !parents.every((x) => this.commits.has(x)))
        return json(422, { message: 'inválido' }, hdr);
      const sha = await this.putCommit({
        tree: String(body.tree),
        parents,
        message: String(body.message),
        author: body.author as Commit['author'],
        committer: body.committer as Commit['committer'],
      });
      return json(201, { sha }, hdr);
    }
    if (method === 'GET' && (m = /^\/contents\/(.+)$/.exec(p))) {
      const path = decodeURIComponent(m[1] ?? '');
      const ref = url.searchParams.get('ref') ?? this.branch;
      const commit = ref === this.branch ? this.head : ref;
      if (!this.commits.has(commit)) return json(404, { message: 'No commit found for the ref' }, hdr);
      const sha = this.treeOf(commit).get(path);
      const b = sha ? this.blobs.get(sha) : undefined;
      if (!sha || !b) return json(404, { message: 'Not Found' }, hdr);
      const content = bytesToB64(b).replace(/(.{60})/g, '$1\n');
      return json(200, { type: 'file', path, sha, size: b.length, encoding: 'base64', content }, hdr);
    }
    if (method === 'GET' && p === '/commits') {
      const path = url.searchParams.get('path') ?? '';
      const per = Number(url.searchParams.get('per_page') ?? '30');
      const out: unknown[] = [];
      let cur: string | undefined = this.head;
      while (cur && out.length < per) {
        const c = this.commit(cur);
        const parent = c.parents[0];
        const touched =
          !path || this.treeOf(cur).get(path) !== (parent ? this.treeOf(parent).get(path) : undefined);
        if (touched)
          out.push({
            sha: cur,
            commit: { message: c.message, author: c.author, committer: c.committer },
            author: null,
          });
        cur = parent;
      }
      return json(200, out, hdr);
    }
    return json(404, { message: 'Not Found' }, hdr);
  };
}
