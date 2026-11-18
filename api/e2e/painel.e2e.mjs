/* E2E do painel HG Transportes no Chromium real, contra o ambiente local (dev/start-dev.sh):
 *   painel http://127.0.0.1:8781/admin/  ->  Worker 8787  ->  GitHub falso 8788 (git real em api/.dev-repo)
 * Rode com `npm run e2e` (e2e/run.sh sobe o ambiente do zero, cria o admin e derruba no fim).
 * Cada cenário tem asserção real (DOM do painel, DOM da prévia, git log do repo de dev, HTML servido na 8781
 * ou resposta do Worker). Screenshots em e2e/shots/, resumo em e2e/ultimo-resultado.txt.
 * Nenhum pedido sai da máquina: tudo que não for 127.0.0.1/localhost é bloqueado no navegador. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import zlib from 'node:zlib';

const API_DIR = path.resolve(import.meta.dirname, '..');
const REPO = path.join(API_DIR, '.dev-repo');
const SHOTS = path.join(import.meta.dirname, 'shots');
const RESULT = path.join(import.meta.dirname, 'ultimo-resultado.txt');
const SITE = 'http://127.0.0.1:8781';
const PANEL = SITE + '/admin/';
const API = 'http://127.0.0.1:8787';
const ORIGIN = SITE;
const ADMIN = process.env.HG_E2E_USER || 'hgadmin';
const ADMIN_PASS = process.env.HG_E2E_PASS || 'Cegonha-Local-2026';
const EDITOR = 'maria.editora';
const ED_PASS1 = 'Caminhao-Azul-77';
const ED_PASS2 = 'Estrada-Longa-88';
const ED_PASS3 = 'Rodovia-Sul-99x';
const TOTAL_TIMEOUT_MS = 8 * 60 * 1000;

/* ---------------- playwright-core (sem instalar nada novo) ---------------- */
function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const tries = [process.env.HG_PLAYWRIGHT_CORE, 'playwright-core'].filter(Boolean);
  for (const t of tries) {
    try {
      return require(t);
    } catch {
      /* tenta o próximo */
    }
  }
  throw new Error(
    'playwright-core não encontrado. Defina HG_PLAYWRIGHT_CORE=<pasta node_modules/playwright-core> ' +
      'ou instale com npm i -D playwright-core.',
  );
}
const { chromium } = loadPlaywright();

/* ---------------- utilidades ---------------- */
const log = [];
function out(line) {
  log.push(line);
  console.log(line);
}
function assert(cond, msg) {
  if (!cond) throw new Error('Asserção falhou: ' + msg);
}
function eq(a, b, msg) {
  if (a !== b)
    throw new Error(
      'Asserção falhou: ' + msg + ' (esperado ' + JSON.stringify(b) + ', veio ' + JSON.stringify(a) + ')',
    );
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, ms = 10_000) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end)
      throw new Error('Tempo esgotado: ' + msg + (last instanceof Error ? ' (' + last.message + ')' : ''));
    await sleep(150);
  }
}
function git(...args) {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();
}
function commitCount() {
  return Number(git('rev-list', '--count', 'HEAD'));
}
async function siteHtml() {
  const r = await fetch(SITE + '/index.html?t=' + Date.now(), { cache: 'no-store' });
  assert(r.ok, 'site 8781 respondeu ' + r.status);
  return r.text();
}
function cmsText(html, key) {
  const re = new RegExp('data-cms="' + key.replace(/\./g, '\\.') + '"[^>]*>([^<]*)<');
  return re.exec(html)?.[1] ?? null;
}
async function apiCall(route, { token, body, method } = {}) {
  const headers = { Origin: ORIGIN };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(API + route, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

/* PNG RGB gerado na hora (gradiente), para o teste de troca de foto */
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function makePng(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      raw[o + 1 + x * 3] = 217;
      raw[o + 2 + x * 3] = Math.round((x / w) * 200);
      raw[o + 3 + x * 3] = Math.round((y / h) * 200);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- navegador ---------------- */
const pageErrors = [];
const trail = []; // últimas respostas da API (vai para o log quando um cenário falha)
let shotN = 0;
async function shot(page, name) {
  shotN++;
  const file = path.join(SHOTS, String(shotN).padStart(2, '0') + '-' + name + '.png');
  await page.screenshot({ path: file });
}
async function newPanel(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 }, locale: 'pt-BR', ...opts });
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (
      u.hostname === '127.0.0.1' ||
      u.hostname === 'localhost' ||
      u.protocol === 'blob:' ||
      u.protocol === 'data:'
    )
      return route.continue();
    return route.abort();
  });
  const page = await ctx.newPage();
  page.dialogs = [];
  page.dialogPolicy = []; // fila: 'accept' | 'dismiss' para os próximos confirm()
  page.on('dialog', async (d) => {
    page.dialogs.push(d.message());
    const p = d.type() === 'confirm' ? page.dialogPolicy.shift() || 'accept' : 'accept';
    await (p === 'dismiss' ? d.dismiss() : d.accept());
  });
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('response', (r) => {
    if (r.url().startsWith(API))
      trail.push(
        new Date().toISOString().slice(11, 23) +
          ' ' +
          r.request().method() +
          ' ' +
          r.url().slice(API.length) +
          ' ' +
          r.status(),
      );
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text()))
      pageErrors.push('csp: ' + m.text());
  });
  await page.goto(PANEL, { waitUntil: 'domcontentloaded' });
  return page;
}
async function login(page, user, pass) {
  await page.locator('#login').waitFor({ state: 'visible' });
  await page.fill('#user', user);
  await page.fill('#pass', pass);
  await page.click('#loginBtn');
}
async function loggedIn(page) {
  await page.locator('#app').waitFor({ state: 'visible' });
  // os campos antigos continuam no DOM até o /content novo chegar: espera o carregamento terminar
  await until(async () => {
    const st = await page.textContent('#status');
    return st !== '' && st !== 'Carregando…';
  }, 'conteúdo carregado');
  await until(() => page.locator('#fields details.group').count(), 'campos montados');
  await frameReady(page);
}
async function frameReady(page) {
  return until(async () => {
    const f = page.frame({ url: /\/index\.html\?preview=/ });
    if (!f) return null;
    const ok = await f.evaluate(
      () => !!document.querySelector('[data-cms="topo.titulo1"]') && document.readyState !== 'loading',
    );
    return ok ? f : null;
  }, 'prévia carregada');
}
/* O painel rola a prévia com scroll suave até o campo focado. Clicar durante a rolagem deixa o alvo
 * "instável" e, no iframe em sandbox, o retry do Playwright às vezes fica ~27 s parado (visto com
 * DEBUG=pw:api). Espera a posição do alvo ficar igual em 3 leituras seguidas antes de clicar/tocar. */
