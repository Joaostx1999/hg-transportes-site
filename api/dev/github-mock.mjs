#!/usr/bin/env node
/* GitHub falso para desenvolvimento local, sobre um repositório git REAL em api/.dev-repo (nunca o repo real).
 * Usa a CLI do git (execFileSync, sem shell). Sem dependências. Subconjunto exato usado pelo Worker:
 *   GET   /repos/:o/:r/git/ref/heads/:b
 *   PATCH /repos/:o/:r/git/refs/heads/:b      {sha, force}  (422 se não for fast-forward)
 *   GET   /repos/:o/:r/git/commits/:sha       POST /repos/:o/:r/git/commits {message, tree, parents, author, committer}
 *   GET   /repos/:o/:r/git/trees/:sha[?recursive=1]   POST /repos/:o/:r/git/trees {base_tree, tree:[{path, mode, type, sha}]}
 *   GET   /repos/:o/:r/git/blobs/:sha         POST /repos/:o/:r/git/blobs {content, encoding}
 *   GET   /repos/:o/:r/contents/:path?ref=
 *   GET   /repos/:o/:r/commits?path=&sha=&per_page=
 * Depois de um PATCH no ref faz `git reset --hard` para o http.server da 8781 servir a versão nova.
 * Exige Authorization: Bearer <token> e envia github-authentication-token-expiration.
 *
 * Uso: node dev/github-mock.mjs [--init-only] [--reset]
 * Variáveis: HG_MOCK_PORT (8788), HG_MOCK_REPO (api/.dev-repo), HG_MOCK_SOURCE (raiz do site),
 *            HG_MOCK_TOKEN (dev-token), MOCK_TOKEN_EXPIRES_AT ("2027-01-31 23:59:59 UTC"; "none" omite). */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_BODY = 30 * 1024 * 1024;

class MockError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** git isolado da configuração do usuário (sem hooks, sem assinatura, sem config global). */
function gitRunner(repoDir) {
  const baseEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
  };
  return function git(args, opts = {}) {
    return execFileSync(
      'git',
      ['-C', repoDir, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
      {
        input: opts.input,
        env: { ...baseEnv, ...(opts.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  };
}

function defaultExpiration() {
  const d = new Date(Date.now() + 90 * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
}

/** Prepara o repositório de dev: cópia de index.html, assets/ e cms/schema.json + commit inicial. */
export function initRepo({ repoDir, sourceDir, reset = false, log = () => {} }) {
  const repo = path.resolve(repoDir);
  const src = path.resolve(sourceDir);
  if (repo === src || src.startsWith(repo + path.sep))
    throw new Error('recuso: o repo do mock não pode conter o site real');
  if (reset && fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
  if (fs.existsSync(path.join(repo, '.git'))) return 'existente';
  if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true }); // formato antigo (sem git)
  fs.mkdirSync(repo, { recursive: true });
  fs.copyFileSync(path.join(src, 'index.html'), path.join(repo, 'index.html'));
  if (fs.existsSync(path.join(src, 'assets')))
    fs.cpSync(path.join(src, 'assets'), path.join(repo, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'cms'), { recursive: true });
  fs.copyFileSync(path.join(src, 'cms', 'schema.json'), path.join(repo, 'cms', 'schema.json'));
  const git = gitRunner(repo);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'mock']);
  git(['config', 'user.email', 'mock@localhost']);
  // o symlink admin -> ../../admin (criado pelo start-dev) nunca entra no repo do mock
  fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '/admin\n');
  git(['add', '--', 'index.html', 'assets', 'cms']);
  git(['commit', '-q', '-m', 'Estado inicial (mock local)']);
  log('repo de dev criado em ' + repo);
  return 'criado';
}

function safeRepoPath(p) {
  if (
    typeof p !== 'string' ||
    !p ||
    p.length > 300 ||
    p.startsWith('/') ||
    p.includes('\\') ||
    p.includes('\0')
  )
    return null;
  const segs = p.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..' || s.toLowerCase() === '.git')) return null;
  return segs.join('/');
}

function parsePerson(line) {
  const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!m) return { name: '', email: '', date: null };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
}

