/* Erros tipados, respostas JSON com cabeçalhos de segurança e leitura de corpo com limite. */
import { decodeUtf8Strict, isRecord } from './util.ts';

export const STATUS = {
  unauthenticated: 401,
  session_expired: 401,
  invalid_credentials: 401,
  forbidden: 403,
  cors: 403,
  rate_limited: 429,
  validation: 422,
  conflict: 409,
  schema_mismatch: 409,
  integrity: 422,
  not_found: 404,
  bad_request: 400,
  too_large: 413,
  server: 500,
  upstream: 502,
  method: 405,
} as const;

export type ErrorCode = keyof typeof STATUS;
export type FieldErrors = Record<string, string>;

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields: FieldErrors | undefined;
  readonly headers: Record<string, string> | undefined;
  constructor(code: ErrorCode, message: string, fields?: FieldErrors, headers?: Record<string, string>) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = STATUS[code];
    this.fields = fields && Object.keys(fields).length ? fields : undefined;
    this.headers = headers;
  }
}

export const MSG = {
  badLogin: 'Usuário ou senha incorretos.',
  rate: 'Muitas tentativas. Tente de novo em alguns minutos.',
  conflict: 'O site foi alterado por outra pessoa. Recarregue o painel.',
  forbidden: 'Você não tem permissão para fazer isso.',
  review: 'Revise os campos marcados.',
  server: 'Erro interno. Tente de novo.',
  upstream: 'O GitHub não respondeu como esperado. Tente de novo em instantes.',
  expired: 'Sua sessão expirou. Entre de novo.',
  noChange: 'Nenhuma alteração.',
  tooLarge: 'Envio grande demais.',
  schema:
    'O site publicado não confere com o esquema de campos do painel. Publicação recusada; avise o suporte.',
  integrity:
    'Não foi possível aplicar esta alteração com segurança. Nada foi publicado; avise o suporte com o nome do campo.',
} as const;

/** Cabeçalhos presentes em TODA resposta (sucesso, erro, preflight e recusa de CORS). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export function respond(
  status: number,
  body: unknown,
  origin: string | null,
  extra?: Record<string, string>,
): Response {
  const h = new Headers(SECURITY_HEADERS);
  h.set('Vary', 'Origin');
  if (origin) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Access-Control-Expose-Headers', 'Retry-After');
  }
  if (extra) for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: h });
}

export function errorBody(e: HttpError): Record<string, unknown> {
  const b: Record<string, unknown> = { ok: false, error: e.message, code: e.code };
  if (e.fields) b.fields = e.fields;
  return b;
}

/** Lê o corpo inteiro, abortando assim que passar de `max` bytes (não confia só no Content-Length). */
export async function readBytes(request: Request, max: number): Promise<Uint8Array> {
  const declared = Number.parseInt(request.headers.get('Content-Length') ?? '', 10);
  if (Number.isFinite(declared) && declared > max) throw new HttpError('too_large', MSG.tooLarge);
  if (!request.body) return new Uint8Array(0);
  // o tipo global de Request.body varia entre runtimes (workerd x Node); aqui é sempre bytes
  const reader = request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError('too_large', MSG.tooLarge);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** Corpo JSON (objeto). Corpo vazio = {}. Exige Content-Type application/json quando há corpo. */
export async function readJson(request: Request, max: number): Promise<Record<string, unknown>> {
  const bytes = await readBytes(request, max);
  if (!bytes.length) return {};
  const ct = (request.headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (ct !== 'application/json') throw new HttpError('bad_request', 'Envie os dados em JSON.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8Strict(bytes));
  } catch {
    throw new HttpError('bad_request', 'JSON inválido.');
  }
  if (!isRecord(parsed)) throw new HttpError('bad_request', 'JSON inválido.');
  return parsed;
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
