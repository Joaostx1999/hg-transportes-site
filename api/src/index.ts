/* Entrada do Worker. O workerd só aceita exports que sejam handlers ou classes (Durable Object),
 * por isso o roteador e as constantes ficam em src/app.ts. */
import { handle } from './app.ts';
import type { Env } from './env.ts';

export { CmsState } from './state.ts';

export default {
  fetch(request, env) {
    return handle(request, env, {
      fetch: (input, init) => fetch(input, init),
      now: () => Date.now(),
      log: (line) => {
        console.log(line);
      },
    });
  },
} satisfies ExportedHandler<Env>;
