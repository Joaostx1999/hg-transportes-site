/* Scripts de esquema (mesmo código do Worker) e o workflow de CI. */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { cspOf, devIndex, DEV_CONNECT, PROD_SCRIPT_SRC } from '../../dev/build-admin-dev.mjs';

const API = path.resolve(import.meta.dirname, '..', '..');
const ROOT = path.resolve(API, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'cms', 'schema.json'), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-scripts-'));
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(script: string, ...args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [path.join(API, 'scripts', script), ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
function withIndex(name: string, html: string, schema = SCHEMA): string[] {
  const i = path.join(tmp, name + '.html');
  const s = path.join(tmp, name + '.json');
  fs.writeFileSync(i, html);
  fs.writeFileSync(s, schema);
  return ['--index', i, '--schema', s];
}

describe('validar-marcadores', () => {
  test('site real: sai 0', () => {
    const r = run('validar-marcadores.mjs');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('OK: 98 marcadores');
  });

  test.each([
    ['faltando', INDEX.replace(' data-cms="topo.botao"', ''), /topo\.botao: Marcador faltando/],
    [
      'duplicado',
      INDEX.replace('<span data-cms="topo.botao"', '<span data-cms="topo.selo1"'),
      /topo\.selo1: Marcador duplicado/,
    ],
    [
      'tipo',
      INDEX.replace(
        'data-cms="numeros.n1" data-cms-type="number"',
        'data-cms="numeros.n1" data-cms-type="text"',
      ),
      /numeros\.n1: Tipo diferente/,
    ],
    [
      'novo',
      INDEX.replace('</footer>', '<p data-cms="x.novo">x</p></footer>'),
      /x\.novo: Marcador no HTML que não está no esquema/,
    ],
  ])('erro (%s): sai 1 com a chave e o motivo', (name, html, re) => {
    const r = run('validar-marcadores.mjs', ...withIndex(name, html));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(re);
  });

  test('schema.json inválido: sai 1', () => {
    expect(run('validar-marcadores.mjs', ...withIndex('json', INDEX, '{nope')).code).toBe(1);
    expect(run('validar-marcadores.mjs', ...withIndex('ver', INDEX, '{"version":9}')).code).toBe(1);
  });
});

describe('gerar-schema', () => {
  test('gera exatamente o cms/schema.json versionado; --check passa', () => {
    const out = path.join(tmp, 'gerado.json');
    const r = run('gerar-schema.mjs', '--out', out);
    expect(r.code, r.out).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toBe(SCHEMA);
    expect(run('gerar-schema.mjs', '--check').code).toBe(0);
  });

  test('--check sai 1 quando o esquema está desatualizado; HTML com marcador inseguro sai 1', () => {
    const stale = path.join(tmp, 'velho.json');
    fs.writeFileSync(stale, SCHEMA.replace('"Botão principal"', '"Outro rótulo"'));
    expect(run('gerar-schema.mjs', '--out', stale, '--check').code).toBe(1);
    const i = path.join(tmp, 'aninhado.html');
    fs.writeFileSync(i, INDEX.replace('>Fazer cotação grátis</span>', '>Fazer <span>cotação</span></span>'));
    const r = run('gerar-schema.mjs', '--index', i, '--out', path.join(tmp, 'x.json'));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/aninhado/);
  });
});

describe('workflow .github/workflows/cms.yml', () => {
  test('YAML válido: push e pull_request, node 22, npm ci em api e todas as etapas', () => {
    const wf = parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'cms.yml'), 'utf8')) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: {
        check: {
          defaults: { run: { 'working-directory': string } };
          steps: { uses?: string; run?: string; with?: Record<string, string> }[];
        };
      };
    };
    expect(Object.keys(wf.on).sort()).toEqual(['pull_request', 'push']);
    expect(wf.permissions).toEqual({ contents: 'read' });
    const job = wf.jobs.check;
    expect(job.defaults.run['working-directory']).toBe('api');
    const node = job.steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(node?.with?.['node-version']).toBe('22');
    const runs = job.steps.map((s) => s.run).filter(Boolean);
    expect(runs).toEqual([
      'npm ci',
      'npm run validar-marcadores',
      'node scripts/gerar-schema.mjs --check',
      'npm run typecheck',
      'npm run lint',
      'npm run format:check',
      'npm test',
    ]);
    const pkg = JSON.parse(fs.readFileSync(path.join(API, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const s of ['validar-marcadores', 'typecheck', 'lint', 'format:check', 'test', 'check'])
      expect(pkg.scripts).toHaveProperty(s);
  });

  test('S11: toda action fixada por SHA de 40 caracteres com a versão em comentário; dependabot npm + actions', () => {
    const raw = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'cms.yml'), 'utf8');
    const uses = [...raw.matchAll(/uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const [, ref, rest] of uses) {
      expect(ref, ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(rest, ref).toMatch(/# v\d+\.\d+\.\d+/);
    }
    const dep = parse(fs.readFileSync(path.join(ROOT, '.github', 'dependabot.yml'), 'utf8')) as {
      version: number;
      updates: { 'package-ecosystem': string; directory: string }[];
    };
    expect(dep.version).toBe(2);
    expect(dep.updates.map((u) => [u['package-ecosystem'], u.directory])).toEqual([
      ['npm', '/api'],
      ['github-actions', '/'],
    ]);
  });
});

