import { beforeEach, describe, expect, test } from 'vitest';
import { makeApp, PASS, PASS2, type App } from './helpers.ts';

let t: App;
let admin: string;

describe('usuários e papéis', () => {
  beforeEach(async () => {
    t = await makeApp();
    await t.addUser('chefe', PASS, 'admin');
    admin = await t.login('chefe', PASS);
  });

  test('admin cria editor; validação com política de senha; duplicado 409; lista sem hash', async () => {
    const inv = await t.call('POST', '/users/create', {
      token: admin,
      body: { currentPassword: PASS, username: 'a b', password: 'curta', role: 'dono' },
    });
    expect(inv.status).toBe(422);
    expect(Object.keys(inv.json.fields ?? {}).sort()).toEqual(['password', 'role', 'username']);
    const weak = await t.call('POST', '/users/create', {
      token: admin,
      body: { currentPassword: PASS, username: 'edu', password: 'edu-1234567', role: 'editor' },
    });
    expect(weak.json.fields?.password).toMatch(/nome de usuário/);
    const r = await t.call('POST', '/users/create', {
      token: admin,
      body: { currentPassword: PASS, username: 'Edu', password: PASS2, role: 'editor' },
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, user: { username: 'edu', role: 'editor' } });
    expect(
      (
        await t.call('POST', '/users/create', {
          token: admin,
          body: { currentPassword: PASS, username: 'edu', password: PASS2, role: 'editor' },
        })
      ).status,
    ).toBe(409);
    const list = await t.call('GET', '/users', { token: admin });
    const users = list.json.users as Record<string, unknown>[];
    expect(users.map((u) => [u.username, u.role])).toEqual([
      ['chefe', 'admin'],
      ['edu', 'editor'],
    ]);
    expect(users[0]).toEqual({
      username: 'chefe',
      role: 'admin',
      created_at: '2026-11-17T12:00:00.000Z',
      last_login_at: '2026-11-17T12:00:00.000Z',
      pepper_current: true,
    });
    expect(users[1]?.last_login_at).toBeNull();
    expect(JSON.stringify(list.json)).not.toMatch(/hash|salt/);
  });

  test('editor: rotas de admin negadas (403); edita conteúdo e troca a própria senha', async () => {
    await t.call('POST', '/users/create', {
      token: admin,
      body: { currentPassword: PASS, username: 'edu', password: PASS2, role: 'editor' },
    });
    const ed = await t.login('edu', PASS2);
    for (const [m, p, b] of [
      ['GET', '/users', undefined],
      ['POST', '/users/create', { username: 'zzz', password: PASS, role: 'admin' }],
      ['POST', '/users/delete', { username: 'chefe' }],
      ['POST', '/users/password', { username: 'chefe', password: PASS2 }],
      ['GET', '/audit', undefined],
    ] as const) {
      const r = await t.call(m, p, { token: ed, body: b });
      expect(r.status, p).toBe(403);
      expect(r.json.code).toBe('forbidden');
    }
    expect((await t.call('GET', '/content', { token: ed })).status).toBe(200);
    expect(
      (await t.call('POST', '/password', { token: ed, body: { current: PASS2, new: 'Nova-Senha-Boa-1' } }))
        .status,
    ).toBe(200);
  });

  test('não remove a si mesmo nem o último admin; remover derruba as sessões do removido', async () => {
    expect(
      (
        await t.call('POST', '/users/delete', {
          token: admin,
          body: { currentPassword: PASS, username: 'chefe' },
        })
      ).status,
    ).toBe(400);
    await t.call('POST', '/users/create', {
      token: admin,
      body: { currentPassword: PASS, username: 'edu', password: PASS2, role: 'editor' },
    });
    const ed = await t.login('edu', PASS2);
    expect(
      (
        await t.call('POST', '/users/delete', {
          token: admin,
          body: { currentPassword: PASS, username: 'edu' },
        })
      ).status,
    ).toBe(200);
    expect((await t.call('GET', '/me', { token: ed })).status).toBe(401);
    expect(await t.state.sessionCount('edu')).toBe(0);
    expect(
      (
        await t.call('POST', '/users/delete', {
          token: admin,
          body: { currentPassword: PASS, username: 'edu' },
        })
      ).status,
    ).toBe(404);
    await t.call('POST', '/users/create', {
      token: admin,
      body: { currentPassword: PASS, username: 'vice', password: PASS2, role: 'admin' },
    });
    const vice = await t.login('vice', PASS2);
    expect(
      (
        await t.call('POST', '/users/delete', {
          token: vice,
          body: { currentPassword: PASS2, username: 'chefe' },
        })
      ).status,
    ).toBe(200);
    const last = await t.call('POST', '/users/delete', {
      token: vice,
      body: { currentPassword: PASS2, username: 'vice' },
    });
    expect(last.status).toBe(400);
    expect(await t.state.userCount()).toBe(1);
  });

  test('último admin é protegido mesmo com dois admins removendo um ao outro ao mesmo tempo', async () => {
    await t.call('POST', '/users/create', {
      token: admin,
      body: { currentPassword: PASS, username: 'vice', password: PASS2, role: 'admin' },
    });
    const vice = await t.login('vice', PASS2);
    const [a, b] = await Promise.all([
      t.call('POST', '/users/delete', { token: admin, body: { currentPassword: PASS, username: 'vice' } }),
      t.call('POST', '/users/delete', { token: vice, body: { currentPassword: PASS2, username: 'chefe' } }),
    ]);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeLessThanOrEqual(1);
    const left = (await t.state.listUsers()).filter((u) => u.role === 'admin');
    expect(left.length).toBeGreaterThanOrEqual(1);
  });
});