export function createMock(opts = {}) {
  const repoDir = path.resolve(
    opts.repoDir ?? process.env.HG_MOCK_REPO ?? path.join(HERE, '..', '.dev-repo'),
  );
  const owner = opts.owner ?? 'Joaostx1999';
  const repoName = opts.repo ?? 'hg-transportes-site';
  const branch = opts.branch ?? 'main';
  const token = opts.token ?? process.env.HG_MOCK_TOKEN ?? 'dev-token';
  const expiration = opts.tokenExpiration ?? process.env.MOCK_TOKEN_EXPIRES_AT ?? defaultExpiration();
  const log = opts.log ?? (() => {});
  const git = gitRunner(repoDir);
  const out = (args, o) => git(args, o).toString('utf8').trim();

  function objectType(sha) {
    if (!SHA_RE.test(sha)) return null;
    try {
      return out(['cat-file', '-t', sha]);
    } catch {
      return null;
    }
  }
  function headSha() {
    return out(['rev-parse', '--verify', 'refs/heads/' + branch]);
  }
  function resolveCommit(ref) {
    if (ref !== branch && !SHA_RE.test(ref)) return null;
    try {
      return out([
        'rev-parse',
        '--verify',
        '--quiet',
        (ref === branch ? 'refs/heads/' + branch : ref) + '^{commit}',
      ]);
    } catch {
      return null;
    }
  }
  function readCommit(sha) {
    const raw = out(['cat-file', 'commit', sha]);
    const idx = raw.indexOf('\n\n');
    const headers = (idx < 0 ? raw : raw.slice(0, idx)).split('\n');
    const message = idx < 0 ? '' : raw.slice(idx + 2);
    const c = { sha, tree: null, parents: [], message, author: null, committer: null };
    for (const h of headers) {
      const sp = h.indexOf(' ');
      const k = h.slice(0, sp);
      const v = h.slice(sp + 1);
      if (k === 'tree') c.tree = { sha: v };
      else if (k === 'parent') c.parents.push({ sha: v });
      else if (k === 'author') c.author = parsePerson(v);
      else if (k === 'committer') c.committer = parsePerson(v);
    }
    return c;
  }

  const handlers = [
    [
      'GET',
      /^\/git\/ref\/heads\/(.+)$/,
      (m) => {
        if (decodeURIComponent(m[1]) !== branch) throw new MockError(404, 'Not Found');
        return [200, { ref: 'refs/heads/' + branch, object: { sha: headSha(), type: 'commit' } }];
      },
    ],
    [
      'PATCH',
      /^\/git\/refs\/heads\/(.+)$/,
      (m, body) => {
        if (decodeURIComponent(m[1]) !== branch) throw new MockError(422, 'Reference does not exist');
        const sha = String(body.sha ?? '');
        if (objectType(sha) !== 'commit') throw new MockError(422, 'Object does not exist');
        const cur = headSha();
        if (body.force !== true) {
          try {
            git(['merge-base', '--is-ancestor', cur, sha]);
          } catch {
            throw new MockError(422, 'Update is not a fast forward');
          }
        }
        git(['update-ref', 'refs/heads/' + branch, sha, cur]);
        git(['reset', '-q', '--hard']); // o http.server da 8781 passa a servir a versão nova
        log('ref ' + branch + ' -> ' + sha.slice(0, 7) + ': ' + readCommit(sha).message.split('\n')[0]);
        return [200, { ref: 'refs/heads/' + branch, object: { sha, type: 'commit' } }];
      },
    ],
    [
      'GET',
      /^\/git\/commits\/([0-9a-f]{40})$/,
      (m) => {
        if (objectType(m[1]) !== 'commit') throw new MockError(404, 'Not Found');
        return [200, readCommit(m[1])];
      },
    ],
    [
      'POST',
      /^\/git\/commits$/,
      (_m, body) => {
        const tree = String(body.tree ?? '');
        const parents = Array.isArray(body.parents) ? body.parents.map(String) : [];
        if (typeof body.message !== 'string' || objectType(tree) !== 'tree')
          throw new MockError(422, 'Invalid request');
        if (parents.some((p) => objectType(p) !== 'commit')) throw new MockError(422, 'Invalid parent');
        const who = (p, k) => (p && typeof p[k] === 'string' ? p[k] : '');
        const a = body.author ?? {};
        const c = body.committer ?? a;
        const env = {
          GIT_AUTHOR_NAME: who(a, 'name') || 'mock',
          GIT_AUTHOR_EMAIL: who(a, 'email') || 'mock@localhost',
          GIT_COMMITTER_NAME: who(c, 'name') || 'mock',
          GIT_COMMITTER_EMAIL: who(c, 'email') || 'mock@localhost',
        };
        if (who(a, 'date')) env.GIT_AUTHOR_DATE = who(a, 'date');
        if (who(c, 'date')) env.GIT_COMMITTER_DATE = who(c, 'date');
        const args = ['commit-tree', tree];
        for (const p of parents) args.push('-p', p);
        args.push('-F', '-');
        const sha = out(args, { input: body.message, env });
        return [201, readCommit(sha)];
      },
    ],
    [
      'GET',
      /^\/git\/trees\/([0-9a-f]{40})$/,
      (m, _b, url) => {
        if (objectType(m[1]) !== 'tree') throw new MockError(404, 'Not Found');
        const rec = url.searchParams.get('recursive');
        const lines = out(['ls-tree', '-l', ...(rec && rec !== '0' ? ['-r', '-t'] : []), m[1]])
          .split('\n')
          .filter(Boolean);
        const tree = lines.map((l) => {
          const [meta, p] = l.split('\t');
          const [mode, type, sha, size] = meta.split(/\s+/);
          return { path: p, mode, type, sha, ...(type === 'blob' ? { size: Number(size) } : {}) };
        });
        return [200, { sha: m[1], tree, truncated: false }];
      },
    ],
    [
      'POST',
      /^\/git\/trees$/,
      (_m, body) => {
        if (!Array.isArray(body.tree)) throw new MockError(422, 'Invalid tree');
        const indexFile = path.join(repoDir, '.git', 'mock-index-' + crypto.randomBytes(6).toString('hex'));
        const env = { GIT_INDEX_FILE: indexFile };
        try {
          if (body.base_tree) {
            if (objectType(String(body.base_tree)) !== 'tree') throw new MockError(422, 'base_tree inválida');
            git(['read-tree', String(body.base_tree)], { env });
          } else git(['read-tree', '--empty'], { env });
          for (const e of body.tree) {
            const p = safeRepoPath(e && e.path);
            if (!p) throw new MockError(422, 'path inválido');
            if (e.sha === null) {
              git(['update-index', '--force-remove', '--', p], { env });
              continue;
            }
            if (!['100644', '100755'].includes(e.mode) || e.type !== 'blob')
              throw new MockError(422, 'só blobs');
            if (objectType(String(e.sha)) !== 'blob') throw new MockError(422, 'blob inexistente');
            git(['update-index', '--add', '--cacheinfo', e.mode + ',' + e.sha + ',' + p], { env });
          }
          return [201, { sha: out(['write-tree'], { env }), truncated: false }];
        } finally {
          fs.rmSync(indexFile, { force: true });
        }
      },
    ],
    [
      'GET',
      /^\/git\/blobs\/([0-9a-f]{40})$/,
      (m) => {
        if (objectType(m[1]) !== 'blob') throw new MockError(404, 'Not Found');
        const buf = git(['cat-file', 'blob', m[1]]);
        return [200, { sha: m[1], size: buf.length, encoding: 'base64', content: buf.toString('base64') }];
      },
    ],
    [
      'POST',
      /^\/git\/blobs$/,
      (_m, body) => {
        if (typeof body.content !== 'string') throw new MockError(422, 'Invalid content');
        const buf =
          body.encoding === 'base64'
            ? Buffer.from(body.content, 'base64')
            : Buffer.from(body.content, 'utf8');
        return [201, { sha: out(['hash-object', '-w', '--stdin'], { input: buf }) }];
      },
    ],
    [
      'GET',
      /^\/contents\/(.+)$/,
      (m, _b, url) => {
        const p = safeRepoPath(decodeURIComponent(m[1]));
        const commit = resolveCommit(url.searchParams.get('ref') ?? branch);
        if (!p || !commit) throw new MockError(404, 'Not Found');
        let sha;
        try {
          sha = out(['rev-parse', '--verify', '--quiet', commit + ':' + p]);
        } catch {
          throw new MockError(404, 'Not Found');
        }
        if (objectType(sha) !== 'blob') throw new MockError(404, 'Not Found');
        const buf = git(['cat-file', 'blob', sha]);
        const content = buf.toString('base64').replace(/(.{60})/g, '$1\n');
        return [
          200,
          {
            type: 'file',
            name: path.posix.basename(p),
            path: p,
            sha,
            size: buf.length,
            encoding: 'base64',
            content,
          },
        ];
      },
    ],
    [
      'GET',
      /^\/commits$/,
      (_m, _b, url) => {
        const commit = resolveCommit(url.searchParams.get('sha') ?? branch);
        if (!commit) throw new MockError(404, 'No commit found');
        const per = Math.min(100, Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30);
        const p = url.searchParams.get('path');
        const args = [
          'log',
          '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%B%x1e',
          '-n',
          String(per),
          commit,
        ];
        if (p) {
          const sp = safeRepoPath(p);
          if (!sp) return [200, []];
          args.push('--', sp);
        }
        const list = git(args)
          .toString('utf8')
          .split('\x1e')
          .map((s) => s.replace(/^\n/, ''))
          .filter(Boolean)
          .map((rec) => {
            const [sha, an, ae, ad, cn, ce, cd, msg] = rec.split('\x1f');
            return {
              sha,
              commit: {
                message: msg.replace(/\n$/, ''),
                author: { name: an, email: ae, date: ad },
                committer: { name: cn, email: ce, date: cd },
              },
              author: null,
            };
          });
        return [200, list];
      },
    ],
  ];

  function send(res, status, body) {
    const s = JSON.stringify(body);
    const h = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) };
    if (expiration !== 'none') h['github-authentication-token-expiration'] = expiration;
    res.writeHead(status, h);
    res.end(s);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const parts = [];
      let n = 0;
      req.on('data', (d) => {
        n += d.length;
        if (n > MAX_BODY) {
          reject(new MockError(413, 'too large'));
          req.destroy();
        } else parts.push(d);
      });
      req.on('end', () => resolve(Buffer.concat(parts)));
      req.on('error', reject);
    });
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://mock');
    if ((req.headers.authorization ?? '') !== 'Bearer ' + token)
      return send(res, 401, { message: 'Bad credentials' });
    const prefix = '/repos/' + owner + '/' + repoName;
    if (!url.pathname.startsWith(prefix + '/')) return send(res, 404, { message: 'Not Found' });
    const rest = url.pathname.slice(prefix.length);
    let body = {};
    if (req.method === 'POST' || req.method === 'PATCH') {
      try {
        body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      } catch (e) {
        return send(res, e instanceof MockError ? e.status : 400, { message: 'Problems parsing JSON' });
      }
    }
    for (const [method, re, fn] of handlers) {
      const m = re.exec(rest);
      if (!m || method !== req.method) continue;
      try {
        const [status, payload] = fn(m, body, url);
        return send(res, status, payload);
      } catch (e) {
        if (e instanceof MockError) return send(res, e.status, { message: e.message });
        log('erro: ' + (e && e.message ? e.message.split('\n')[0] : String(e)));
        return send(res, 500, { message: 'mock error' });
      }
    }
    return send(res, 404, { message: 'Not Found' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { message: 'mock error' });
    });
  });
  return { server, repoDir, head: headSha, readCommit };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const repoDir = process.env.HG_MOCK_REPO ?? path.join(HERE, '..', '.dev-repo');
  const sourceDir = process.env.HG_MOCK_SOURCE ?? path.join(HERE, '..', '..');
  const log = (s) => console.log('[mock] ' + s);
  const state = initRepo({ repoDir, sourceDir, reset: args.includes('--reset'), log });
  log('repo de dev ' + state + ': ' + path.resolve(repoDir));
  if (!args.includes('--init-only')) {
    const port = Number.parseInt(process.env.HG_MOCK_PORT ?? '8788', 10);
    const mock = createMock({ repoDir, log });
    mock.server.listen(port, '127.0.0.1', () => log('GitHub falso em http://127.0.0.1:' + port));
  }
}
