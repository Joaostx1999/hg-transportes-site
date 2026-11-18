/* Tipos do gerador do painel de dev (para os testes em TypeScript). */
export const PROD_SCRIPT_SRC: string;
export const DEV_SCRIPT_SRC: string;
export const DEV_CONNECT: string;
export function cspOf(html: string): string;
export function devIndex(html: string): string;
export function buildAdminDev(out?: string): string;
