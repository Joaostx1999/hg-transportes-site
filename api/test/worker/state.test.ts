/* Durable Object CmsState direto (RPC), sem passar pelo roteador. */
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, test } from 'vitest';
import { AUDIT_RETENTION_MS, RATE, SESSION_TOUCH_MS, type UserRecord } from '../../src/state.ts';
import { START } from './helpers.ts';

const stub = () => env.CMS_STATE.get(env.CMS_STATE.idFromName('global'));
const user = (username: string, role: 'admin' | 'editor' = 'admin'): UserRecord => ({
  username,
  role,
  salt: 's',
  hash: 'h',
  iterations: 100000,
  created_at: START,
  last_login_at: null,
  password_changed_at: START,
  pepper_id: 1,
});

beforeEach(async () => {
  await reset();
});

describe('CmsState', () => {
  test('bootstrap atômico: dois pedidos simultâneos com o DO vazio criam um admin só', async () => {
    const s = stub();
    const r = await Promise.all([s.createUser(user('a1'), true), s.createUser(user('a2'), true)]);
    expect(r.sort()).toEqual(['not_empty', 'ok']);
    expect(await s.userCount()).toBe(1);
  });

  test('rate limit: reserva antes de verificar, janela de 15 min, bloqueio de 15 min', async () => {
    const s = stub();
    const rules = [{ key: 'k:u', max: RATE.userMax }];
    for (let i = 0; i < 5; i++) {
      expect(await s.rateAcquire(rules, START)).toEqual({ ok: true });
      await s.rateFinish(rules, false, START);
    }
    const blocked = await s.rateAcquire(rules, START + 1000);
    expect(blocked).toEqual({ ok: false, retryAfter: 15 * 60 - 1 });
    expect((await s.rateAcquire(rules, START + RATE.blockMs + 1)).ok).toBe(true);
  });

  test('falhas espalhadas além da janela não acumulam', async () => {
    const s = stub();
    const rules = [{ key: 'k:w', max: 2 }];
    for (let i = 0; i < 6; i++) {
      const at = START + i * (RATE.windowMs + 1);
      expect((await s.rateAcquire(rules, at)).ok, 'passo ' + String(i)).toBe(true);
      await s.rateFinish(rules, false, at);
    }
  });

  test('limpeza: sessão vencida e auditoria com mais de 365 dias são apagadas na operação seguinte', async () => {
    const s = stub();
    await s.createUser(user('ana'), false);
    await s.createSession('a'.repeat(64), 'ana', START, '1.1.1.1', null);
    await s.audit({ ts: START, username: 'ana', ip: null, action: 'velha' });
    const later = START + AUDIT_RETENTION_MS + 1;
    await s.createSession('b'.repeat(64), 'ana', later, '1.1.1.1', null);
    const rows = await runInDurableObject(s, (_i, st) => ({
      sessions: st.storage.sql
        .exec('SELECT token_hash FROM sessions')
        .toArray()
        .map((r) => r.token_hash),
      audit: st.storage.sql.exec('SELECT action FROM audit').toArray().length,
    }));
    expect(rows).toEqual({ sessions: ['b'.repeat(64)], audit: 0 });
  });

  test('touchSession: inatividade e tempo absoluto; renova last_seen', async () => {
    const s = stub();
    await s.createUser(user('ana', 'editor'), false);
    await s.createSession('c'.repeat(64), 'ana', START, '1.1.1.1', null);
    expect(await s.touchSession('c'.repeat(64), START + 3599_000)).toEqual({
      username: 'ana',
      role: 'editor',
    });
    expect(await s.touchSession('c'.repeat(64), START + 2 * 3599_000)).not.toBeNull();
    expect(await s.touchSession('c'.repeat(64), START + 3 * 3599_000 + 2000)).toBeNull();
    expect(await s.touchSession('nada', START)).toBeNull();
  });

  test('C7: setMeta só grava quando o valor muda (o DO não escreve a cada GET)', async () => {
    const s = stub();
    expect(await s.setMeta('k', 'v1')).toBe(true);
    expect(await s.setMeta('k', 'v1')).toBe(false);
    expect(await s.setMeta('k', 'v2')).toBe(true);
    expect(await s.getMeta('k')).toBe('v2');
  });

  test('C7: touchSession só regrava last_seen depois de SESSION_TOUCH_MS (60 s)', async () => {
    const s = stub();
    await s.createUser(user('ana'), false);
    await s.createSession('d'.repeat(64), 'ana', START, '1.1.1.1', null);
    const seen = () =>
      runInDurableObject(s, (_i, st) =>
        Number(st.storage.sql.exec('SELECT last_seen FROM sessions').one().last_seen),
      );
    expect(SESSION_TOUCH_MS).toBe(60_000);
    await s.touchSession('d'.repeat(64), START + 30_000);
    expect(await seen()).toBe(START);
    await s.touchSession('d'.repeat(64), START + 60_000);
    expect(await seen()).toBe(START + 60_000);
  });

  test('setPassword mantém só a sessão indicada', async () => {
    const s = stub();
    await s.createUser(user('ana'), false);
    for (const h of ['1', '2', '3']) await s.createSession(h.repeat(64), 'ana', START, 'x', null);
    const r = await s.setPassword(
      'ana',
      { salt: 'n', hash: 'n', iterations: 100000, pepper_id: 1 },
      START,
      '2'.repeat(64),
    );
    expect(r).toEqual({ ok: true, sessionsRevoked: 2 });
    expect(await s.sessionCount('ana')).toBe(1);
    expect(await s.touchSession('2'.repeat(64), START)).not.toBeNull();
  });
});
