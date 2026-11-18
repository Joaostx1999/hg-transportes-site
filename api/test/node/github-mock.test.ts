/* Mock do GitHub para dev (dev/github-mock.mjs) sobre git real + o pipeline REAL de publicação do Worker
 * (src/publish.ts + src/github.ts) rodando contra ele. Tudo em pasta temporária; nada toca o repo real. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createMock, initRepo } from '../../dev/github-mock.mjs';
import { createGitHub, type GitApi } from '../../src/github.ts';
import { loadContent, publish, restore, type PublishContext } from '../../src/publish.ts';
import { HttpError } from '../../src/http.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const REAL_INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

let tmp: string;
let repoDir: string;
let base: string;
let server: ReturnType<typeof createMock>['server'];
let api: string;
const H = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repoDir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
    .toString('utf8')
    .trim();
const call = async (
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const init: RequestInit = { method, headers: H };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(api + '/repos/Joaostx1999/hg-transportes-site' + p, init);
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const gh = (): GitApi =>
  createGitHub({
    apiBase: api,
    owner: 'Joaostx1999',
    repo: 'hg-transportes-site',
    branch: 'main',
    token: 'dev-token',
    fetch: (u, i) => fetch(u, i),
  });
const ctx = (username = 'ana'): PublishContext => ({
  git: gh(),
  username,
  page: 'index.html',
  schemaPath: 'cms/schema.json',
  maxImageBytes: 3 * 1024 * 1024,
  now: () => Date.parse('2026-11-17T12:00:00Z'),
});

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-mock-'));
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, 'cms'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(src, 'index.html'));
  fs.copyFileSync(path.join(ROOT, 'cms', 'schema.json'), path.join(src, 'cms', 'schema.json'));
  fs.cpSync(path.join(ROOT, 'assets'), path.join(src, 'assets'), { recursive: true });
  repoDir = path.join(tmp, 'repo');
  expect(initRepo({ repoDir, sourceDir: src })).toBe('criado');
  fs.symlinkSync('../src', path.join(repoDir, 'admin')); // como o start-dev faz com ../../admin
  const mock = createMock({ repoDir, tokenExpiration: '2027-01-31 23:59:59 UTC' });
  server = mock.server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  api = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port);
  base = git('rev-parse', 'HEAD');
});

afterAll(async () => {
  await new Promise<void>((r) => {
    server.close(() => {
      r();
    });
  });
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('mock do GitHub (git real)', () => {
  test('exige Bearer dev-token e envia o cabeçalho de validade do token', async () => {
    const r = await fetch(api + '/repos/Joaostx1999/hg-transportes-site/git/ref/heads/main');
    expect(r.status).toBe(401);
    const ok = await fetch(api + '/repos/Joaostx1999/hg-transportes-site/git/ref/heads/main', { headers: H });
    expect(ok.headers.get('github-authentication-token-expiration')).toBe('2027-01-31 23:59:59 UTC');
    expect(((await ok.json()) as { object: { sha: string } }).object.sha).toBe(base);
  });

  test('repo inicial: index.html, assets e schema versionados; symlink admin fora do git', () => {
    const files = git('ls-files').split('\n');
    expect(files).toContain('index.html');
    expect(files).toContain('cms/schema.json');
    expect(files.some((f) => f.startsWith('assets/fotos/'))).toBe(true);
    expect(files.some((f) => f.startsWith('admin'))).toBe(false);
    expect(git('status', '--porcelain')).toBe('');
  });

  test('contents, commits, trees e blobs no formato do GitHub', async () => {
    const c = await call('GET', '/contents/index.html?ref=' + base);
    expect(c.status).toBe(200);
    expect(Buffer.from(String(c.json.content), 'base64').toString('utf8')).toBe(REAL_INDEX);
    expect(String(c.json.content).split('\n')[0]).toHaveLength(60);
    expect((await call('GET', '/contents/nao-existe.html')).status).toBe(404);
    expect((await call('GET', '/contents/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
    const cm = await call('GET', '/git/commits/' + base);
    expect(cm.json).toMatchObject({ sha: base, parents: [], message: 'Estado inicial (mock local)' });
    const tree = await call('GET', '/git/trees/' + (cm.json.tree as { sha: string }).sha + '?recursive=1');
    expect((tree.json.tree as { path: string }[]).some((e) => e.path === 'cms/schema.json')).toBe(true);
    const blob = await call('POST', '/git/blobs', { content: 'olá', encoding: 'utf-8' });
    expect(blob.status).toBe(201);
    const back = await call('GET', '/git/blobs/' + String(blob.json.sha));
    expect(Buffer.from(String(back.json.content), 'base64').toString('utf8')).toBe('olá');
  });

  test('POST trees recusa caminho perigoso; PATCH sem fast-forward dá 422', async () => {
    const blob = await call('POST', '/git/blobs', { content: 'eA==', encoding: 'base64' });
    const t = (await call('GET', '/git/commits/' + base)).json.tree as { sha: string };
    for (const p of ['../fora.txt', '/abs', '.git/config', 'a//b']) {
      const r = await call('POST', '/git/trees', {
        base_tree: t.sha,
        tree: [{ path: p, mode: '100644', type: 'blob', sha: blob.json.sha }],
      });
      expect(r.status, p).toBe(422);
    }
    const orphan = await call('POST', '/git/commits', { message: 'órfão', tree: t.sha, parents: [] });
    const r = await call('PATCH', '/git/refs/heads/main', { sha: orphan.json.sha, force: false });
    expect(r.status).toBe(422);
    expect(r.json.message).toMatch(/fast forward/);
    expect(git('rev-parse', 'HEAD')).toBe(base);
    expect(fs.existsSync(path.join(tmp, 'fora.txt'))).toBe(false);
  });
});

describe('pipeline real do Worker contra o mock git', () => {
  test('publish com foto: UM commit com a foto e o index.html; autor do painel; working tree atualizado', async () => {
    const before = git('rev-parse', 'HEAD');
    const r = await publish(ctx(), {
      base: before,
      changes: { 'topo.botao': 'Cotação já' },
      images: { 'cta.foto': { type: 'image/jpeg', ext: 'jpg', bytes: new Uint8Array(JPG) } },
    });
    const photo = r.paths['cta.foto'] ?? '';
    expect(git('rev-parse', 'HEAD')).toBe(r.commit);
    expect(git('rev-list', '--count', before + '..HEAD')).toBe('1');
    expect(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(
      [photo, 'index.html'].sort(),
    );
    expect(git('log', '-1', '--format=%an <%ae>|%cn <%ce>')).toBe(
      'ana (painel) <ana@painel.hgtransportes.invalid>|ana (painel) <ana@painel.hgtransportes.invalid>',
    );
    expect(git('log', '-1', '--format=%B')).toBe(
      'Painel: ana alterou 2 campo(s)\n\n- topo.botao: Botão principal\n- cta.foto: Foto',
    );
    // checkout: o arquivo no disco (servido pela 8781) já é a versão nova
    expect(fs.readFileSync(path.join(repoDir, 'index.html'), 'utf8')).toContain('>Cotação já</span>');
    expect(fs.readFileSync(path.join(repoDir, photo))).toEqual(JPG);
    expect(git('status', '--porcelain')).toBe('');
    expect(fs.lstatSync(path.join(repoDir, 'admin')).isSymbolicLink()).toBe(true);
  });

  test('conflito por campo e rebase passando pelo git real', async () => {
    const stale = git('rev-parse', 'HEAD');
    await publish(ctx('bia'), { base: stale, changes: { 'topo.selo1': 'Seguro X' }, images: {} });
    const rebased = await publish(ctx(), {
      base: stale,
      changes: { 'topo.selo2': 'Brasil todo' },
      images: {},
    });
    expect(rebased.rebased).toBe(true);
    const html = fs.readFileSync(path.join(repoDir, 'index.html'), 'utf8');
    expect(html).toContain('>Seguro X</span>');
    expect(html).toContain('>Brasil todo</span>');
    const err = await publish(ctx(), { base: stale, changes: { 'topo.selo1': 'Meu' }, images: {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('conflict');
    expect(Object.keys((err as HttpError).fields ?? {})).toEqual(['topo.selo1']);
  });

  test('history e restore pelo mesmo pipeline', async () => {
    const versions = await gh().history('index.html', 30);
    expect(versions.at(-1)?.message).toBe('Estado inicial (mock local)');
    expect(versions[0]?.author).toBe('ana (painel)');
    const { commit: head } = await loadContent(ctx());
    const r = await restore(ctx(), base, head);
    expect(git('rev-parse', 'HEAD')).toBe(r.commit);
    expect(fs.readFileSync(path.join(repoDir, 'index.html'), 'utf8')).toBe(REAL_INDEX);
    expect(git('show', '--name-only', '--format=', 'HEAD')).toBe('index.html');
  });

  test('S1: restore de commit fora do branch (refs/pull/N/head) é 404 também no mock git real', async () => {
    const head = git('rev-parse', 'HEAD');
    const idx = path.join(tmp, 'idx-pr');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_INDEX_FILE: idx };
    const run = (args: string[], input?: string): string =>
      execFileSync('git', ['-C', repoDir, ...args], { env, input })
        .toString('utf8')
        .trim();
    run(['read-tree', 'HEAD']);
    const blob = run(['hash-object', '-w', '--stdin'], REAL_INDEX.replace('<title>', '<title>PR '));
    run(['update-index', '--cacheinfo', '100644,' + blob + ',index.html']);
    const tree = run(['write-tree']);
    const pr = run([
      '-c',
      'user.name=x',
      '-c',
      'user.email=x@x',
      'commit-tree',
      tree,
      '-p',
      head,
      '-m',
      'PR',
    ]);
    run(['update-ref', 'refs/pull/1/head', pr]);
    fs.rmSync(idx, { force: true });
    expect((await gh().history('index.html', 100)).some((v) => v.commit === pr)).toBe(false);
    const err = await restore(ctx(), pr, head).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('not_found');
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });
});

describe('initRepo', () => {
  test('não recria repo existente; --reset recria; recusa conter o site real', () => {
    const src = path.join(tmp, 'src');
    expect(initRepo({ repoDir, sourceDir: src })).toBe('existente');
    const other = path.join(tmp, 'outro');
    expect(initRepo({ repoDir: other, sourceDir: src })).toBe('criado');
    fs.writeFileSync(path.join(other, 'lixo.txt'), 'x');
    expect(initRepo({ repoDir: other, sourceDir: src, reset: true })).toBe('criado');
    expect(fs.existsSync(path.join(other, 'lixo.txt'))).toBe(false);
    expect(() => initRepo({ repoDir: tmp, sourceDir: src })).toThrow(/recuso/);
  });
});