describe('S6: CSP do painel', () => {
  const ADMIN_INDEX = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
  const CONFIG = fs.readFileSync(path.join(ROOT, 'admin', 'config.js'), 'utf8');

  test('admin/index.html versionado tem só a CSP de produção: sem 127.0.0.1/localhost/http:, script-src por caminho', () => {
    const csp = cspOf(ADMIN_INDEX);
    expect(csp).not.toMatch(/127\.0\.0\.1|localhost|http:\/\//);
    expect(csp).toContain('script-src ' + PROD_SCRIPT_SRC + ' https://challenges.cloudflare.com;');
    expect(csp).not.toMatch(/script-src[^;]*'self'/);
    const prodApi = /:\s*'(https:\/\/[^']+)'/.exec(/apiBase:[^\n]*/.exec(CONFIG)?.[0] ?? '')?.[1] ?? '';
    const connect = /connect-src ([^;]+)/.exec(csp)?.[1]?.split(' ') ?? [];
    expect(connect).toContain(new URL(prodApi).origin);
    expect(connect.some((x) => x.includes('*'))).toBe(false);
  });

  test('a cópia de dev troca só script-src (caminho local) e soma o Worker local ao connect-src', () => {
    const dev = devIndex(ADMIN_INDEX);
    const csp = cspOf(dev);
    expect(csp).toContain(
      'script-src http://127.0.0.1:8781/admin/ http://localhost:8781/admin/ https://challenges.cloudflare.com;',
    );
    expect(csp).toMatch(new RegExp('connect-src [^;]*' + DEV_CONNECT.replace(/\./g, '\\.')));
    expect(dev.replace(csp, '')).toBe(
      ADMIN_INDEX.replace(cspOf(ADMIN_INDEX), '').replace(
        '<head>',
        '<head>\n<!-- GERADO por api/dev/build-admin-dev.mjs para o ambiente LOCAL (CSP de dev). Não publique. -->',
      ),
    );
    // produção com host local (ou formato inesperado) faz o gerador falhar, em vez de seguir em frente
    expect(() => devIndex(ADMIN_INDEX.replace('connect-src ', 'connect-src http://127.0.0.1:8787 '))).toThrow(
      /host local/,
    );
    expect(() => devIndex(ADMIN_INDEX.replace(PROD_SCRIPT_SRC, "'self'"))).toThrow(/script-src/);
  });
});

describe('criar-usuario --recuperar', () => {
  test('chama POST /recover com secret, usuário e senha; recusa secret curto antes de chamar', async () => {
    const http = await import('node:http');
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d: Buffer) => (b += d.toString()));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', body: JSON.parse(b || '{}') as Record<string, unknown> });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, user: { username: 'chefe', role: 'admin' }, sessionsRevoked: 0 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const go = (secret: string) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          [
            path.join(API, 'scripts', 'criar-usuario.mjs'),
            'chefe',
            '--recuperar',
            '--url',
            'http://127.0.0.1:' + String(port),
          ],
          { env: { ...process.env, HG_SENHA: 'Senha-Recuperada-2026', HG_RECOVERY_SECRET: secret } },
        );
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', (code) => {
          resolve({ code, out });
        });
      });
    const short = await go('curto');
    expect(short.code).toBe(1);
    expect(short.out).toMatch(/32 caracteres/);
    expect(seen).toHaveLength(0);
    const r = await go('s'.repeat(40));
    server.close();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('com senha nova');
    expect(seen).toEqual([
      {
        url: '/recover',
        body: { secret: 's'.repeat(40), username: 'chefe', password: 'Senha-Recuperada-2026' },
      },
    ]);
  });
});

describe('gerar-senhas-comuns', () => {
  test('normaliza, tira repetidas e curtas, respeita --top; o arquivo versionado tem 10 mil', () => {
    const src = path.join(tmp, 'lista.txt');
    const gen = path.join(tmp, 'senhas.ts');
    fs.writeFileSync(src, ['123456', 'PassWord', 'pass-word', 'abc', 'Qwerty!', 'dragon'].join('\n'));
    const r = run('gerar-senhas-comuns.mjs', '--from', src, '--top', '3', '--out', gen);
    expect(r.code, r.out).toBe(0);
    const small = JSON.parse(/= (".*");/.exec(fs.readFileSync(gen, 'utf8'))?.[1] ?? '""') as string;
    expect(small.split('\n')).toEqual(['123456', 'password', 'qwerty']);
    const out = fs.readFileSync(path.join(API, 'src', 'senhas-comuns.ts'), 'utf8');
    const list = JSON.parse(/= (".*");/.exec(out)?.[1] ?? '""') as string;
    const words = list.split('\n');
    expect(words).toHaveLength(10000);
    expect(new Set(words).size).toBe(10000);
    expect(words.slice(0, 3)).toEqual(['123456', 'password', '12345678']);
    for (const w of words) expect(w).toMatch(/^[a-z0-9]{4,}$/);
  });
});
