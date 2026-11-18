import { beforeEach, describe, expect, test } from 'vitest';
import { ipKey } from '../../src/app.ts';
import { SECURITY_HEADERS } from '../../src/http.ts';
import { SLOW } from '../../src/state.ts';
import { makeApp, ORIGIN, PASS, PASS2, type App } from './helpers.ts';

let t: App;

function expectSecurityHeaders(h: Headers): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(h.get(k), k).toBe(v);
  expect(h.get('Vary')).toBe('Origin');
}

describe('CORS, cabeçalhos e limites', () => {
  beforeEach(async () => {
    t = await makeApp();
  });

  test('preflight de origem permitida: 204 com cabeçalhos exatos e de segurança', async () => {
    const r = await t.call('OPTIONS', '/login', { headers: { 'Access-Control-Request-Method': 'POST' } });
    expect(r.status).toBe(204);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(r.headers.get('Access-Control-Allow-Methods')).toBe('GET,POST,OPTIONS');
    expect(r.headers.get('Access-Control-Allow-Headers')).toBe('Authorization,Content-Type');
    expect(r.headers.get('Access-Control-Max-Age')).toBe('600');
    expectSecurityHeaders(r.headers);
  });

  test('origem não listada: 403 cors sem ACAO, inclusive no preflight e em /health', async () => {
    for (const [m, p] of [
      ['OPTIONS', '/login'],
      ['POST', '/login'],
      ['GET', '/health'],
    ] as const) {
      const r = await t.call(m, p, { origin: 'https://evil.example', body: m === 'POST' ? {} : undefined });
      expect(r.status, m + p).toBe(403);
      expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expectSecurityHeaders(r.headers);
      if (m !== 'OPTIONS') expect(r.json.code).toBe('cors');
    }
  });

  test('sem Origin: 403 (o painel sempre manda), exceto /health e /bootstrap', async () => {
    const me = await t.call('GET', '/me', { origin: null });
    expect(me.status).toBe(403);
    expect(me.json.code).toBe('cors');
    const h = await t.call('GET', '/health', { origin: null });
    expect(h.status).toBe(200);
    expect(h.json).toEqual({ ok: true, version: '3.0.0', time: '2026-11-17T12:00:00.000Z' });
    expect(h.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await t.call('POST', '/bootstrap', { origin: null, body: {} })).json.code).toBe('forbidden');
  });

  test('rota e método inexistentes; erro também leva cabeçalhos de segurança', async () => {
    const r = await t.call('GET', '/nada');
    expect(r.status).toBe(404);
    expect(r.json.code).toBe('not_found');
    expectSecurityHeaders(r.headers);
    expect((await t.call('GET', '/login')).status).toBe(405);
    expect((await t.call('POST', '/upload', { body: {} })).status).toBe(404); // /upload saiu na v3
    expect((await t.call('GET', '/me')).json.code).toBe('unauthenticated');
  });

  test('limites de corpo por rota: login 4 KB, JSON comum 64 KB; JSON inválido e Content-Type', async () => {
    const big = (n: number): string => JSON.stringify({ username: 'x'.repeat(n) });
    const raw = (p: string, body: string, token?: string) =>
      t.call('POST', p, {
        raw: body,
        headers: { 'Content-Type': 'application/json' },
        ...(token ? { token } : {}),
      });
    expect((await raw('/login', big(4 * 1024))).status).toBe(413);
    expect((await raw('/login', big(3 * 1024))).status).toBe(401);
    await t.addUser('ana', PASS);
    const tok = await t.login('ana', PASS);
    expect((await raw('/users/delete', big(64 * 1024), tok)).status).toBe(413);
    expect((await raw('/users/delete', big(60 * 1024), tok)).status).toBe(400);
    expect((await raw('/login', '{nope')).status).toBe(400);
    expect((await raw('/login', '[1,2]')).status).toBe(400);
    const wrongCt = await t.call('POST', '/login', { raw: '{}', headers: { 'Content-Type': 'text/plain' } });
    expect(wrongCt.status).toBe(400);
  });
});

