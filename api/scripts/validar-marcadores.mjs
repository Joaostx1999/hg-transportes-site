#!/usr/bin/env node
/* Valida index.html contra cms/schema.json com o mesmo código do Worker (src/schema.ts).
 * Sai com código 1 se faltar marcador, houver duplicado, tipo diferente, marcador fora do esquema
 * ou marcador num lugar que a edição cirúrgica não trata com segurança.
 *
 *   node scripts/validar-marcadores.mjs [--index ../index.html] [--schema ../cms/schema.json] */
import fs from 'node:fs';
import path from 'node:path';
import { checkAgainstSchema, parseSchema, SchemaError } from '../src/schema.ts';
import { opt, REPO_DIR } from './lib-args.mjs';

const args = process.argv.slice(2);
const indexPath = path.resolve(opt(args, '--index', path.join(REPO_DIR, 'index.html')));
const schemaPath = path.resolve(opt(args, '--schema', path.join(REPO_DIR, 'cms', 'schema.json')));

function fail(msg) {
  console.error('Erro: ' + msg);
  process.exit(1);
}

let schema;
try {
  schema = parseSchema(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
} catch (e) {
  fail(schemaPath + ': ' + (e instanceof SchemaError || e instanceof SyntaxError ? e.message : String(e)));
}
const src = fs.readFileSync(indexPath, 'utf8');
// O painel lê este HTML com DOMParser sob a CSP dele (style-src sem 'unsafe-inline'): estilo inline vira
// erro de CSP no painel. CSS vai em assets/site.css; atraso de animação usa as classes d-NN.
const inlineStyle = /<style\b|<[a-z][^>]*\sstyle\s*=/i.exec(src);
if (inlineStyle) {
  const line = src.slice(0, inlineStyle.index).split('\n').length;
  fail(
    path.basename(indexPath) +
      ':' +
      line +
      ': estilo inline (<style> ou style="") não é permitido; use assets/site.css.',
  );
}
const problems = checkAgainstSchema(src, schema);
const keys = Object.keys(problems);
if (keys.length) {
  console.error('Erro: ' + keys.length + ' problema(s) entre ' + path.basename(indexPath) + ' e o esquema:');
  for (const k of keys) console.error('  ' + k + ': ' + problems[k]);
  process.exit(1);
}
console.log(
  'OK: ' + schema.fields.length + ' marcadores conferem com o esquema (versão ' + schema.version + ').',
);
