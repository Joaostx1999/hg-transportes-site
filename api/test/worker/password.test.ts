import { describe, expect, test } from 'vitest';
import {
  hashPassword,
  pbkdf2,
  PBKDF2_MAX_ITERATIONS,
  PepperError,
  verifyPassword,
  type PasswordHash,
} from '../../src/password.ts';
import { b64ToBytes, bytesToB64, timingSafeEqual, utf8 } from '../../src/util.ts';

const PEPPER = 'pepper-de-teste-com-mais-de-32-caracteres';
const PW = 'Cegonha-Azul-2026';

async function tryDerive(iterations: number): Promise<'aceito' | 'recusado'> {
  const key = await crypto.subtle.importKey('raw', utf8('x'), 'PBKDF2', false, ['deriveBits']);
  try {
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(16), iterations },
      key,
      256,
    );
    return 'aceito';
  } catch {
    return 'recusado';
  }
}

describe('PBKDF2 + pepper', () => {
  test('hash: sal de 16 bytes por usuário, 32 bytes, 100000 iterações', async () => {
    const a = await hashPassword(PW, PEPPER);
    const b = await hashPassword(PW, PEPPER);
    expect(a.iterations).toBe(100000);
    expect(PBKDF2_MAX_ITERATIONS).toBe(100000);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(b64ToBytes(a.salt)).toHaveLength(16);
    expect(b64ToBytes(a.hash)).toHaveLength(32);
    expect(await verifyPassword(PW, PEPPER, a)).toBe(true);
    expect(await verifyPassword(PW + 'x', PEPPER, a)).toBe(false);
    expect(await verifyPassword(PW, PEPPER, null)).toBe(false);
  });

  test('o pepper entra no cálculo: sem ele (ou com outro) a senha não confere', async () => {
    const h = await hashPassword(PW, PEPPER);
    expect(await verifyPassword(PW, PEPPER.replace('a', 'b'), h)).toBe(false);
    const plain = await pbkdf2(utf8(PW), b64ToBytes(h.salt), h.iterations);
    expect(timingSafeEqual(plain, b64ToBytes(h.hash))).toBe(false);
    const key = await crypto.subtle.importKey('raw', utf8(PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(PW)));
    expect(bytesToB64(await pbkdf2(mac, b64ToBytes(h.salt), h.iterations))).toBe(h.hash);
  });

  test('pepper ausente ou curto: recusa (falha fechada)', async () => {
    await expect(hashPassword(PW, undefined)).rejects.toBeInstanceOf(PepperError);
    await expect(hashPassword(PW, 'curto')).rejects.toBeInstanceOf(PepperError);
    await expect(verifyPassword(PW, '', null)).rejects.toBeInstanceOf(PepperError);
  });

  test('iterações: o código nunca passa de 100000; registro adulterado não derruba o login', async () => {
    expect((await hashPassword(PW, PEPPER, 500000)).iterations).toBe(100000);
    expect((await hashPassword(PW, PEPPER, 5)).iterations).toBe(100000);
    const h = await hashPassword(PW, PEPPER);
    const broken: PasswordHash = { ...h, iterations: 0 };
    expect(await verifyPassword(PW, PEPPER, broken)).toBe(false);
  });

  test('limite do runtime: 100000 funciona no workerd', async () => {
    expect(await tryDerive(100000)).toBe('aceito');
  });

  test('medição do workerd LOCAL: o teto de produção (100000) não está ativo aqui', async () => {
    // O binário do workerd contém "Pbkdf2 failed: iteration counts above <max> are not supported", mas o
    // teto só é aplicado na plataforma da Cloudflare. Localmente (workerd 1.20261103.1) 100001 e 1.000.000
    // passam. Por isso o código fixa 100000 (PBKDF2_MAX_ITERATIONS): funciona em produção e aqui.
    // Se este teste falhar, o workerd local passou a aplicar o teto: confira o valor e ajuste o comentário.
    expect(await tryDerive(100001)).toBe('aceito');
  });
});

describe('tempo constante', () => {
  test('timingSafeEqual', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true);
  });
});
