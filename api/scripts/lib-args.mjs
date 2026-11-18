/* Utilidades de linha de comando compartilhadas pelos scripts (sem dependências). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = path.resolve(API_DIR, '..');

/** Lê `--nome valor` de argv. */
export function opt(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
