#!/usr/bin/env node
/* S6: o admin/index.html versionado tem a CSP de PRODUÇÃO (sem 127.0.0.1). Para o ambiente local, este
 * script monta api/.dev-admin/ (fora do git): index.html com a CSP de dev e links simbólicos para os outros
 * arquivos do admin/ (editar admin.js/admin.css vale na hora; editou o index.html, rode de novo ou reinicie o
 * dev/start-dev.sh, que chama este script). A troca é estrita: se a CSP de produção não tiver o formato
 * esperado, ou já tiver host local, falha (assim produção nunca fica com a CSP de dev).
 *
 *   node dev/build-admin-dev.mjs            # gera api/.dev-admin
 * Dev: script-src http://127.0.0.1:8781/admin/ e http://localhost:8781/admin/ (mesma restrição por caminho
 * de produção) e connect-src + http://127.0.0.1:8787 (Worker local). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(HERE, '..');
const ADMIN = path.resolve(API_DIR, '..', 'admin');
export const PROD_SCRIPT_SRC = 'https://joaostx1999.github.io/hg-transportes-site/admin/';
export const DEV_SCRIPT_SRC = 'http://127.0.0.1:8781/admin/ http://localhost:8781/admin/';
export const DEV_CONNECT = 'http://127.0.0.1:8787';
const META_RE = /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/;

/** CSP do index.html (string). Lança se não houver exatamente uma. */
export function cspOf(html) {
  const all = html.match(new RegExp(META_RE.source, 'g')) ?? [];
  if (all.length !== 1) throw new Error('esperava 1 meta CSP no admin/index.html, achei ' + all.length);
  return META_RE.exec(html)[2];
}

/** index.html de produção -> index.html de dev. */
export function devIndex(html) {
  const csp = cspOf(html);
  if (/127\.0\.0\.1|localhost|http:\/\//.test(csp))
    throw new Error('a CSP de produção do admin/index.html tem host local ou http: ' + csp);
  if (!csp.includes('script-src ' + PROD_SCRIPT_SRC + ' '))
    throw new Error('script-src de produção diferente do esperado (' + PROD_SCRIPT_SRC + '): ' + csp);
  if (!/connect-src [^;]+/.test(csp)) throw new Error('CSP sem connect-src: ' + csp);
  const dev = csp
    .replace('script-src ' + PROD_SCRIPT_SRC, 'script-src ' + DEV_SCRIPT_SRC)
    .replace(/connect-src ([^;]+)/, (_all, v) => 'connect-src ' + v + ' ' + DEV_CONNECT);
  return html
    .replace(META_RE, (_all, a, _b, c) => a + dev + c)
    .replace(
      '<head>',
      '<head>\n<!-- GERADO por api/dev/build-admin-dev.mjs para o ambiente LOCAL (CSP de dev). Não publique. -->',
    );
}

export function buildAdminDev(out = path.join(API_DIR, '.dev-admin')) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(ADMIN)) {
    if (f === 'index.html') continue;
    fs.symlinkSync(path.relative(out, path.join(ADMIN, f)), path.join(out, f));
  }
  fs.writeFileSync(
    path.join(out, 'index.html'),
    devIndex(fs.readFileSync(path.join(ADMIN, 'index.html'), 'utf8')),
  );
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('Painel de dev em ' + path.relative(process.cwd(), buildAdminDev()) + ' (CSP local).');
}