describe('troca de senha', () => {
  beforeEach(async () => {
    t = await makeApp();
    await t.addUser('vice', PASS, 'admin');
    admin = await t.login('vice', PASS);
  });

  test('atual errada: 422 e conta no limite; nova fraca ou igual: 422', async () => {
    const wrong = await t.call('POST', '/password', {
      token: admin,
      body: { current: 'errada-errada', new: PASS2 },
    });
    expect(wrong.status).toBe(422);
    expect(wrong.json.fields).toHaveProperty('current');
    const weak = await t.call('POST', '/password', {
      token: admin,
      body: { current: PASS, new: '12345678910' },
    });
    expect(weak.json.fields?.new).toMatch(/muito comum/);
    const same = await t.call('POST', '/password', { token: admin, body: { current: PASS, new: PASS } });
    expect(same.json.fields?.new).toMatch(/diferente/);
  });

  test('troca certa invalida as OUTRAS sessões; a atual continua; senha velha não entra mais', async () => {
    const other = await t.login('vice', PASS, { ip: '10.9.9.9' });
    const r = await t.call('POST', '/password', { token: admin, body: { current: PASS, new: PASS2 } });
    expect(r.status).toBe(200);
    expect((await t.call('GET', '/me', { token: admin })).status).toBe(200);
    expect((await t.call('GET', '/me', { token: other })).status).toBe(401);
    expect((await t.call('POST', '/login', { body: { username: 'vice', password: PASS } })).status).toBe(401);
    expect(await t.login('vice', PASS2)).toBeTruthy();
  });

  test('5 erros de senha atual bloqueiam com 429 (mesmo com a senha certa)', async () => {
    for (let i = 0; i < 5; i++) {
      await t.call('POST', '/password', {
        token: admin,
        body: { current: 'errada-' + String(i) + 'xxxx', new: PASS2 },
      });
    }
    expect(
      (await t.call('POST', '/password', { token: admin, body: { current: PASS, new: PASS2 } })).status,
    ).toBe(429);
  });

  test('admin redefine a senha de outro: todas as sessões dele caem', async () => {
    await t.addUser('edu', PASS, 'editor');
    const ed = await t.login('edu', PASS);
    const weak = await t.call('POST', '/users/password', {
      token: admin,
      body: { currentPassword: PASS, username: 'edu', password: 'senha12345' },
    });
    expect(weak.status).toBe(422);
    const r = await t.call('POST', '/users/password', {
      token: admin,
      body: { currentPassword: PASS, username: 'edu', password: PASS2 },
    });
    expect(r.status).toBe(200);
    expect((await t.call('GET', '/me', { token: ed })).status).toBe(401);
    expect(await t.login('edu', PASS2)).toBeTruthy();
    expect(
      (
        await t.call('POST', '/users/password', {
          token: admin,
          body: { currentPassword: PASS, username: 'ninguem', password: PASS2 },
        })
      ).status,
    ).toBe(404);
  });
});

