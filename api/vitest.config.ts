/* Dois projetos: "workers" roda no runtime real do Workers (workerd via @cloudflare/vitest-plugin, com o
 * Durable Object e os bindings do wrangler.toml); "node" testa o mock git do dev, os scripts e o workflow. */
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.toml' },
            miniflare: {
              // valores fixos de teste: sobrepõem o api/.dev.vars (que o plugin também lê) para o resultado não
              // depender da máquina. Segredos opcionais ficam vazios; cada teste liga o que precisa.
              bindings: {
                GITHUB_TOKEN: 'dev-token',
                GITHUB_API_BASE: 'https://api.github.com',
                DEV_ALLOW_LOCAL_GITHUB: '',
                PASSWORD_PEPPER: 'pepper-de-teste-com-mais-de-32-caracteres',
                PASSWORD_PEPPER_ID: '1',
                PASSWORD_PEPPER_PREV: '',
                PASSWORD_PEPPER_PREV_ID: '',
                BOOTSTRAP_SECRET: '',
                RECOVERY_SECRET: '',
                TURNSTILE_SECRET: '',
                ALLOWED_ORIGINS: 'http://127.0.0.1:8781,http://localhost:8781',
              },
            },
          }),
        ],
        server: { fs: { allow: ['..'] } },
        test: {
          name: 'workers',
          include: ['test/worker/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/node/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