async function settled(frame, sel) {
  let last = '';
  let same = 0;
  await until(async () => {
    const r = await frame.evaluate((s) => {
      const b = document.querySelector(s).getBoundingClientRect();
      return [b.x, b.y, b.width, b.height, window.scrollY].join(',');
    }, sel);
    same = r === last ? same + 1 : 0;
    last = r;
    return same >= 2;
  }, 'prévia parada antes de clicar em ' + sel);
}
const DRAFT_KEY = 'hg-cms-draft:';
async function draftOf(page, user) {
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), DRAFT_KEY + user);
}
function input(page, key) {
  return page
    .locator('[data-key="' + key + '"]')
    .locator('input, textarea')
    .first();
}
async function reveal(page, key, query) {
  await page.fill('#search', query);
  await input(page, key).waitFor({ state: 'visible' });
}
async function waitToastContains(page, text, kind) {
  return until(
    async () => {
      const t = await page.locator('#toast').getAttribute('class');
      const s = await page.locator('#toast').textContent();
      return t.includes('show') && (!kind || t.includes(kind)) && s.includes(text) ? s : null;
    },
    'toast com "' + text + '"',
  );
}
async function publishAndWait(page) {
  const resp = page.waitForResponse((r) => r.url() === API + '/publish' && r.request().method() === 'POST');
  await page.click('#publishBtn');
  return resp;
}
async function contrastReport(page, selectors) {
  return page.evaluate((sels) => {
    const parse = (c) => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const p = m[1]
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0.95) return c;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const rows = [];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        if (!el.getClientRects().length || !el.textContent.trim()) continue;
        const fg = parse(getComputedStyle(el).color);
        const bg = bgOf(el);
        const a = fg.a;
        const mix = {
          r: fg.r * a + bg.r * (1 - a),
          g: fg.g * a + bg.g * (1 - a),
          b: fg.b * a + bg.b * (1 - a),
        };
        const l1 = lum(mix);
        const l2 = lum(bg);
        rows.push({
          sel,
          text: el.textContent.trim().slice(0, 30),
          ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05),
        });
      }
    }
    return rows;
  }, selectors);
}
const fontPx = (page, sel) =>
  page
    .locator(sel)
    .first()
    .evaluate((e) => parseFloat(getComputedStyle(e).fontSize));

/* ---------------- cenários ---------------- */
const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });
const S = {}; // estado compartilhado entre cenários

