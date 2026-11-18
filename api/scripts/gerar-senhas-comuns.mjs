#!/usr/bin/env node
/* Gera src/senhas-comuns.ts (S7): as N senhas mais comuns de uma lista ranqueada de senhas vazadas, já
 * normalizadas como o passwordPolicy compara (minúsculas, só letras e números), sem repetição. O Worker não
 * baixa nada: a lista vai embutida no código.
 *
 *   node scripts/gerar-senhas-comuns.mjs --from <lista.txt> [--top 10000] [--out src/senhas-comuns.ts]
 *
 * Fonte usada na versão versionada: a lista "passwords" do zxcvbn (Dropbox, licença MIT; ranqueada a partir
 * de vazamentos públicos, ex.: Xato 10M), 30 mil linhas, uma senha por linha, da mais comum para a menos.
 * A mesma lista vem no componente ZxcvbnData do Chrome (passwords.txt). */
import fs from 'node:fs';
import path from 'node:path';
import { API_DIR, opt } from './lib-args.mjs';

const args = process.argv.slice(2);
const from = opt(args, '--from');
const top = Number.parseInt(opt(args, '--top') ?? '10000', 10);
if (!from || !Number.isInteger(top) || top < 1) {
  console.error('Uso: node scripts/gerar-senhas-comuns.mjs --from <lista.txt> [--top 10000]');
  process.exit(2);
}
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const seen = new Set();
const out = [];
for (const line of fs.readFileSync(from, 'utf8').split(/\r?\n/)) {
  if (out.length >= top) break;
  const s = squash(line.trim());
  if (s.length < 4 || seen.has(s)) continue;
  seen.add(s);
  out.push(s);
}
const file = path.resolve(opt(args, '--out') ?? path.join(API_DIR, 'src', 'senhas-comuns.ts'));
const body =
  '/* GERADO por scripts/gerar-senhas-comuns.mjs (não edite à mão). ' +
  out.length +
  ' senhas vazadas mais comuns, normalizadas\n' +
  ' * (minúsculas, só [a-z0-9]), na ordem de frequência. Fonte: lista "passwords" do zxcvbn (Dropbox, MIT). */\n' +
  '// prettier-ignore\n' +
  'export const LEAKED_PASSWORDS = ' +
  JSON.stringify(out.join('\n')) +
  ';\n';
fs.writeFileSync(file, body);
console.log('Gerado ' + path.relative(process.cwd(), file) + ': ' + out.length + ' senhas.');