describe('login, rate limit e sessão', () => {
  beforeEach(async () => {
    t = await makeApp();
    await t.addUser('ana', PASS, 'admin');
  });

  test('login ok devolve token de 256 bits, user e expiresIn; /me; /logout apaga no servidor', async () => {
    const r = await t.call('POST', '/login', { body: { username: ' ANA ', password: PASS }, ip: '10.0.0.1' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, user: { username: 'ana', role: 'admin' }, expiresIn: 3600 });
    const token = String(r.json.token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const me = await t.call('GET', '/me', { token });
    expect(me.json.user).toEqual({ username: 'ana', role: 'admin' });
    expect((await t.call('POST', '/logout', { token, body: {} })).status).toBe(200);
    const again = await t.call('GET', '/me', { token });
    expect(again.status).toBe(401);
    expect(again.json.code).toBe('session_expired');
    expect(await t.state.sessionCount('ana')).toBe(0);
  });

  test('o DO guarda só o hash do token', async () => {
    const token = await t.login('ana', PASS);
    const { runInDurableObject } = await import('cloudflare:test');
    const rows = await runInDurableObject(t.state, (_i, s) =>
      s.storage.sql.exec('SELECT token_hash FROM sessions').toArray(),
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('senha errada e usuário inexistente: mesma resposta genérica', async () => {
    const a = await t.call('POST', '/login', {
      body: { username: 'ana', password: 'errada-errada' },
      ip: '10.0.0.2',
    });
    const b = await t.call('POST', '/login', {
      body: { username: 'naoexiste', password: 'errada-errada' },
      ip: '10.0.0.2',
    });
    const c = await t.call('POST', '/login', {
      body: { username: 'ana', password: PASS + 'x'.repeat(300) },
      ip: '10.0.0.2',
    });
    for (const r of [a, b, c]) {
      expect(r.status).toBe(401);
      expect(r.json).toEqual({
        ok: false,
        error: 'Usuário ou senha incorretos.',
        code: 'invalid_credentials',
      });
    }
  });

  test('5 falhas por usuário+IP bloqueiam (mesmo com a senha certa), só aquele IP, por 15 min', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await t.call('POST', '/login', {
        body: { username: 'ana', password: 'errada-' + String(i) + 'xxxx' },
        ip: '10.0.0.3',
      });
      expect(r.status).toBe(401);
    }
    const blocked = await t.call('POST', '/login', {
      body: { username: 'ana', password: PASS },
      ip: '10.0.0.3',
    });
    expect(blocked.status).toBe(429);
    expect(blocked.json).toEqual({
      ok: false,
      error: 'Muitas tentativas. Tente de novo em alguns minutos.',
      code: 'rate_limited',
    });
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(
      (await t.call('POST', '/login', { body: { username: 'ana', password: PASS }, ip: '10.0.0.4' })).status,
    ).toBe(200);
    t.advance(15 * 60 + 1);
    expect(
      (await t.call('POST', '/login', { body: { username: 'ana', password: PASS }, ip: '10.0.0.3' })).status,
    ).toBe(200);
  });

  test('login certo zera a contagem do usuário (4 erros + acerto + 4 erros não bloqueia)', async () => {
    const fail = () =>
      t.call('POST', '/login', { body: { username: 'ana', password: 'errada-errada' }, ip: '10.0.0.9' });
    for (let i = 0; i < 4; i++) expect((await fail()).status).toBe(401);
    expect(
      (await t.call('POST', '/login', { body: { username: 'ana', password: PASS }, ip: '10.0.0.9' })).status,
    ).toBe(200);
    for (let i = 0; i < 4; i++) expect((await fail()).status).toBe(401);
    expect(
      (await t.call('POST', '/login', { body: { username: 'ana', password: PASS }, ip: '10.0.0.9' })).status,
    ).toBe(200);
  });

  test('20 falhas por IP (usuários variados) bloqueiam o IP inteiro', async () => {
    for (let i = 0; i < 20; i++) {
      await t.call('POST', '/login', {
        body: { username: 'u' + String(i) + 'xx', password: 'errada-errada' },
        ip: '10.0.0.5',
      });
    }
    expect(
      (await t.call('POST', '/login', { body: { username: 'ana', password: PASS }, ip: '10.0.0.5' })).status,
    ).toBe(429);
    expect(
      (await t.call('POST', '/login', { body: { username: 'ana', password: PASS }, ip: '10.0.0.6' })).status,
    ).toBe(200);
  });

  test('atômico: 12 tentativas simultâneas erradas fazem no máximo 5 verificações; o resto é 429', async () => {
    const all = await Promise.all(
      Array.from({ length: 12 }, () =>
        t.call('POST', '/login', { body: { username: 'ana', password: 'errada-errada' }, ip: '10.0.0.7' }),
      ),
    );
    const statuses = all.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
  });

  test('sessão expira por inatividade (1 h) e é renovada pelo uso', async () => {
    const tok = await t.login('ana', PASS);
    t.advance(3000);
    expect((await t.call('GET', '/me', { token: tok })).status).toBe(200);
    t.advance(3000);
    expect((await t.call('GET', '/me', { token: tok })).status).toBe(200);
    t.advance(3601);
    const r = await t.call('GET', '/me', { token: tok });
    expect(r.status).toBe(401);
    expect(r.json.code).toBe('session_expired');
  });

  test('sessão expira por tempo absoluto (12 h) mesmo com uso contínuo', async () => {
    const tok = await t.login('ana', PASS);
    for (let i = 0; i < 23; i++) {
      t.advance(1800);
      expect((await t.call('GET', '/me', { token: tok })).status, 'passo ' + String(i)).toBe(200);
    }
    t.advance(1801);
    expect((await t.call('GET', '/me', { token: tok })).json.code).toBe('session_expired');
  });

  test('rotação: login com o token antigo no Authorization invalida o antigo', async () => {
    const old = await t.login('ana', PASS);
    const fresh = await t.login('ana', PASS, { token: old });
    expect(fresh).not.toBe(old);
    expect((await t.call('GET', '/me', { token: old })).status).toBe(401);
    expect((await t.call('GET', '/me', { token: fresh })).status).toBe(200);
  });

  test('token malformado: unauthenticated; token bem formado desconhecido: session_expired', async () => {
    expect((await t.call('GET', '/me', { token: 'x'.repeat(43) })).json.code).toBe('session_expired');
    expect((await t.call('GET', '/me', { token: 'curto' })).json.code).toBe('unauthenticated');
    expect((await t.call('GET', '/me', { headers: { Authorization: 'Basic abc' } })).json.code).toBe(
      'unauthenticated',
    );
  });

  test('logs JSON estruturados sem senha, token, pepper ou corpo', async () => {
    const tok = await t.login('ana', PASS);
    await t.call('POST', '/login', {
      body: { username: 'ana', password: 'senha-errada-' + 'Z9' },
      ip: '10.1.1.1',
    });
    await t.call('GET', '/me', { token: tok });
    const all = t.logs.join('\n');
    for (const secret of [PASS, 'senha-errada-Z9', tok, String(t.env.PASSWORD_PEPPER), 'dev-token']) {
      expect(all).not.toContain(secret);
    }
    const lines = t.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.find((l) => l.route === '/login' && l.status === 401)).toMatchObject({
      level: 'warn',
      event: 'request',
      method: 'POST',
      code: 'invalid_credentials',
    });
    expect(lines.find((l) => l.route === '/me')).toMatchObject({ level: 'info', status: 200, user: 'ana' });
    for (const l of lines)
      expect(
        Object.keys(l).every((k) =>
          [
            'level',
            'event',
            'route',
            'method',
            'status',
            'ms',
            'user',
            'code',
            'attempts',
            'changed',
            'error',
          ].includes(k),
        ),
      ).toBe(true);
  });
});

describe('limite por rede IPv6 e contador global por usuário (S4)', () => {
  beforeEach(async () => {
    t = await makeApp();
    await t.addUser('ana', PASS, 'admin');
  });

  test('ipKey: IPv6 vira o prefixo /64 (qualquer grafia); IPv4 e IPv4 mapeado ficam como IPv4', () => {
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('2001:DB8:0:0:ffff:ffff:ffff:ffff')).toBe('2001:db8:0:0::/64');
    expect(ipKey('2001:0db8:0000:0000:0000:0000:0000:0002')).toBe('2001:db8:0:0::/64');
    expect(ipKey('2001:db8:0:1::1')).toBe('2001:db8:0:1::/64');
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
    expect(ipKey('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(ipKey('10.0.0.1')).toBe('10.0.0.1');
    expect(ipKey('lixo')).toBe('lixo');
  });

  test('trocar de endereço dentro do mesmo /64 não zera o limite por usuário+IP', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await t.call('POST', '/login', {
        body: { username: 'ana', password: 'errada-' + String(i) + 'xxxx' },
        ip: '2001:db8::' + String(i + 1),
      });
      expect(r.status).toBe(401);
    }
    const same64 = await t.call('POST', '/login', {
      body: { username: 'ana', password: PASS },
      ip: '2001:db8::ffff',
    });
    expect(same64.status).toBe(429);
    const other64 = await t.call('POST', '/login', {
      body: { username: 'ana', password: PASS },
      ip: '2001:db8:0:1::1',
    });
    expect(other64.status).toBe(200);
  });

  test('50 falhas/h de IPs diferentes: a partir daí atraso progressivo, sem travar a conta', async () => {
    expect(SLOW).toMatchObject({ max: 50, windowMs: 3600_000 });
    const fail = (i: number) =>
      t.call('POST', '/login', {
        body: { username: 'ana', password: 'errada-errada' },
        ip: '198.51.100.' + String(i),
      });
    for (let i = 0; i < SLOW.max; i++) expect((await fail(i)).status, 'tentativa ' + String(i)).toBe(401);
    // 51ª, de um IP novo e com a senha certa: espera 1 s
    const slowed = await t.call('POST', '/login', {
      body: { username: 'ana', password: PASS },
      ip: '203.0.113.1',
    });
    expect(slowed.status).toBe(429);
    expect(slowed.headers.get('Retry-After')).toBe('1');
    t.advance(1);
    expect((await fail(200)).status).toBe(401);
    // próxima espera dobra (2 s); a conta não trava: esperando, a senha certa entra
    const again = await t.call('POST', '/login', {
      body: { username: 'ana', password: PASS },
      ip: '203.0.113.2',
    });
    expect(again.status).toBe(429);
    expect(again.headers.get('Retry-After')).toBe('2');
    t.advance(2);
    const ok = await t.call('POST', '/login', {
      body: { username: 'ana', password: PASS },
      ip: '203.0.113.3',
    });
    expect(ok.status).toBe(200);
    // o atraso tem teto (SLOW.maxDelayMs) e a janela de 1 h zera tudo
    expect(SLOW.maxDelayMs).toBeLessThanOrEqual(60_000);
    const a = await t.state.listAudit(5, null);
    expect(a.some((e) => e.action === 'login_slowed')).toBe(true);
    t.advance(3601);
    expect((await fail(201)).status).toBe(401);
  });

  test('DoS: redes insistindo no atraso gastam o próprio limite e não empurram o atraso; o dono entra em até SLOW.maxDelayMs', async () => {
    const { runInDurableObject } = await import('cloudflare:test');
    const lastAt = () =>
      runInDurableObject(t.state, (_i, st) =>
        Number(
          st.storage.sql.exec("SELECT last_at FROM slow_limits WHERE key = 'login:g:ana'").one().last_at,
        ),
      );
    for (let i = 0; i < SLOW.max; i++) {
      await t.call('POST', '/login', {
        body: { username: 'ana', password: 'errada-errada' },
        ip: '198.51.100.' + String(i),
      });
    }
    const before = await lastAt();
    // meio segundo depois (dentro do atraso de 1 s), 8 redes atacantes insistem 25 vezes cada
    t.advance(0.5);
    for (let n = 0; n < 8; n++) {
      const got: string[] = [];
      for (let k = 0; k < 25; k++) {
        const r = await t.call('POST', '/login', {
          body: { username: 'ana', password: 'errada-errada' },
          ip: '192.0.2.' + String(n),
        });
        got.push(String(r.status) + ':' + (Number(r.headers.get('Retry-After')) > 60 ? 'rede' : 'atraso'));
      }
      // cada recusa conta no limite da rede (20/15 min): da 21ª em diante a rede está bloqueada
      expect(
        got.slice(0, 20).every((x) => x === '429:atraso'),
        'rede ' + String(n) + ' ' + got.join(' '),
      ).toBe(true);
      expect(
        got.slice(20).every((x) => x === '429:rede'),
        'rede ' + String(n) + ' ' + got.join(' '),
      ).toBe(true);
    }
    // nenhuma recusa regravou last_at (o atraso não se estende)
    expect(await lastAt()).toBe(before);
    // o dono também insiste algumas vezes (recusado), sem se trancar
    for (let k = 0; k < 3; k++) {
      const r = await t.call('POST', '/login', {
        body: { username: 'ana', password: PASS },
        ip: '203.0.113.50',
      });
      expect(r.status).toBe(429);
    }
    // limite documentado: a senha certa entra assim que acaba o atraso contado da última tentativa ADMITIDA
    // (aqui 1 s; no máximo SLOW.maxDelayMs), por mais recusas que tenha havido no meio
    t.advance(0.5);
    expect(SLOW.maxDelayMs).toBe(30_000);
    const ok = await t.call('POST', '/login', {
      body: { username: 'ana', password: PASS },
      ip: '203.0.113.50',
    });
    expect(ok.status).toBe(200);
  });

  test('com Turnstile ligado, o token verificado dispensa o atraso progressivo', async () => {
    t = await makeApp({ TURNSTILE_SECRET: 'ts-secret' });
    await t.addUser('ana', PASS);
    t.setExtraFetch((url) =>
      url.includes('turnstile') ? Promise.resolve(Response.json({ success: true })) : null,
    );
    for (let i = 0; i < SLOW.max + 3; i++) {
      const r = await t.call('POST', '/login', {
        body: { username: 'ana', password: 'errada-errada', turnstileToken: 'bom' },
        ip: '198.51.100.' + String(i),
      });
      expect(r.status, 'tentativa ' + String(i)).toBe(401);
    }
    const ok = await t.call('POST', '/login', {
      body: { username: 'ana', password: PASS, turnstileToken: 'bom' },
      ip: '203.0.113.9',
    });
    expect(ok.status).toBe(200);
  });
});