scenario('Login: senha errada mostra mensagem; senha certa abre o painel', async ({ browser }) => {
  const page = await newPanel(browser);
  S.admin = page;
  await login(page, ADMIN, 'senha-errada-123');
  await until(
    async () => (await page.textContent('#loginError')).includes('Usuário ou senha incorretos.'),
    'erro de login',
  );
  assert(await page.locator('#app').isHidden(), 'painel não pode abrir com senha errada');
  await shot(page, 'login-senha-errada');
  await login(page, ADMIN, ADMIN_PASS);
  await loggedIn(page);
  eq(await page.textContent('#status'), 'Tudo publicado', 'status inicial');
  eq(await page.evaluate(() => window.__hgCms.fields().length), 98, '98 campos no editor');
  // CSP do painel: connect-src com o host exato do Worker de produção (o mesmo do config.js), sem curinga
  const adminDir = path.join(API_DIR, '..', 'admin');
  const prodApi = /:\s*'(https:\/\/[^']+)'/.exec(
    /apiBase:[^\n]*/.exec(fs.readFileSync(path.join(adminDir, 'config.js'), 'utf8'))[0],
  )[1];
  const connect = /connect-src ([^;"]+)/
    .exec(fs.readFileSync(path.join(adminDir, 'index.html'), 'utf8'))[1]
    .split(' ');
  assert(
    connect.includes(new URL(prodApi).origin),
    'connect-src cobre o apiBase de produção ' + prodApi + ': ' + connect.join(' '),
  );
  assert(!connect.some((s) => s.includes('*')), 'connect-src sem curinga: ' + connect.join(' '));
  // S6: o arquivo versionado é a CSP de produção (sem host local; script-src pelo caminho do painel)...
  const prodCsp = /Content-Security-Policy" content="([^"]+)"/.exec(
    fs.readFileSync(path.join(adminDir, 'index.html'), 'utf8'),
  )[1];
  assert(!/127\.0\.0\.1|localhost|http:\/\//.test(prodCsp), 'CSP de produção sem host local: ' + prodCsp);
  assert(
    prodCsp.includes('script-src https://joaostx1999.github.io/hg-transportes-site/admin/ '),
    'script-src de produção restrito ao caminho do painel: ' + prodCsp,
  );
  // ...e o painel servido no dev é a cópia gerada com a CSP local (a que o navegador está aplicando agora)
  const served = await (await fetch(PANEL, { cache: 'no-store' })).text();
  const devCsp = /Content-Security-Policy" content="([^"]+)"/.exec(served)[1];
  assert(devCsp.includes('http://127.0.0.1:8787'), 'CSP de dev libera o Worker local: ' + devCsp);
  assert(
    devCsp.includes('script-src http://127.0.0.1:8781/admin/ '),
    'script-src de dev por caminho: ' + devCsp,
  );
  S.devCsp = devCsp;
  assert(await page.locator('#usersBtn').isVisible(), 'admin vê Usuários');
  eq((await page.textContent('#usersBtn')).trim(), 'Usuários', 'botão do admin');
  await shot(page, 'painel-aberto');
});

scenario(
  'Design: título do login e dos diálogos maiores; textos secundários com contraste >= 4.5:1',
  async ({ browser }) => {
    const page = await newPanel(browser);
    await page.locator('#login').waitFor({ state: 'visible' });
    const h1 = await fontPx(page, '#login h1');
    const lbl = await fontPx(page, '#login label');
    const body = await fontPx(page, '#login p.muted');
    assert(
      h1 >= 1.9 * body && h1 >= 2.2 * lbl,
      'h1 do login claramente maior (h1 ' + h1 + 'px, texto ' + body + 'px, rótulo ' + lbl + 'px)',
    );
    let rows = await contrastReport(page, ['.muted', '.note', '.hint', '.error', 'label', '.btn-text']);
    await page.context().close();
    const a = S.admin;
    rows = rows.concat(await contrastReport(a, ['.hint', '.note', '.field .lbl', '.status', '.seg button']));
    await a.click('#usersBtn');
    await a.locator('#usersDlg[open]').waitFor();
    await until(() => a.locator('#usersList li .u-name').count(), 'lista de usuários');
    const h2 = await fontPx(a, '#usersTitle');
    const h3 = await fontPx(a, '#usersDlg h3');
    assert(h2 >= 1.3 * h3, 'título do diálogo maior que os subtítulos (' + h2 + ' x ' + h3 + ')');
    rows = rows.concat(
      await contrastReport(a, [
        '#usersDlg .muted',
        '#usersDlg .note',
        '#usersDlg label',
        '#usersDlg .u-meta',
        '#usersDlg .you',
      ]),
    );
    await shot(a, 'dialogo-usuarios');
    await a.click('#usersDlg [data-close]');
    await a.click('#historyBtn');
    await until(() => a.locator('#versionsList li .v-info').count(), 'versões');
    rows = rows.concat(
      await contrastReport(a, [
        '#historyDlg .muted',
        '#historyDlg .note',
        '#historyDlg .v-author',
        '#historyDlg .you',
      ]),
    );
    await a.click('#historyDlg [data-close]');
    const bad = rows.filter((r) => r.ratio < 4.5);
    assert(rows.length >= 15, 'mediu poucos textos (' + rows.length + ')');
    assert(!bad.length, 'contraste baixo: ' + JSON.stringify(bad));
    S.contrastMin = Math.min(...rows.map((r) => r.ratio)).toFixed(2);
    S.contrastN = rows.length;
  },
);

scenario(
  'Editar texto do topo: prévia muda na hora; clicar na prévia leva ao campo; Celular/Computador; Descartar',
  async () => {
    const page = S.admin;
    const frame = await frameReady(page);
    // S2: prévia em sandbox sem allow-scripts: o JS do site não roda (sem a classe .js) e o conteúdo .rv,
    // que o JS do site revelaria, aparece por padrão
    eq(await page.getAttribute('#frame', 'sandbox'), 'allow-same-origin', 'iframe com sandbox sem scripts');
    eq(
      await frame.evaluate(() => document.documentElement.classList.contains('js')),
      false,
      'script do site não rodou na prévia (html sem .js)',
    );
    const rv = await frame.evaluate(() =>
      [...document.querySelectorAll('.rv')].map((e) => Number(getComputedStyle(e).opacity)),
    );
    assert(
      rv.length > 3 && rv.every((o) => o === 1),
      'conteúdo .rv visível na prévia: ' + JSON.stringify(rv),
    );
    S.rvCount = rv.length;
    const novo = 'Seu carro em';
    await reveal(page, 'topo.titulo1', 'Título — linha 1');
    await input(page, 'topo.titulo1').fill(novo);
    eq(await frame.textContent('[data-cms="topo.titulo1"]'), novo, 'prévia atualizada na hora');
    assert(
      (await page.textContent('#publishBtn')).includes('Publicar 1 alteração'),
      'botão conta 1 alteração',
    );
    eq(
      await page.locator('[data-key="topo.titulo1"]').getAttribute('class'),
      'field changed',
      'campo marcado como alterado',
    );
    await page.fill('#search', '');
    // clicar num texto da prévia abre o campo
    await settled(frame, '[data-cms="topo.texto"]');
    await frame.click('[data-cms="topo.texto"]');
    await until(
      () =>
        page.evaluate(
          () => document.activeElement && document.activeElement.closest('[data-key="topo.texto"]') !== null,
        ),
      'foco no campo clicado na prévia',
    );
    await shot(page, 'previa-clique-leva-ao-campo');
    await page.click('[data-view="mobile"]');
    assert(await page.locator('#stage.mobile').count(), 'prévia em modo celular');
    await shot(page, 'previa-celular');
    await page.click('[data-view="desktop"]');
    assert(!(await page.locator('#stage.mobile').count()), 'prévia de volta ao computador');
    // Descartar: muda outro campo e descarta tudo (confirmado)
    await reveal(page, 'topo.botao', 'Botão principal');
    await input(page, 'topo.botao').fill('Teste descartar');
    await page.fill('#search', '');
    page.dialogPolicy.push('accept');
    await page.click('#discardBtn');
    await until(async () => (await page.textContent('#status')) === 'Tudo publicado', 'descartado');
    await until(
      async () =>
        (await (await frameReady(page)).textContent('[data-cms="topo.botao"]')) === 'Fazer cotação grátis',
      'prévia voltou ao publicado',
    );
    // edita de novo e publica
    await reveal(page, 'topo.titulo1', 'Título — linha 1');
    await input(page, 'topo.titulo1').fill(novo);
    await page.fill('#search', '');
    const before = commitCount();
    const resp = await publishAndWait(page);
    eq(resp.status(), 200, 'publish 200');
    await waitToastContains(page, 'Publicado!', 'ok');
    eq(commitCount(), before + 1, 'um commit novo no repo de dev');
    eq(git('log', '-1', '--format=%an'), ADMIN + ' (painel)', 'autor do commit');
    assert(git('log', '-1', '--format=%B').includes('- topo.titulo1:'), 'mensagem do commit lista o campo');
    await until(async () => cmsText(await siteHtml(), 'topo.titulo1') === novo, 'site 8781 com o texto novo');
    eq(await page.textContent('#status'), 'Tudo publicado', 'status depois de publicar');
    const site = await page.context().newPage();
    await site.goto(SITE + '/', { waitUntil: 'domcontentloaded' });
    eq(
      await site.textContent('[data-cms="topo.titulo1"]'),
      novo,
      'site aberto no navegador mostra o texto novo',
    );
    await shot(site, 'site-texto-novo');
    await site.close();
    await shot(page, 'publicado-texto');
  },
);

scenario('Trocar foto (PNG gerado): publica, arquivo em assets/fotos e site mostra', async () => {
  const page = S.admin;
  const png = path.join(SHOTS, 'foto-teste.png');
  fs.writeFileSync(png, makePng(120, 80));
  await reveal(page, 'quem.foto2', 'Foto pequena');
  await page.locator('[data-key="quem.foto2"] input[type=file]').setInputFiles(png);
  await until(
    async () => (await page.locator('[data-key="quem.foto2"] img').getAttribute('src')).startsWith('blob:'),
    'miniatura nova',
  );
  const frame = await frameReady(page);
  assert(
    (await frame.getAttribute('[data-cms="quem.foto2"]', 'src')).startsWith('blob:'),
    'prévia com a foto nova',
  );
  await page.fill('#search', '');
  await shot(page, 'foto-escolhida');
  const before = commitCount();
  const resp = await publishAndWait(page);
  const j = await resp.json();
  eq(resp.status(), 200, 'publish com foto 200');
  const p = j.paths && j.paths['quem.foto2'];
  assert(/^assets\/fotos\/cms-[0-9a-f]{16}\.png$/.test(p || ''), 'caminho devolvido: ' + p);
  await waitToastContains(page, 'Publicado!', 'ok');
  eq(commitCount(), before + 1, 'um commit com foto + index.html');
  const files = git('show', '--name-only', '--format=', 'HEAD').split('\n');
  assert(
    files.includes(p) && files.includes('index.html'),
    'commit tem a foto e o index.html: ' + files.join(','),
  );
  assert(fs.existsSync(path.join(REPO, p)), 'arquivo em api/.dev-repo/' + p);
  const bytes = fs.readFileSync(path.join(REPO, p));
  eq(bytes.subarray(1, 4).toString(), 'PNG', 'bytes mágicos PNG');
  await until(async () => (await siteHtml()).includes('src="' + p + '"'), 'index.html servido aponta a foto');
  const site = await page.context().newPage();
  await site.goto(SITE + '/#quem', { waitUntil: 'load' });
  const img = site.locator('[data-cms="quem.foto2"]');
  await img.scrollIntoViewIfNeeded();
  await until(
    () => img.evaluate((i) => i.complete && i.naturalWidth === 120),
    'foto nova carregada no site (120px)',
  );
  eq(await img.getAttribute('src'), p, 'src no site');
  await shot(site, 'site-foto-nova');
  await site.close();
});

scenario('WhatsApp inválido bloqueia com mensagem; válido atualiza o link do site', async () => {
  const page = S.admin;
  await reveal(page, 'contato.whatsapp', 'Número do WhatsApp');
  const inp = input(page, 'contato.whatsapp');
  await inp.fill('51 9999');
  const msg = page.locator('[data-key="contato.whatsapp"] .msg');
  eq(await msg.textContent(), 'Número com DDD, ex.: (51) 99377-5912.', 'mensagem do WhatsApp inválido');
  assert(await page.locator('#publishBtn').isDisabled(), 'publicar bloqueado');
  eq(await page.textContent('#status'), '1 campo(s) com erro', 'status com erro');
  await shot(page, 'whatsapp-invalido');
  // a mesma regra do servidor: o Worker recusa o mesmo valor (422)
  const tk = await page.evaluate(() => sessionStorage.getItem('hg-cms-session'));
  const c = await apiCall('/content', { token: tk });
  const r = await apiCall('/publish', {
    token: tk,
    body: { base: c.json.commit, changes: { 'contato.whatsapp': '51 9999' } },
  });
  eq(r.status, 422, 'servidor recusa o mesmo valor');
  eq(
    r.json.fields['contato.whatsapp'],
    'Número com DDD, ex.: (51) 99377-5912.',
    'mesma mensagem no servidor',
  );
  await inp.fill('(51) 98888-7777');
  eq(await msg.textContent(), '', 'sem erro com número válido');
  const frame = await frameReady(page);
  assert(
    (await frame.getAttribute('a.wa[data-cms-href="contato.whatsapp"]', 'href')).includes(
      'phone=5551988887777',
    ),
    'prévia com o link novo',
  );
  await page.fill('#search', '');
  const resp = await publishAndWait(page);
  eq(resp.status(), 200, 'publish WhatsApp 200');
  await waitToastContains(page, 'Publicado!', 'ok');
  const html = await until(async () => {
    const h = await siteHtml();
    return h.includes('content="5551988887777"') ? h : null;
  }, 'meta do WhatsApp no site');
  const links = html.match(/https:\/\/api\.whatsapp\.com\/send\?phone=\d+/g) || [];
  assert(
    links.length >= 2 && links.every((l) => l.endsWith('phone=5551988887777')),
    'todos os links do WhatsApp: ' + links.join(' '),
  );
  const site = await page.context().newPage();
  await site.goto(SITE + '/', { waitUntil: 'domcontentloaded' });
  assert(
    (await site.getAttribute('a.wa', 'href')).includes('phone=5551988887777'),
    'botão flutuante do site',
  );
  await site.close();
  await shot(page, 'whatsapp-publicado');
});

scenario('Conflito: outra sessão publica o mesmo campo antes; painel avisa e recarrega', async () => {
  const page = S.admin;
  const other = await apiCall('/login', { body: { username: ADMIN, password: ADMIN_PASS } });
  eq(other.status, 200, 'login da segunda sessão (API)');
  const tk2 = other.json.token;
  const c = await apiCall('/content', { token: tk2 });
  const r = await apiCall('/publish', {
    token: tk2,
    body: { base: c.json.commit, changes: { 'topo.titulo3': 'do Brasil inteiro.' } },
  });
  eq(r.status, 200, 'publicação da segunda sessão');
  await reveal(page, 'topo.titulo3', 'Título — linha 3');
  await input(page, 'topo.titulo3').fill('de todo o país.');
  await page.fill('#search', '');
  const before = commitCount();
  page.dialogPolicy.push('dismiss');
  const resp = await publishAndWait(page);
  eq(resp.status(), 409, 'servidor responde 409');
  await until(
    () => page.dialogs.some((d) => d.includes('Outra pessoa publicou uma mudança nestes mesmos campos')),
    'confirm de conflito',
  );
  const t = await waitToastContains(page, 'Outra pessoa publicou', 'bad');
  assert(t.includes('Recarregue'), 'toast manda recarregar');
  eq(
    await page.locator('[data-key="topo.titulo3"] .msg').textContent(),
    'Outra pessoa alterou este campo depois que você abriu o painel.',
    'campo marcado',
  );
  eq(commitCount(), before, 'nada publicado no conflito');
  await shot(page, 'conflito');
  // recarrega (F5): a sessão continua, o rascunho volta por cima da versão nova
  await page.reload({ waitUntil: 'domcontentloaded' });
  await loggedIn(page);
  await waitToastContains(page, 'em conflito');
  eq(await input(page, 'topo.titulo3').inputValue(), 'de todo o país.', 'rascunho preservado');
  // C2: o campo que a outra pessoa publicou depois do rascunho fica em conflito visível
  const box = page.locator('[data-key="topo.titulo3"] .conflict-box');
  assert(await box.isVisible(), 'caixa de conflito visível');
  assert((await box.textContent()).includes('«do Brasil inteiro.»'), 'mostra o que foi publicado');
  assert(await page.locator('#publishBtn').isDisabled(), 'publicar bloqueado com conflito');
  eq(await page.textContent('#status'), '1 campo(s) em conflito', 'status de conflito');
  await page.locator('[data-key="topo.titulo3"] [data-theirs]').click();
  eq(
    await input(page, 'topo.titulo3').inputValue(),
    'do Brasil inteiro.',
    'valor publicado pela outra pessoa',
  );
  eq(await page.textContent('#status'), 'Tudo publicado', 'sem pendências');
  await apiCall('/logout', { token: tk2, body: {} });
});

scenario('Versões: voltar para a anterior e o site volta', async () => {
  const page = S.admin;
  await page.click('#historyBtn');
  await until(() => page.locator('#versionsList li .v-info').count(), 'versões carregadas');
  const n = await page.locator('#versionsList li .v-info').count();
  assert(n >= 5, 'pelo menos 5 versões (inicial + 4 publicações), veio ' + n);
  eq(
    (await page.locator('#versionsList li').first().locator('.you').textContent()).trim(),
    'versão atual',
    'primeira é a atual',
  );
  await shot(page, 'versoes');
  const target = await page.locator('#versionsList [data-restore]').first().getAttribute('data-restore');
  eq(target, git('rev-parse', 'HEAD~1'), 'botão aponta a versão anterior');
  const before = commitCount();
  page.dialogPolicy.push('accept');
  await page.locator('#versionsList [data-restore]').first().click();
  await waitToastContains(page, 'Pronto! O site voltou', 'ok');
  eq(commitCount(), before + 1, 'restaurar vira commit novo');
  assert(
    git('log', '-1', '--format=%s').includes('voltou o site para a versão ' + target.slice(0, 7)),
    'mensagem do restore',
  );
  await until(
    async () => cmsText(await siteHtml(), 'topo.titulo3') === 'do Brasil.',
    'site voltou (titulo3)',
  );
  const html = await siteHtml();
  eq(cmsText(html, 'topo.titulo1'), 'Seu carro em', 'publicação anterior continua');
  await loggedIn(page);
  const frame = await frameReady(page);
  await until(
    async () => (await frame.textContent('[data-cms="topo.titulo3"]')) === 'do Brasil.',
    'prévia voltou',
  );
  await shot(page, 'versao-restaurada');
  // C3/S1: commit fora do branch (como refs/pull/N/head de um PR não mesclado) não é versão: 404
  const tk = await page.evaluate(() => sessionStorage.getItem('hg-cms-session'));
  const head = git('rev-parse', 'HEAD');
  const prTree = git('rev-parse', 'HEAD~2^{tree}');
  const pr = execFileSync(
    'git',
    [
      '-C',
      REPO,
      '-c',
      'user.name=pr',
      '-c',
      'user.email=pr@x',
      'commit-tree',
      prTree,
      '-p',
      head,
      '-m',
      'PR',
    ],
    { encoding: 'utf8' },
  ).trim();
  git('update-ref', 'refs/pull/9/head', pr);
  const r = await apiCall('/restore', { token: tk, body: { commit: pr, base: head } });
  eq(r.status, 404, 'restore de commit fora do branch: ' + JSON.stringify(r.json));
  eq(git('rev-parse', 'HEAD'), head, 'HEAD não mudou');
});

scenario(
  'Rebase (B1–B4): outra pessoa publica outro campo; o painel recarrega, avisa e não sobrescreve sem ver',
  async () => {
    const page = S.admin;
    await loggedIn(page);
    const before3 = await input(page, 'topo.titulo3').inputValue();
    const OUTRA = 'VALOR-DA-OUTRA-PESSOA';
    // B1: outra sessão publica titulo3
    const other = await apiCall('/login', { body: { username: ADMIN, password: ADMIN_PASS } });
    const tk2 = other.json.token;
    const c = await apiCall('/content', { token: tk2 });
    const b1 = await apiCall('/publish', {
      token: tk2,
      body: { base: c.json.commit, changes: { 'topo.titulo3': OUTRA } },
    });
    eq(b1.status, 200, 'B1 outra sessão publica titulo3');
    // B2: A publica selo1 com a base velha (rebase no servidor)
    await reveal(page, 'topo.selo1', 'Selo 1');
    await input(page, 'topo.selo1').fill('Selo editado por A');
    await page.fill('#search', '');
    const r2 = await publishAndWait(page);
    eq(r2.status(), 200, 'B2 publica com rebase');
    const j2 = await r2.json();
    eq(j2.rebased, true, 'B2 resposta diz rebased');
    assert(
      j2.othersChanged.includes('topo.titulo3'),
      'B2 othersChanged: ' + JSON.stringify(j2.othersChanged),
    );
    // B3: o painel recarregou o conteúdo novo e avisa quem mudou o quê
    const t3 = await waitToastContains(page, 'Outra pessoa também tinha publicado', 'ok');
    assert(t3.includes('Título — linha 3'), 'aviso cita o campo: ' + t3);
    await until(
      async () => (await input(page, 'topo.titulo3').inputValue()) === OUTRA,
      'B3 campo recarregado',
    );
    assert(
      await page.locator('[data-key="topo.titulo3"] .others-note').isVisible(),
      'B3 nota no campo atualizado',
    );
    eq(await page.textContent('#status'), 'Tudo publicado', 'B3 sem pendência');
    await until(
      async () => (await (await frameReady(page)).textContent('[data-cms="topo.titulo3"]')) === OUTRA,
      'B3 prévia com o valor novo',
    );
    await shot(page, 'rebase-aviso');
    // B4 com painel "velho" (simula o defeito: campo com o valor de antes do B1): o servidor recusa
    await page.evaluate(
      ([k, v]) => {
        window.__hgCms.fields().find((x) => x.key === k).original = v;
      },
      ['topo.titulo3', before3],
    );
    await reveal(page, 'topo.titulo3', 'Título — linha 3');
    await input(page, 'topo.titulo3').fill('A edita sem ver a mudança');
    await page.fill('#search', '');
    const n0 = commitCount();
    page.dialogPolicy.push('dismiss');
    const r4 = await publishAndWait(page);
    eq(r4.status(), 409, 'B4 painel velho: 409');
    eq(r4.request().postDataJSON().expected['topo.titulo3'], before3, 'B4 mandou o valor que o painel via');
    eq(commitCount(), n0, 'B4 nada publicado');
    eq(cmsText(await siteHtml(), 'topo.titulo3'), OUTRA, 'B4 site mantém a mudança da outra pessoa');
    await shot(page, 'rebase-b4-409');
    // recarregando, o rascunho volta EM CONFLITO; a pessoa escolhe manter o dela e publica ciente
    await page.reload({ waitUntil: 'domcontentloaded' });
    await loggedIn(page);
    const box = page.locator('[data-key="topo.titulo3"] .conflict-box');
    await box.waitFor({ state: 'visible' });
    assert((await box.textContent()).includes('«' + OUTRA + '»'), 'conflito mostra o publicado');
    await box.locator('[data-keep]').click();
    eq(await page.textContent('#status'), 'Alterações não publicadas', 'conflito resolvido');
    const r5 = await publishAndWait(page);
    eq(r5.status(), 200, 'publica depois de escolher');
    eq(r5.request().postDataJSON().expected['topo.titulo3'], OUTRA, 'expected agora é o valor publicado');
    await waitToastContains(page, 'Publicado!', 'ok');
    await until(
      async () => cmsText(await siteHtml(), 'topo.titulo3') === 'A edita sem ver a mudança',
      'site com a decisão',
    );
    await apiCall('/logout', { token: tk2, body: {} });
  },
);

scenario('Espaço a mais num texto não vira pendência; limite do campo vem do servidor', async () => {
  const page = S.admin;
  await reveal(page, 'topo.selo3', 'Selo 3');
  const cur = await input(page, 'topo.selo3').inputValue();
  assert(cur.includes(' '), 'selo3 tem espaço: ' + cur);
  await input(page, 'topo.selo3').fill(' ' + cur.replace(' ', '  ') + '  ');
  eq(await page.textContent('#status'), 'Tudo publicado', 'espaço duplo não é alteração');
  assert(await page.locator('#publishBtn').isDisabled(), 'publicar continua desligado');
  assert(
    !(await page.locator('[data-key="topo.selo3"]').getAttribute('class')).includes('changed'),
    'campo não marcado como alterado',
  );
  const rule = await page.evaluate(() => window.__hgCms.rules()['topo.selo3']);
  eq(JSON.stringify(rule), JSON.stringify({ type: 'text', max: 600 }), 'regra do /content');
  await input(page, 'topo.selo3').fill(cur);
  await page.fill('#search', '');
});

scenario(
  'Usuários: admin cria editor; editor não vê gestão; troca de senha derruba a outra sessão; admin redefine senha',
  async ({ browser }) => {
    const a = S.admin;
    await a.click('#usersBtn');
    await a.locator('#usersDlg[open]').waitFor();
    await a.fill('#newUser', EDITOR);
    await a.fill('#newPass', EDITOR); // senha com o nome de usuário: recusada no cliente
    await a.click('#addUserBtn');
    eq(
      await a.textContent('#addUserError'),
      'A senha não pode conter o nome de usuário.',
      'política de senha',
    );
    await a.fill('#newPass', ED_PASS1);
    await a.selectOption('#newRole', 'editor');
    await a.click('#addUserBtn');
    eq(await a.textContent('#addUserError'), 'Digite a sua senha para confirmar.', 'pede a senha do admin');
    await a.fill('#addActorPass', 'senha-do-admin-errada');
    await a.click('#addUserBtn');
    await until(
      async () => (await a.textContent('#addUserError')) === 'Sua senha está incorreta.',
      'senha do admin errada recusada no servidor',
    );
    await a.fill('#addActorPass', ADMIN_PASS);
    await a.click('#addUserBtn');
    await waitToastContains(a, 'Usuário ' + EDITOR + ' cadastrado', 'ok');
    await until(() => a.locator('#usersList [data-remove="' + EDITOR + '"]').count(), 'editor na lista');
    await shot(a, 'usuario-criado');
    // duplicado: mensagem clara do servidor
    await a.fill('#newUser', EDITOR);
    await a.fill('#newPass', ED_PASS1);
    await a.fill('#addActorPass', ADMIN_PASS);
    await a.click('#addUserBtn');
    await until(
      async () => (await a.textContent('#addUserError')) === 'Já existe um usuário com esse nome.',
      'duplicado',
    );
    // remover pede a senha do admin (formulário, não confirm)
    const TEMP = 'temp.removivel';
    await a.fill('#newUser', TEMP);
    await a.fill('#newPass', 'Temporaria-Senha-55');
    await a.fill('#addActorPass', ADMIN_PASS);
    await a.click('#addUserBtn');
    await waitToastContains(a, 'Usuário ' + TEMP + ' cadastrado', 'ok');
    await until(() => a.locator('#usersList [data-remove="' + TEMP + '"]').count(), 'temporário na lista');
    await a.click('#usersList [data-remove="' + TEMP + '"]');
    await a.locator('#removeForm').waitFor({ state: 'visible' });
    eq(await a.textContent('#removeTitle'), 'Remover ' + TEMP, 'título do remover');
    await a.fill('#removeActorPass', ADMIN_PASS);
    await shot(a, 'remover-pede-senha');
    await a.click('#removeBtn');
    await waitToastContains(a, 'Usuário ' + TEMP + ' removido', 'ok');
    await until(
      async () => !(await a.locator('#usersList [data-remove="' + TEMP + '"]').count()),
      'removido da lista',
    );
    await a.fill('#newUser', '');
    await a.fill('#newPass', '');
    await a.click('#usersDlg [data-close]');

    // editor (sessão B)
    const b = await newPanel(browser);
    await login(b, EDITOR, ED_PASS1);
    await loggedIn(b);
    eq((await b.textContent('#usersBtn')).trim(), 'Minha senha', 'editor vê só Minha senha');
    await b.click('#usersBtn');
    await b.locator('#usersDlg[open]').waitFor();
    assert(await b.locator('#adminArea').isHidden(), 'editor não vê a gestão de usuários');
    assert(!(await b.locator('#usersList').isVisible()), 'lista de usuários escondida');
    eq(await b.textContent('#usersTitle'), 'Minha senha', 'título para editor');
    const tkB = await b.evaluate(() => sessionStorage.getItem('hg-cms-session'));
    eq((await apiCall('/users', { token: tkB })).status, 403, 'servidor recusa /users para editor');
    await shot(b, 'editor-sem-gestao');
    await b.click('#usersDlg [data-close]');

    // editor de novo (sessão C), troca a senha na B: C cai, B continua
    const c = await newPanel(browser);
    await login(c, EDITOR, ED_PASS1);
    await loggedIn(c);
    await b.click('#usersBtn');
    await b.fill('#curPass', 'senha-atual-errada');
    await b.fill('#newMyPass', ED_PASS2);
    await b.click('#myPassBtn');
    await until(
      async () => (await b.textContent('#myPassError')) === 'Senha atual incorreta.',
      'senha atual errada',
    );
    await b.fill('#curPass', ED_PASS1);
    await b.fill('#newMyPass', ED_PASS2);
    await b.click('#myPassBtn');
    await waitToastContains(b, 'Senha trocada.', 'ok');
    await b.click('#usersDlg [data-close]');
    await c.click('#historyBtn');
    await c.locator('#login').waitFor({ state: 'visible' });
    eq(await c.textContent('#loginError'), 'Sua sessão expirou. Entre de novo.', 'sessão C derrubada');
    await shot(c, 'outra-sessao-derrubada');
    await b.click('#historyBtn');
    await until(() => b.locator('#versionsList li .v-info').count(), 'sessão B continua');
    await b.click('#historyDlg [data-close]');

    // admin redefine a senha do editor: B cai e entra com a senha nova
    await a.click('#usersBtn');
    await until(() => a.locator('#usersList [data-reset="' + EDITOR + '"]').count(), 'botão nova senha');
    assert(
      !(await a.locator('#usersList [data-reset="' + ADMIN + '"]').count()),
      'sem botão de nova senha para si mesmo',
    );
    await a.click('#usersList [data-reset="' + EDITOR + '"]');
    await a.locator('#resetPassForm').waitFor({ state: 'visible' });
    eq(await a.textContent('#resetPassTitle'), 'Nova senha para ' + EDITOR, 'título do formulário');
    await a.fill('#resetPass', ED_PASS3);
    await a.fill('#resetActorPass', ADMIN_PASS);
    await shot(a, 'admin-nova-senha');
    await a.click('#resetPassBtn');
    await waitToastContains(a, 'Senha de ' + EDITOR + ' trocada', 'ok');
    assert(await a.locator('#resetPassForm').isHidden(), 'formulário fecha');
    await a.click('#usersDlg [data-close]');
    await b.click('#historyBtn');
    await b.locator('#login').waitFor({ state: 'visible' });
    eq(
      await b.textContent('#loginError'),
      'Sua sessão expirou. Entre de novo.',
      'sessão B derrubada pela redefinição',
    );
    await login(b, EDITOR, ED_PASS2);
    await until(
      async () => (await b.textContent('#loginError')) === 'Usuário ou senha incorretos.',
      'senha antiga recusada',
    );
    await login(b, EDITOR, ED_PASS3);
    await loggedIn(b);
    await shot(b, 'editor-senha-redefinida');
    await b.context().close();
    await c.context().close();
  },
);

scenario(
  'Rascunho por usuário: Sair descarta; sessão vencida guarda só para o dono; mudança alheia vira conflito',
  async () => {
    const page = S.admin;
    // (a) Sair (botão) descarta o rascunho: a próxima pessoa no navegador não herda nada
    await reveal(page, 'topo.selo2', 'Selo 2');
    await input(page, 'topo.selo2').fill('RASCUNHO-DO-ADMIN');
    await page.fill('#search', '');
    const d1 = await draftOf(page, ADMIN);
    eq(d1.user, ADMIN, 'rascunho com dono');
    assert(/^[0-9a-f]{40}$/.test(d1.base), 'rascunho com a base: ' + d1.base);
    eq(d1.values['topo.selo2'], 'RASCUNHO-DO-ADMIN', 'valor no rascunho');
    page.dialogPolicy.push('accept');
    await page.click('#logoutBtn');
    await page.locator('#login').waitFor({ state: 'visible' });
    assert(
      page.dialogs.some((x) => x.includes('Sair descarta 1 alteração não publicada')),
      'confirma antes de descartar',
    );
    eq(await draftOf(page, ADMIN), null, 'Sair apagou o rascunho');
    eq(await page.evaluate(() => localStorage.getItem('hg-cms-draft')), null, 'sem a chave antiga sem dono');
    await login(page, EDITOR, ED_PASS3);
    await loggedIn(page);
    const pub2 = cmsText(await siteHtml(), 'topo.selo2');
    eq(
      await input(page, 'topo.selo2').inputValue(),
      pub2,
      '(a) editora vê o publicado, não o rascunho do admin',
    );
    eq(await page.textContent('#status'), 'Tudo publicado', '(a) editora sem pendência');
    await page.click('#logoutBtn');
    await page.locator('#login').waitFor({ state: 'visible' });

    // (b) sessão vencida guarda o rascunho, só para o dono; mudança alheia no campo vira conflito visível
    await login(page, ADMIN, ADMIN_PASS);
    await loggedIn(page);
    await reveal(page, 'topo.selo2', 'Selo 2');
    await input(page, 'topo.selo2').fill('RASCUNHO-2');
    await page.fill('#search', '');
    const tk = await page.evaluate(() => sessionStorage.getItem('hg-cms-session'));
    eq((await apiCall('/logout', { token: tk, body: {} })).status, 200, 'sessão encerrada no servidor');
    await page.click('#historyBtn');
    await page.locator('#login').waitFor({ state: 'visible' });
    const d2 = await draftOf(page, ADMIN);
    eq(d2.values['topo.selo2'], 'RASCUNHO-2', 'sessão vencida guardou o rascunho');
    eq(d2.originals['topo.selo2'], pub2, 'com o valor publicado que o admin via');
    const other = await apiCall('/login', { body: { username: ADMIN, password: ADMIN_PASS } });
    const c = await apiCall('/content', { token: other.json.token });
    const pub = await apiCall('/publish', {
      token: other.json.token,
      body: { base: c.json.commit, changes: { 'topo.selo2': 'PUBLICADO-DEPOIS' } },
    });
    eq(pub.status, 200, 'outra sessão publica o mesmo campo');
    await login(page, EDITOR, ED_PASS3);
    await loggedIn(page);
    eq(await input(page, 'topo.selo2').inputValue(), 'PUBLICADO-DEPOIS', '(b) editora não herda o rascunho');
    eq(await page.locator('.conflict-box').count(), 0, '(b) nada em conflito para a editora');
    await page.click('#logoutBtn');
    await page.locator('#login').waitFor({ state: 'visible' });
    await login(page, ADMIN, ADMIN_PASS);
    await loggedIn(page);
    await waitToastContains(page, 'em conflito');
    eq(await input(page, 'topo.selo2').inputValue(), 'RASCUNHO-2', '(b) rascunho do admin de volta');
    const box = page.locator('[data-key="topo.selo2"] .conflict-box');
    assert(await box.isVisible(), '(b) conflito visível');
    assert((await box.textContent()).includes('«PUBLICADO-DEPOIS»'), '(b) mostra o que foi publicado');
    assert(await page.locator('#publishBtn').isDisabled(), '(b) publicar bloqueado');
    eq(await page.textContent('#status'), '1 campo(s) em conflito', '(b) status');
    await shot(page, 'rascunho-em-conflito');
    await box.locator('[data-theirs]').click();
    eq(await input(page, 'topo.selo2').inputValue(), 'PUBLICADO-DEPOIS', 'usar o publicado');
    eq(await page.textContent('#status'), 'Tudo publicado', 'sem pendência');
    eq(await draftOf(page, ADMIN), null, 'rascunho resolvido');
    await apiCall('/logout', { token: other.json.token, body: {} });
  },
);

scenario('Sair volta ao login; sessão expirada volta ao login com aviso', async () => {
  const page = S.admin;
  const tk = await page.evaluate(() => sessionStorage.getItem('hg-cms-session'));
  await page.click('#logoutBtn');
  await page.locator('#login').waitFor({ state: 'visible' });
  eq(await page.textContent('#loginError'), '', 'sair sem mensagem de erro');
  eq(await page.evaluate(() => sessionStorage.getItem('hg-cms-session')), null, 'token apagado do navegador');
  const me = await apiCall('/me', { token: tk });
  eq(me.status, 401, 'token antigo recusado no servidor');
  eq(me.json.code, 'session_expired', 'código session_expired');
  await shot(page, 'saiu');
  await login(page, ADMIN, ADMIN_PASS);
  await loggedIn(page);
  // a sessão acaba no servidor (como quando vence): a próxima ação volta ao login com aviso
  const tk2 = await page.evaluate(() => sessionStorage.getItem('hg-cms-session'));
  eq((await apiCall('/logout', { token: tk2, body: {} })).status, 200, 'sessão encerrada no servidor');
  await reveal(page, 'topo.selo1', 'Selo 1');
  await input(page, 'topo.selo1').fill('Seguradora Tokio Marine');
  await page.fill('#search', '');
  await page.click('#publishBtn');
  await page.locator('#login').waitFor({ state: 'visible' });
  eq(await page.textContent('#loginError'), 'Sua sessão expirou. Entre de novo.', 'aviso de sessão expirada');
  await shot(page, 'sessao-expirada');
  // ao entrar de novo, a alteração não publicada volta
  await login(page, ADMIN, ADMIN_PASS);
  await loggedIn(page);
  eq(
    await input(page, 'topo.selo1').inputValue(),
    'Seguradora Tokio Marine',
    'rascunho preservado após expirar',
  );
  page.dialogPolicy.push('accept');
  await page.click('#discardBtn');
  await until(async () => (await page.textContent('#status')) === 'Tudo publicado', 'descartado');
  // token inválido guardado + recarregar: também volta ao login com aviso
  await page.evaluate(() => sessionStorage.setItem('hg-cms-session', 'A'.repeat(43)));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#login').waitFor({ state: 'visible' });
  eq(
    await page.textContent('#loginError'),
    'Sua sessão expirou. Entre de novo.',
    'aviso ao abrir com sessão vencida',
  );
});

scenario('Celular 390px: abas Editar/Ver prévia funcionam, sem rolagem horizontal', async ({ browser }) => {
  const page = await newPanel(browser, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  await page.locator('#login').waitFor({ state: 'visible' });
  const sw = () =>
    page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
  assert((await sw()) <= 390, 'login sem rolagem horizontal (' + (await sw()) + ')');
  await shot(page, 'celular-login');
  await login(page, ADMIN, ADMIN_PASS);
  await loggedIn(page);
  assert((await sw()) <= 390, 'painel sem rolagem horizontal (' + (await sw()) + ')');
  assert(await page.locator('.tabs-mobile').isVisible(), 'abas visíveis');
  assert(await page.locator('#paneEdit').isVisible(), 'aba Editar aberta');
  assert(await page.locator('#panePreview').isHidden(), 'prévia escondida');
  await shot(page, 'celular-editar');
  await page.locator('.tabs-mobile [data-pane="preview"]').tap();
  await page.locator('#panePreview').waitFor({ state: 'visible' });
  assert(await page.locator('#paneEdit').isHidden(), 'editor escondido na prévia');
  const box = await page.locator('#frame').boundingBox();
  assert(box && box.width > 100 && box.height > 100, 'iframe visível');
  assert((await sw()) <= 390, 'prévia sem rolagem horizontal (' + (await sw()) + ')');
  await shot(page, 'celular-previa');
  const frame = await frameReady(page);
  await settled(frame, '[data-cms="topo.texto"]');
  await frame.locator('[data-cms="topo.texto"]').tap();
  await page.locator('#paneEdit').waitFor({ state: 'visible' });
  await until(
    () =>
      page.evaluate(
        () => document.activeElement && document.activeElement.closest('[data-key="topo.texto"]') !== null,
      ),
    'tocar na prévia abre o campo',
  );
  await page.locator('.tabs-mobile [data-pane="edit"]').tap();
  assert(await page.locator('#paneEdit').isVisible(), 'volta para Editar');
  await page.click('#usersBtn');
  await page.locator('#usersDlg[open]').waitFor();
  assert((await sw()) <= 390, 'diálogo sem rolagem horizontal');
  await shot(page, 'celular-usuarios');
  await page.context().close();
});

scenario('Limite de tentativas: senhas erradas seguidas mostram "aguarde"', async ({ browser }) => {
  const page = await newPanel(browser);
  const msgs = [];
  for (let i = 1; i <= 7; i++) {
    const resp = page.waitForResponse((r) => r.url() === API + '/login');
    await login(page, 'visitante', 'errada-' + i + '-xyzw');
    const r = await resp;
    await until(
      async () =>
        (await page.textContent('#loginError')) !== '' && (await page.locator('#loginBtn').isEnabled()),
      'resposta do login',
    );
    msgs.push(r.status() + ' ' + (await page.textContent('#loginError')));
    if (r.status() === 429) {
      eq(r.headers()['retry-after'] !== undefined, true, 'Retry-After exposto');
      break;
    }
  }
  const last = msgs[msgs.length - 1];
  assert(last.startsWith('429 '), 'bloqueou: ' + msgs.join(' | '));
  assert(msgs.length <= 6, 'bloqueou até a 6ª tentativa: ' + msgs.length);
  assert(/aguarde cerca de 1[45] minutos/.test(last), 'mensagem com tempo de espera: ' + last);
  assert(
    msgs.slice(0, -1).every((m) => m === '401 Usuário ou senha incorretos.'),
    'antes do bloqueio: ' + msgs.join(' | '),
  );
  S.rateMsg = last;
  await shot(page, 'muitas-tentativas');
  await page.context().close();
});

/* ---------------- execução ---------------- */
async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of fs.readdirSync(SHOTS)) if (f.endsWith('.png')) fs.rmSync(path.join(SHOTS, f));
  const killer = setTimeout(() => {
    out('[FALHA] tempo total do E2E esgotado');
    fs.writeFileSync(RESULT, log.join('\n') + '\n');
    process.exit(1);
  }, TOTAL_TIMEOUT_MS);
  const started = new Date();
  out('E2E painel HG Transportes - ' + started.toISOString());
  out('Repo de dev: ' + REPO + ' (HEAD inicial ' + git('rev-parse', '--short', 'HEAD') + ')');
  const browser = await chromium.launch({ headless: true });
  out('Chromium ' + browser.version());
  let failed = 0;
  // HG_E2E_ONLY=1,3 roda só esses cenários (diagnóstico local; o npm run e2e roda todos)
  const only = (process.env.HG_E2E_ONLY || '').split(',').filter(Boolean).map(Number);
  for (const [i, sc] of scenarios.entries()) {
    if (only.length && !only.includes(i + 1)) continue;
    const t0 = Date.now();
    try {
      await sc.fn({ browser });
      out('[OK]    ' + (i + 1) + '. ' + sc.name + ' (' + (Date.now() - t0) + ' ms)');
    } catch (e) {
      failed++;
      out(
        '[FALHA] ' +
          (i + 1) +
          '. ' +
          sc.name +
          ' (' +
          (Date.now() - t0) +
          ' ms)\n        ' +
          String(e && e.stack ? e.stack : e)
            .split('\n')
            .slice(0, 4)
            .join('\n        '),
      );
      if (S.admin) {
        await shot(S.admin, 'falha-' + (i + 1)).catch(() => undefined);
        const st = await S.admin
          .evaluate(() => [
            document.querySelector('#status').textContent,
            document.querySelector('#toast').textContent,
          ])
          .catch(() => []);
        out('        status/toast do painel: ' + JSON.stringify(st));
      }
      out('        últimas respostas da API: ' + trail.slice(-8).join(' | '));
    }
  }
  if (pageErrors.length) {
    failed++;
    out('[FALHA] erros de JavaScript/CSP no navegador:\n        ' + pageErrors.join('\n        '));
  } else {
    out('[OK]    nenhum erro de JavaScript nem de CSP no navegador');
  }
  if (S.contrastN) out('Contraste: ' + S.contrastN + ' textos medidos, menor razão ' + S.contrastMin + ':1');
  if (S.rateMsg) out('Mensagem do bloqueio: ' + S.rateMsg);
  if (S.devCsp) out('CSP servida no dev: ' + S.devCsp);
  if (S.rvCount) out('Prévia em sandbox: ' + S.rvCount + ' blocos .rv visíveis sem o JS do site');
  out('Commits no repo de dev: ' + commitCount() + '; screenshots: ' + shotN + ' em e2e/shots/');
  out(
    (failed ? 'RESULTADO: FALHOU (' + failed + ' de ' : 'RESULTADO: PASSOU (0 falhas em ') +
      scenarios.length +
      ' cenários)',
  );
  await browser.close();
  clearTimeout(killer);
  fs.writeFileSync(RESULT, log.join('\n') + '\n');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  out('[FALHA] erro geral: ' + (e && e.stack ? e.stack : e));
  fs.writeFileSync(RESULT, log.join('\n') + '\n');
  process.exit(1);
});
