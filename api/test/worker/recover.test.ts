/* R10: recuperação de admin por RECOVERY_SECRET efêmero e rotação do pepper sem zerar o DO. */
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, test } from 'vitest';
import { makeApp, PASS, PASS2, type App } from './helpers.ts';

let t: App;
const SECRET = 'segredo-de-recuperacao-com-mais-de-32';
const NEW = 'Senha-Recuperada-2026';

describe('POST /recover (RECOVERY_SECRET)', () => {
  beforeEach(async () => {
    t = await makeApp({ RECOVERY_SECRET: SECRET });
    await t.addUser('chefe', PASS, 'admin');
    await t.addUser('edu', PASS2, 'editor');
  });

  const recover = (body: Record<string, unknown>, ip = '10.7.7.7', origin: string | null = null) =>
    t.call('POST', '/recover', { body, ip, origin });

  test('sem o secret definido, ou com menos de 32 caracteres: 403 sempre', async () => {
    t.setEnv({ RECOVERY_SECRET: '' });
    expect((await recover({ secret: '', username: 'chefe', password: NEW })).status).toBe(403);
    t.setEnv({ RECOVERY_SECRET: 'curto-demais' });
    const r = await recover({ secret: 'curto-demais', username: 'chefe', password: NEW });
    expect(r.status).toBe(403);
    expect(t.logs.some((l) => l.includes('config_missing') && l.includes('RECOVERY_SECRET'))).toBe(true);
    expect(await t.login('chefe', PASS)).toBeTruthy();
  });

  test('segredo certo redefine a senha do admin, derruba as sessões e audita; senha não vai para a auditoria', async () => {
    const old = await t.login('chefe', PASS);
    const wrong = await recover({ secret: SECRET + 'x', username: 'chefe', password: NEW });
    expect(wrong.status).toBe(403);
    const r = await recover({ secret: SECRET, username: ' Chefe ', password: NEW });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toEqual({ ok: true, user: { username: 'chefe', role: 'admin' }, sessionsRevoked: 1 });
    expect((await t.call('GET', '/me', { token: old })).status).toBe(401);
    expect((await t.call('POST', '/login', { body: { username: 'chefe', password: PASS } })).status).toBe(
      401,
    );
    expect(await t.login('chefe', NEW)).toBeTruthy();
    const a = await t.state.listAudit(20, null);
    expect(a.map((e) => e.action)).toEqual(expect.arrayContaining(['recover_fail', 'recover_ok']));
    expect(JSON.stringify(a)).not.toContain(NEW);
    expect(t.logs.some((l) => l.includes('"event":"recovery_used"'))).toBe(true);
  });

  test('uso único: o mesmo secret não funciona de novo (gere outro)', async () => {
    expect((await recover({ secret: SECRET, username: 'chefe', password: NEW })).status).toBe(200);
    const again = await recover({ secret: SECRET, username: 'chefe', password: 'Mais-Uma-Senha-77' });
    expect(again.status).toBe(403);
    expect(again.json.error).toMatch(/já foi usado/);
    t.setEnv({ RECOVERY_SECRET: SECRET + '-novo' });
    expect(
      (await recover({ secret: SECRET + '-novo', username: 'chefe', password: 'Mais-Uma-Senha-77' })).status,
    ).toBe(200);
  });

  test('uso único também com dois pedidos SIMULTÂNEOS com o mesmo secret: só um redefine', async () => {
    const [a, b] = await Promise.all([
      recover({ secret: SECRET, username: 'chefe', password: 'Senha-Do-Pedido-A-1' }),
      recover({ secret: SECRET, username: 'chefe', password: 'Senha-Do-Pedido-B-2' }, '10.9.9.9'),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 403]);
    const ok = a.status === 200 ? 'Senha-Do-Pedido-A-1' : 'Senha-Do-Pedido-B-2';
    expect(await t.login('chefe', ok)).toBeTruthy();
  });

  test('recuperação zera os limites de tentativa do admin (rede e global), e não os de outro usuário', async () => {
    const { runInDurableObject } = await import('cloudflare:test');
    const net = '10.5.5.5';
    for (let i = 0; i < 5; i++) {
      await t.call('POST', '/login', {
        body: { username: 'chefe', password: 'errada-' + String(i) + 'x' },
        ip: net,
      });
      await t.call('POST', '/login', {
        body: { username: 'edu', password: 'errada-' + String(i) + 'x' },
        ip: net,
      });
    }
    for (let i = 0; i < 50; i++) {
      await t.call('POST', '/login', {
        body: { username: 'chefe', password: 'errada-errada' },
        ip: '198.51.100.' + String(i),
      });
    }
    expect(
      (await t.call('POST', '/login', { body: { username: 'chefe', password: PASS }, ip: net })).status,
    ).toBe(429);
    expect((await recover({ secret: SECRET, username: 'chefe', password: NEW })).status).toBe(200);
    const slow = await runInDurableObject(
      t.state,
      (_i, st) =>
        st.storage.sql.exec("SELECT COUNT(*) AS n FROM slow_limits WHERE key = 'login:g:chefe'").one().n,
    );
    expect(slow).toBe(0);
    expect(
      (await t.call('POST', '/login', { body: { username: 'chefe', password: NEW }, ip: net })).status,
    ).toBe(200);
    // o limite do outro usuário na mesma rede continua
    expect(
      (await t.call('POST', '/login', { body: { username: 'edu', password: PASS2 }, ip: net })).status,
    ).toBe(429);
  });

  test('só admin existente; política de senha; Origin estranha recusada', async () => {
    expect((await recover({ secret: SECRET, username: 'edu', password: NEW })).status).toBe(404);
    expect((await recover({ secret: SECRET, username: 'ninguem', password: NEW })).status).toBe(404);
    const weak = await recover({ secret: SECRET, username: 'chefe', password: 'chefe-123456' });
    expect(weak.status).toBe(422);
    const cors = await recover(
      { secret: SECRET, username: 'chefe', password: NEW },
      '10.7.7.7',
      'https://evil.example',
    );
    expect(cors.status).toBe(403);
    expect(cors.json.code).toBe('cors');
    expect(await t.login('chefe', PASS)).toBeTruthy();
  });

  test('força bruta: 5 segredos errados por IP bloqueiam (429), mesmo com o certo', async () => {
    for (let i = 0; i < 5; i++) await recover({ secret: 'x' + String(i), username: 'chefe', password: NEW });
    const r = await recover({ secret: SECRET, username: 'chefe', password: NEW });
    expect(r.status).toBe(429);
    expect((await recover({ secret: SECRET, username: 'chefe', password: NEW }, '10.8.8.8')).status).toBe(
      200,
    );
  });
});

