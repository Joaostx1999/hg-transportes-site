/* O módulo de entrada (src/index.ts) roda pelo caminho real do Worker. O workerd recusa subir quando o
 * módulo principal exporta algo que não é handler nem classe (pego no smoke com wrangler dev). */
import { exports } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import * as entry from '../../src/index.ts';

describe('entrada do Worker', () => {
  test('só exporta handlers e classes (exigência do workerd)', () => {
    for (const [name, value] of Object.entries(entry)) {
      const ok =
        typeof value === 'function' ||
        (typeof value === 'object' && typeof (value as { fetch?: unknown }).fetch === 'function');
      expect(ok, 'export ' + name).toBe(true);
    }
    expect(Object.keys(entry).sort()).toEqual(['CmsState', 'default']);
  });

  test('GET /health pelo fetch real do Worker, com cabeçalhos de segurança', async () => {
    const r = await exports.default.fetch('https://api.test/health');
    expect(r.status).toBe(200);
    const j = await r.json<{ ok: boolean; version: string; time: string }>();
    expect(j.ok).toBe(true);
    expect(j.version).toBe('3.0.0');
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const cors = await exports.default.fetch('https://api.test/me', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(cors.status).toBe(403);
  });
});
