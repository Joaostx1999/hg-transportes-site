/* Senhas: HMAC-SHA256(PASSWORD_PEPPER, senha) -> PBKDF2-SHA256 (sal de 16 bytes por usuário, 32 bytes).
 * O pepper fica só no secret do Worker: um vazamento do banco (DO) sozinho não permite testar senhas.
 * Iterações guardadas por usuário (permite subir no futuro). Teto do runtime medido em teste. */
import { b64ToBytes, bytesToB64, randomBytes, timingSafeEqual, utf8 } from './util.ts';

/** Teto do PBKDF2 no WebCrypto do Workers (test/worker/password.test.ts prova 100000 ok e 100001 falha). */
export const PBKDF2_MAX_ITERATIONS = 100_000;
export const PEPPER_MIN_LENGTH = 32;

export interface PasswordHash {
  salt: string;
  hash: string;
  iterations: number;
}

export class PepperError extends Error {
  constructor() {
    super('PASSWORD_PEPPER ausente ou curto demais');
    this.name = 'PepperError';
  }
}

function assertPepper(pepper: string | undefined): asserts pepper is string {
  if (!pepper || pepper.length < PEPPER_MIN_LENGTH) throw new PepperError();
}

async function peppered(pepper: string, password: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', utf8(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(password)));
}

export async function pbkdf2(
  material: Uint8Array,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export function clampIterations(n: number): number {
  if (!Number.isInteger(n) || n < 10_000) return PBKDF2_MAX_ITERATIONS;
  return Math.min(n, PBKDF2_MAX_ITERATIONS);
}

export async function hashPassword(
  password: string,
  pepper: string | undefined,
  iterations: number = PBKDF2_MAX_ITERATIONS,
): Promise<PasswordHash> {
  assertPepper(pepper);
  const it = clampIterations(iterations);
  const salt = randomBytes(16);
  const hash = await pbkdf2(await peppered(pepper, password), salt, it);
  return { salt: bytesToB64(salt), hash: bytesToB64(hash), iterations: it };
}

const DUMMY: PasswordHash = {
  salt: 'aGctY21zLWR1bW15LXNhbA==',
  hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  iterations: PBKDF2_MAX_ITERATIONS,
};

/** Verifica em tempo constante. Sem registro, roda PBKDF2 contra um sal fixo para igualar o tempo. */
export async function verifyPassword(
  password: string,
  pepper: string | undefined,
  rec: PasswordHash | null,
): Promise<boolean> {
  assertPepper(pepper);
  const r = rec ?? DUMMY;
  let got: Uint8Array;
  try {
    got = await pbkdf2(await peppered(pepper, password), b64ToBytes(r.salt), r.iterations);
  } catch {
    return false; // ex.: iterações acima do teto do runtime num registro adulterado
  }
  const ok = timingSafeEqual(got, b64ToBytes(r.hash));
  return ok && rec !== null;
}