describe('versão do pepper (pepper_id) e PASSWORD_PEPPER_PREV', () => {
  const A = 'pepper-antigo-com-mais-de-32-caracteres-aaaa';
  const B = 'pepper-novo-com-mais-de-32-caracteres-bbbbbbb';
  const pepperOf = (u: string) =>
    runInDurableObject(t.state, (_i, s) =>
      s.storage.sql.exec('SELECT pepper_id, hash FROM users WHERE username = ?', u).one(),
    );

  beforeEach(async () => {
    t = await makeApp({ PASSWORD_PEPPER: A, PASSWORD_PEPPER_ID: '1' });
    await t.addUser('ana', PASS, 'admin', { secret: A, id: 1 });
  });

  test('rotação: pepper novo + PREV; login com o antigo funciona e re-hasheia com o novo; depois tira o PREV', async () => {
    t.setEnv({
      PASSWORD_PEPPER: B,
      PASSWORD_PEPPER_ID: '2',
      PASSWORD_PEPPER_PREV: A,
      PASSWORD_PEPPER_PREV_ID: '1',
    });
    const before = await pepperOf('ana');
    expect(before.pepper_id).toBe(1);
    const tok = await t.login('ana', PASS);
    const after = await pepperOf('ana');
    expect(after.pepper_id).toBe(2);
    expect(after.hash).not.toBe(before.hash);
    const users = (await t.call('GET', '/users', { token: tok })).json.users as Record<string, unknown>[];
    expect(users[0]).toMatchObject({ username: 'ana', pepper_current: true });
    expect((await t.state.listAudit(5, null)).map((e) => e.action)).toContain('password_rehash');
    t.setEnv({ PASSWORD_PEPPER_PREV: '', PASSWORD_PEPPER_PREV_ID: '' });
    expect(await t.login('ana', PASS)).toBeTruthy();
    expect((await t.call('POST', '/login', { body: { username: 'ana', password: PASS2 } })).status).toBe(401);
  });

  test('usuário ainda no pepper antigo sem PREV configurado: não entra (precisa de redefinição)', async () => {
    t.setEnv({ PASSWORD_PEPPER: B, PASSWORD_PEPPER_ID: '2' });
    expect((await t.call('POST', '/login', { body: { username: 'ana', password: PASS } })).status).toBe(401);
    expect((await pepperOf('ana')).pepper_id).toBe(1);
  });

  test('linha antiga sem pepper_id (antes da migração) entra com o pepper atual e ganha o id', async () => {
    await runInDurableObject(t.state, (_i, s) => {
      s.storage.sql.exec('UPDATE users SET pepper_id = NULL');
    });
    expect(await t.login('ana', PASS)).toBeTruthy();
    expect((await pepperOf('ana')).pepper_id).toBe(1);
  });

  test('troca de senha e /users/password gravam o pepper atual', async () => {
    t.setEnv({
      PASSWORD_PEPPER: B,
      PASSWORD_PEPPER_ID: '2',
      PASSWORD_PEPPER_PREV: A,
      PASSWORD_PEPPER_PREV_ID: '1',
    });
    const tok = await t.login('ana', PASS);
    await t.addUser('edu', PASS, 'editor', { secret: A, id: 1 });
    const r = await t.call('POST', '/users/password', {
      token: tok,
      body: { currentPassword: PASS, username: 'edu', password: PASS2 },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await pepperOf('edu')).pepper_id).toBe(2);
    const users = (await t.call('GET', '/users', { token: tok })).json.users as Record<string, unknown>[];
    expect(users.map((u) => u.pepper_current)).toEqual([true, true]);
  });
});