describe('auditoria de login com usuário inválido (S5)', () => {
  test('não grava o texto digitado, só invalid_username: true', async () => {
    t = await makeApp();
    await t.call('POST', '/login', { body: { username: 'Minha Senha Secreta!', password: 'x' } });
    await t.call('POST', '/login', { body: { username: 12345, password: 'x' } });
    const rows = await t.state.listAudit(10, null);
    const fails = rows.filter((r) => r.action === 'login_fail');
    expect(fails).toHaveLength(2);
    for (const f of fails) {
      expect(f.username).toBeNull();
      expect(JSON.parse(f.detail ?? 'null')).toEqual({ invalid_username: true });
    }
    expect(JSON.stringify(rows)).not.toMatch(/Minha Senha|12345/);
  });
});

describe('GITHUB_API_BASE só aceita o GitHub de verdade (S9)', () => {
  test.each([
    ['https://evil.example', ''],
    ['http://api.github.com', ''],
    ['https://api.github.com.evil.example', ''],
    ['https://api.github.com@evil.example', ''],
    ['http://127.0.0.1:8788', ''],
    ['http://127.0.0.1:8788', '0'],
    ['http://evil.example:8788', '1'],
  ])('%s com DEV_ALLOW_LOCAL_GITHUB=%j: recusa (500 sem chamar ninguém)', async (base, flag) => {
    t = await makeApp({ GITHUB_API_BASE: base, DEV_ALLOW_LOCAL_GITHUB: flag });
    await t.addUser('ana', PASS);
    const tok = await t.login('ana', PASS);
    const seen: string[] = [];
    t.setExtraFetch((url) => {
      seen.push(url);
      return Promise.reject(new Error('não devia chamar'));
    });
    const r = await t.call('GET', '/content', { token: tok });
    expect(r.status).toBe(500);
    expect(r.json.code).toBe('server');
    expect(seen).toEqual([]);
    expect(t.logs.some((l) => l.includes('config_missing') && l.includes('GITHUB_API_BASE'))).toBe(true);
  });

  test('padrão https://api.github.com funciona; mock local só com host local E DEV_ALLOW_LOCAL_GITHUB=1', async () => {
    t = await makeApp();
    await t.addUser('ana', PASS);
    let tok = await t.login('ana', PASS);
    expect((await t.call('GET', '/content', { token: tok })).status).toBe(200);
    t = await makeApp({ GITHUB_API_BASE: 'http://127.0.0.1:8788', DEV_ALLOW_LOCAL_GITHUB: '1' });
    await t.addUser('ana', PASS);
    tok = await t.login('ana', PASS);
    expect((await t.call('GET', '/content', { token: tok })).status).toBe(200);
  });
});

