#!/usr/bin/env node
/* Cria o PRIMEIRO usuário (admin) do painel chamando POST /bootstrap do Worker. Os demais usuários são
 * criados pelo próprio painel (aba Usuários, só admin). O /bootstrap só funciona com BOOTSTRAP_SECRET
 * configurado e enquanto não existe nenhum usuário; depois responde sempre 403.
 *
 *   node scripts/criar-usuario.mjs <usuario>                         # local: http://127.0.0.1:8787
 *   node scripts/criar-usuario.mjs <usuario> --url https://hg-cms-api.<sub>.workers.dev
 *
 * Senha: HG_SENHA, ou --senha-stdin (lê da entrada padrão), ou digitada (oculta) no terminal.
 * Segredo: HG_BOOTSTRAP_SECRET; em URL local, se não definido, lê BOOTSTRAP_SECRET de api/.dev.vars.
 *
 * Recuperação de admin (ninguém consegue entrar), via POST /recover com o RECOVERY_SECRET efêmero:
 *   HG_RECOVERY_SECRET='...' node scripts/criar-usuario.mjs <admin> --recuperar --url https://...
 * Redefine a senha de um admin que já existe; o secret vale uma vez. Apague-o do Worker logo depois.
 * Mesma política de senha do Worker (src/validate.ts, executado direto pelo Node >= 22.18). */
import fs from 'node:fs';
import path from 'node:path';
import { normUsername, passwordPolicy, validUsername, MSG_USERNAME } from '../src/validate.ts';
import { API_DIR, opt } from './lib-args.mjs';

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && !['--url'].includes(args[i - 1] ?? ''));

function die(msg) {
  console.error('Erro: ' + msg);
  process.exit(1);
}

function isLocal(u) {
  return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
}

function devVar(name) {
  const f = path.join(API_DIR, '.dev.vars');
  if (!fs.existsSync(f)) return '';
  const line = fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(name + '='));
  return line ? line.slice(name.length + 1).trim() : '';
}

async function readPassword() {
  if (process.env.HG_SENHA) return process.env.HG_SENHA;
  if (args.includes('--senha-stdin')) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  }
  if (!process.stdin.isTTY) die('defina HG_SENHA, use --senha-stdin ou rode num terminal interativo.');
  const ask = (q) =>
    new Promise((resolve) => {
      process.stdout.write(q);
      const stdin = process.stdin;
      let s = '';
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      const on = (ch) => {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', on);
          process.stdout.write('\n');
          resolve(s);
        } else if (ch === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        } else if (ch === '\u007f') s = s.slice(0, -1);
        else s += ch;
      };
      stdin.on('data', on);
    });
  const a = await ask('Senha (10 a 200 caracteres): ');
  const b = await ask('Repita a senha: ');
  if (a !== b) die('as senhas não conferem.');
  return a;
}

async function main() {
  const username = normUsername(positional[0] ?? '');
  if (!validUsername(username))
    die(MSG_USERNAME + ' Uso: node scripts/criar-usuario.mjs <usuario> [--url URL]');
  let url;
  try {
    url = new URL(opt(args, '--url', 'http://127.0.0.1:8787'));
  } catch {
    die('URL inválida.');
  }
  if (url.protocol !== 'https:' && !isLocal(url)) die('use https:// para um Worker remoto.');
  const recover = args.includes('--recuperar');
  const NAME = recover ? 'RECOVERY_SECRET' : 'BOOTSTRAP_SECRET';
  const secret = process.env['HG_' + NAME] || (isLocal(url) ? devVar(NAME) : '');
  if (!secret) die('defina HG_' + NAME + ' (o mesmo valor do secret ' + NAME + ' do Worker).');
  if (secret.length < 32) die(NAME + ' precisa ter pelo menos 32 caracteres (o Worker recusa mais curto).');
  const password = await readPassword();
  const policy = passwordPolicy(password, username);
  if (policy) die(policy);

  const endpoint = new URL(recover ? '/recover' : '/bootstrap', url).toString();
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, username, password }),
    });
  } catch {
    die('não consegui falar com ' + endpoint + ' (o Worker está rodando?).');
  }
  const j = await res.json().catch(() => ({}));
  if (res.ok && j.ok) {
    console.log(
      'Admin "' +
        username +
        '" ' +
        (recover ? 'com senha nova' : 'criado') +
        ' em ' +
        url.origin +
        '. Agora entre pelo painel.',
    );
    if (!isLocal(url)) console.log('Apague o secret agora: npx wrangler secret delete ' + NAME);
    return;
  }
  if (recover && res.status === 403) {
    die(
      'recuperação recusada: ' + (j.error ?? '') + ' (secret errado, já usado ou RECOVERY_SECRET ausente).',
    );
  }
  if (recover && res.status === 404) die('não existe admin com esse nome.');
  if (res.status === 403) {
    die(
      'bootstrap recusado (já existe usuário, segredo errado ou BOOTSTRAP_SECRET não configurado no Worker).',
    );
  }
  const fields = j.fields ? ' ' + Object.values(j.fields).join(' ') : '';
  die('HTTP ' + res.status + ': ' + (j.error ?? 'resposta inesperada') + fields);
}

main().catch((e) => die(e instanceof Error ? e.message.split('\n')[0] : String(e)));
