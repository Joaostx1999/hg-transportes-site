/* Apoio dos testes de rota: Worker real (handle) + Durable Object real (binding do wrangler.toml) +
 * GitHub falso em memória + relógio e log capturáveis. */
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import INDEX from '../../../index.html?raw';
import SCHEMA from '../../../cms/schema.json?raw';
import { handle, type Deps } from '../../src/app.ts';
import type { Env } from '../../src/env.ts';
import { hashPassword } from '../../src/password.ts';
import type { Role } from '../../src/validate.ts';
import { FakeGitHub } from './fake-github.ts';

export { INDEX, SCHEMA };
export const ORIGIN = 'http://127.0.0.1:8781';
export const PASS = 'Cegonha-Azul-2026';
export const PASS2 = 'Outra-Senha-Forte-77';
export const START = Date.parse('2026-11-17T12:00:00Z');

/* Fotos mínimas, mas estruturalmente válidas (o servidor percorre os segmentos/chunks para tirar metadados). */
export function u32be(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
export function u32le(n: number): number[] {
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
}
const ascii = (s: string): number[] => [...new TextEncoder().encode(s)];
function crc32(bytes: number[]): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
/** Segmento JPEG (marcador 0xFFxx + tamanho de 2 bytes que inclui o próprio tamanho). */
export function jpegSeg(marker: number, payload: number[]): number[] {
  const n = payload.length + 2;
  return [0xff, marker, (n >> 8) & 255, n & 255, ...payload];
}
export const JPEG_APP0 = jpegSeg(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
export const JPEG_SOS = jpegSeg(0xda, [1, 1, 0, 0, 0x3f, 0]);
/** dados comprimidos com byte 0xFF "escapado" (FF 00) e um marcador de reinício (FF D0) */
export const JPEG_SCAN = [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78];
export const JPG = new Uint8Array([0xff, 0xd8, ...JPEG_APP0, ...JPEG_SOS, ...JPEG_SCAN, 0xff, 0xd9]);
export function pngChunk(type: string, data: number[]): number[] {
  const td = [...ascii(type), ...data];
  return [...u32be(data.length), ...td, ...u32be(crc32(td))];
}
export const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const PNG_IHDR = pngChunk('IHDR', [...u32be(1), ...u32be(1), 8, 2, 0, 0, 0]);
export const PNG_IDAT = pngChunk('IDAT', [0x78, 0x9c, 0x63, 0xf8, 0x0f, 0x00, 0x01, 0x01, 0x01, 0x00]);
export const PNG_IEND = pngChunk('IEND', []);
export const PNG = new Uint8Array([...PNG_SIG, ...PNG_IHDR, ...PNG_IDAT, ...PNG_IEND]);
export function webp(chunks: number[][]): Uint8Array {
  const body = [...ascii('WEBP'), ...chunks.flat()];
  return new Uint8Array([...ascii('RIFF'), ...u32le(body.length), ...body]);
}
export function riffChunk(type: string, data: number[]): number[] {
  return [...ascii(type), ...u32le(data.length), ...data, ...(data.length % 2 ? [0] : [])];
}
export const WEBP = webp([riffChunk('VP8L', [0x2f, 0, 0, 0, 0])]);

export interface CallOpts {
  body?: unknown;
  raw?: BodyInit;
  token?: string;
  origin?: string | null;
  ip?: string;
  headers?: Record<string, string>;
}

export interface CallResult {
  status: number;
  headers: Headers;
  json: Record<string, unknown> & {
    ok?: boolean;
    code?: string;
    error?: string;
    fields?: Record<string, string>;
  };
}

export type ExtraFetch = (url: string, init?: RequestInit) => Promise<Response> | null;

export async function makeApp(envExtra: Partial<Env> = {}) {
  await reset();
  const gh = await FakeGitHub.create({
    'index.html': INDEX,
    'cms/schema.json': SCHEMA,
    'assets/fotos/frota-patio.jpg': JPG,
  });
  const clock = { t: START };
  const logs: string[] = [];
  let extra: ExtraFetch | null = null;
  const deps: Deps = {
    fetch: (input, init) => {
      const r = extra?.(input, init);
      if (r) return r;
      if (input.startsWith('https://api.github.com/')) return gh.fetch(input, init);
      // mock local (só com DEV_ALLOW_LOCAL_GITHUB=1): o mesmo GitHub falso
      if (input.startsWith('http://127.0.0.1:8788/'))
        return gh.fetch(input.replace('http://127.0.0.1:8788', 'https://api.github.com'), init);
      return Promise.reject(new Error('fetch inesperado: ' + input));
    },
    now: () => clock.t,
    log: (l) => logs.push(l),
  };
  const testEnv: Env = { ...env, ...envExtra };
  const state = testEnv.CMS_STATE.get(testEnv.CMS_STATE.idFromName('global'));

  async function call(method: string, path: string, o: CallOpts = {}): Promise<CallResult> {
    const headers = new Headers(o.headers ?? {});
    if (o.origin !== null) headers.set('Origin', o.origin ?? ORIGIN);
    if (o.token) headers.set('Authorization', 'Bearer ' + o.token);
    if (o.ip) headers.set('CF-Connecting-IP', o.ip);
    let body: BodyInit | undefined;
    if (o.raw !== undefined) body = o.raw;
    else if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers.set('Content-Type', 'application/json');
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body;
    const res = await handle(new Request('https://api.test' + path, init), testEnv, deps);
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      json: (text ? JSON.parse(text) : {}) as CallResult['json'],
    };
  }

  async function addUser(
    username: string,
    password: string,
    role: Role = 'admin',
    pepper: { secret?: string; id?: number } = {},
  ): Promise<void> {
    const h = await hashPassword(password, pepper.secret ?? testEnv.PASSWORD_PEPPER, 100000);
    const r = await state.createUser(
      {
        username,
        role,
        ...h,
        pepper_id: pepper.id ?? 1,
        created_at: clock.t,
        last_login_at: null,
        password_changed_at: clock.t,
      },
      false,
    );
    if (r !== 'ok') throw new Error('addUser ' + r);
  }

  async function login(username: string, password: string, o: CallOpts = {}): Promise<string> {
    const r = await call('POST', '/login', { ...o, body: { username, password } });
    if (r.status !== 200) throw new Error('login falhou: ' + JSON.stringify(r.json));
    return String(r.json.token);
  }

  async function content(token: string): Promise<{ html: string; commit: string }> {
    const r = await call('GET', '/content', { token });
    return { html: String(r.json.html), commit: String(r.json.commit) };
  }

  return {
    gh,
    clock,
    logs,
    env: testEnv,
    state,
    call,
    addUser,
    login,
    content,
    advance: (s: number) => {
      clock.t += s * 1000;
    },
    setExtraFetch: (f: ExtraFetch | null) => {
      extra = f;
    },
    /** troca variáveis/segredos do Worker sem apagar o estado do DO (ex.: rotação do pepper) */
    setEnv: (e: Partial<Env>) => {
      Object.assign(testEnv, e);
    },
  };
}

export type App = Awaited<ReturnType<typeof makeApp>>;

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Primeira e última posição em que a e b diferem. */
export function diffRange(a: string, b: string): { start: number; endA: number; endB: number } {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let ea = a.length;
  let eb = b.length;
  while (ea > i && eb > i && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  return { start: i, endA: ea, endB: eb };
}
