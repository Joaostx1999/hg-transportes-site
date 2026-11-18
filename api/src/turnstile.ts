/* Cloudflare Turnstile (opcional): só é exigido quando o secret TURNSTILE_SECRET existe. fetch injetável. */
import type { FetchLike } from './github.ts';
import { isRecord } from './util.ts';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type TurnstileResult = 'ok' | 'invalid' | 'unavailable';

export async function verifyTurnstile(
  fetchImpl: FetchLike,
  secret: string,
  token: string,
  remoteip: string,
): Promise<TurnstileResult> {
  const form = new URLSearchParams({ secret, response: token, remoteip });
  let res: Response;
  try {
    res = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch {
    return 'unavailable';
  }
  if (!res.ok) return 'unavailable';
  let j: unknown;
  try {
    j = await res.json();
  } catch {
    return 'unavailable';
  }
  return isRecord(j) && j.success === true ? 'ok' : 'invalid';
}
