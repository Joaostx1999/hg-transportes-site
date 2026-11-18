/* Logs estruturados (uma linha JSON). Só campos de uma lista fechada: nunca senha, token, pepper,
 * conteúdo de campo ou corpo de pedido. */
export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  event: string;
  route?: string;
  method?: string;
  status?: number;
  ms?: number;
  user?: string;
  code?: string;
  attempts?: number;
  changed?: number;
  error?: string;
}

export type Logger = (line: string) => void;

const ALLOWED: readonly (keyof LogEntry)[] = [
  'level',
  'event',
  'route',
  'method',
  'status',
  'ms',
  'user',
  'code',
  'attempts',
  'changed',
  'error',
];

export function logLine(e: LogEntry): string {
  const out: Record<string, unknown> = {};
  for (const k of ALLOWED) if (e[k] !== undefined) out[k] = e[k];
  return JSON.stringify(out);
}