describe('Turnstile opcional', () => {
  test('sem TURNSTILE_SECRET o login funciona sem token', async () => {
    t = await makeApp();
    await t.addUser('ana', PASS);
    expect((await t.call('POST', '/login', { body: { username: 'ana', password: PASS } })).status).toBe(200);
  });

  test('com TURNSTILE_SECRET: exige token, valida no siteverify com remoteip, recusa inválido', async () => {
    t = await makeApp({ TURNSTILE_SECRET: 'ts-secret' });
    await t.addUser('ana', PASS);
    const seen: URLSearchParams[] = [];
    t.setExtraFetch((url, init) => {
      if (!url.startsWith('https://challenges.cloudflare.com/turnstile/v0/siteverify')) return null;
      const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      seen.push(form);
      return Promise.resolve(Response.json({ success: form.get('response') === 'bom' }));
    });
    const none = await t.call('POST', '/login', { body: { username: 'ana', password: PASS } });
    expect(none.status).toBe(422);
    expect(none.json.fields).toHaveProperty('turnstileToken');
    const bad = await t.call('POST', '/login', {
      body: { username: 'ana', password: PASS, turnstileToken: 'ruim' },
    });
    expect(bad.status).toBe(422);
    const good = await t.call('POST', '/login', {
      body: { username: 'ana', password: PASS, turnstileToken: 'bom' },
      ip: '203.0.113.9',
    });
    expect(good.status).toBe(200);
    expect(seen.at(-1)?.get('secret')).toBe('ts-secret');
    expect(seen.at(-1)?.get('remoteip')).toBe('203.0.113.9');
    t.setExtraFetch((url) => (url.includes('turnstile') ? Promise.reject(new Error('fora do ar')) : null));
    const down = await t.call('POST', '/login', {
      body: { username: 'ana', password: PASS, turnstileToken: 'bom' },
    });
    expect(down.status).toBe(502);
    expect(down.json.code).toBe('upstream');
  });

  test('sem PASSWORD_PEPPER o login falha fechado (500) sem vazar o motivo', async () => {
    t = await makeApp({ PASSWORD_PEPPER: '' });
    const r = await t.call('POST', '/login', { body: { username: 'ana', password: PASS2 } });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ ok: false, error: 'Erro interno. Tente de novo.', code: 'server' });
    expect(t.logs.some((l) => l.includes('config_missing'))).toBe(true);
  });
});