describe('senha do próprio admin nas ações sobre usuários (C4/S3)', () => {
  beforeEach(async () => {
    t = await makeApp();
    await t.addUser('chefe', PASS, 'admin');
    await t.addUser('edu', PASS2, 'editor');
    admin = await t.login('chefe', PASS);
  });

  test('/users/password no próprio usuário: 400 mandando usar /password (Minha senha)', async () => {
    const r = await t.call('POST', '/users/password', {
      token: admin,
      body: { currentPassword: PASS, username: 'chefe', password: 'Senha-Nova-Do-Chefe-1' },
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/Minha senha/);
    expect(await t.login('chefe', PASS)).toBeTruthy();
  });

  test.each([
    ['/users/create', { username: 'nova', password: 'Outra-Senha-Forte-88', role: 'admin' }],
    ['/users/delete', { username: 'edu' }],
    ['/users/password', { username: 'edu', password: 'Outra-Senha-Forte-88' }],
  ])('%s sem a senha atual do admin, ou com ela errada: 422 em currentPassword; nada muda', async (p, b) => {
    const before = await t.state.listUsers();
    const none = await t.call('POST', p, { token: admin, body: b });
    expect(none.status).toBe(422);
    expect(none.json.fields).toHaveProperty('currentPassword');
    const wrong = await t.call('POST', p, { token: admin, body: { ...b, currentPassword: 'errada-errada' } });
    expect(wrong.status).toBe(422);
    expect(wrong.json.fields?.currentPassword).toBe('Sua senha está incorreta.');
    expect(await t.state.listUsers()).toEqual(before);
    expect(await t.login('edu', PASS2)).toBeTruthy();
    const a = await t.state.listAudit(10, null);
    expect(a.filter((e) => e.action === 'reauth_fail')).toHaveLength(2);
  });

  test('5 senhas atuais erradas bloqueiam (429) as três rotas, mesmo com a certa depois', async () => {
    for (let i = 0; i < 5; i++) {
      await t.call('POST', '/users/delete', {
        token: admin,
        body: { username: 'edu', currentPassword: 'errada-' + String(i) + 'xx' },
      });
    }
    for (const [p, b] of [
      ['/users/delete', { username: 'edu' }],
      ['/users/create', { username: 'nova', password: 'Outra-Senha-Forte-88', role: 'editor' }],
      ['/users/password', { username: 'edu', password: 'Outra-Senha-Forte-88' }],
    ] as const) {
      const r = await t.call('POST', p, { token: admin, body: { ...b, currentPassword: PASS } });
      expect(r.status, p).toBe(429);
    }
    expect(await t.state.userCount()).toBe(2);
  });
});

describe('bootstrap do primeiro admin', () => {
  test('S8: BOOTSTRAP_SECRET com menos de 32 caracteres: 403 mesmo com o segredo certo', async () => {
    const short = 'x'.repeat(31);
    t = await makeApp({ BOOTSTRAP_SECRET: short });
    const r = await t.call('POST', '/bootstrap', {
      body: { secret: short, username: 'chefe', password: PASS },
    });
    expect(r.status).toBe(403);
    expect(await t.state.userCount()).toBe(0);
    expect(t.logs.some((l) => l.includes('config_missing') && l.includes('BOOTSTRAP_SECRET'))).toBe(true);
    t = await makeApp({ BOOTSTRAP_SECRET: 'y'.repeat(32) });
    const ok = await t.call('POST', '/bootstrap', {
      body: { secret: 'y'.repeat(32), username: 'chefe', password: PASS },
    });
    expect(ok.status).toBe(200);
  });

  test('sem BOOTSTRAP_SECRET: sempre 403', async () => {
    t = await makeApp();
    const r = await t.call('POST', '/bootstrap', { body: { secret: '', username: 'chefe', password: PASS } });
    expect(r.status).toBe(403);
  });

  test('segredo errado 403 (conta no limite); certo cria admin; depois sempre 403', async () => {
    t = await makeApp({ BOOTSTRAP_SECRET: 'segredo-de-bootstrap-longo-0123456789' });
    const wrong = await t.call('POST', '/bootstrap', {
      body: { secret: 'errado', username: 'chefe', password: PASS },
    });
    expect(wrong.status).toBe(403);
    const weak = await t.call('POST', '/bootstrap', {
      body: { secret: 'segredo-de-bootstrap-longo-0123456789', username: 'chefe', password: 'chefe12345678' },
    });
    expect(weak.status).toBe(422);
    const r = await t.call('POST', '/bootstrap', {
      origin: null,
      body: { secret: 'segredo-de-bootstrap-longo-0123456789', username: 'Chefe', password: PASS },
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, user: { username: 'chefe', role: 'admin' } });
    const again = await t.call('POST', '/bootstrap', {
      body: { secret: 'segredo-de-bootstrap-longo-0123456789', username: 'outro', password: PASS },
    });
    expect(again.status).toBe(403);
    expect(await t.state.userCount()).toBe(1);
    expect(await t.login('chefe', PASS)).toBeTruthy();
  });

  test('força bruta no segredo: 20 erros por IP bloqueiam', async () => {
    t = await makeApp({ BOOTSTRAP_SECRET: 'segredo-de-bootstrap-longo-0123456789' });
    for (let i = 0; i < 20; i++)
      await t.call('POST', '/bootstrap', {
        body: { secret: 'x' + String(i), username: 'a12', password: PASS },
        ip: '10.2.2.2',
      });
    const r = await t.call('POST', '/bootstrap', {
      body: { secret: 'segredo-de-bootstrap-longo-0123456789', username: 'chefe', password: PASS },
      ip: '10.2.2.2',
    });
    expect(r.status).toBe(429);
  });
});

describe('auditoria', () => {
  test('ações registradas, mais recente primeiro, paginação por before/limit', async () => {
    t = await makeApp();
    await t.addUser('chefe', PASS, 'admin');
    admin = await t.login('chefe', PASS);
    await t.call('POST', '/login', { body: { username: 'chefe', password: 'errada-errada' } });
    await t.call('POST', '/users/create', {
      token: admin,
      body: { currentPassword: PASS, username: 'edu', password: PASS2, role: 'editor' },
    });
    await t.call('POST', '/users/delete', { token: admin, body: { currentPassword: PASS, username: 'edu' } });
    const a = await t.call('GET', '/audit', { token: admin });
    const entries = a.json.entries as {
      id: number;
      action: string;
      username: string | null;
      ip: string | null;
      ts: string;
    }[];
    expect(entries.map((e) => e.action)).toEqual(['user_delete', 'user_create', 'login_fail', 'login_ok']);
    expect(entries[0]).toMatchObject({ username: 'chefe', ip: '127.0.0.1', ts: '2026-11-17T12:00:00.000Z' });
    const page = await t.call('GET', '/audit?limit=2&before=' + String(entries[1]?.id), { token: admin });
    expect((page.json.entries as { action: string }[]).map((e) => e.action)).toEqual([
      'login_fail',
      'login_ok',
    ]);
  });
});
