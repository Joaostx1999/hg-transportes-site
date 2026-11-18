#!/usr/bin/env node
/* Gera cms/schema.json a partir dos marcadores data-cms do index.html, com o MESMO código de extração
 * do Worker (src/schema.ts, executado direto pelo Node >= 22.18 com remoção de tipos nativa).
 *
 *   node scripts/gerar-schema.mjs [--index ../index.html] [--out ../cms/schema.json] [--check]
 *
 * --check: não escreve; sai com 1 se o arquivo atual difere do que seria gerado. */
import fs from 'node:fs';
import path from 'node:path';
import { buildSchema, checkAgainstSchema, serializeSchema } from '../src/schema.ts';
import { opt, REPO_DIR } from './lib-args.mjs';

const args = process.argv.slice(2);
const indexPath = path.resolve(opt(args, '--index', path.join(REPO_DIR, 'index.html')));
const outPath = path.resolve(opt(args, '--out', path.join(REPO_DIR, 'cms', 'schema.json')));

const src = fs.readFileSync(indexPath, 'utf8');
const schema = buildSchema(src, path.basename(indexPath));
const problems = checkAgainstSchema(src, schema);
if (Object.keys(problems).length) {
  console.error('Erro: o HTML tem marcadores que a edição não trata com segurança:');
  for (const [k, m] of Object.entries(problems)) console.error('  ' + k + ': ' + m);
  process.exit(1);
}
const text = serializeSchema(schema);
if (args.includes('--check')) {
  const cur = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  if (cur !== text) {
    console.error('Erro: ' + outPath + ' está desatualizado. Rode: npm run gerar-schema');
    process.exit(1);
  }
  console.log('OK: esquema em dia (' + schema.fields.length + ' campos).');
} else {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text);
  console.log('Esquema gerado: ' + outPath + ' (' + schema.fields.length + ' campos).');
}
