import { beforeEach, describe, expect, test } from 'vitest';
import { b64, diffRange, INDEX, JPG, makeApp, PASS, PASS2, PNG, SCHEMA, type App } from './helpers.ts';
import { createGitHub } from '../../src/github.ts';
import { toHttpError } from '../../src/app.ts';
import { errorBody, HttpError } from '../../src/http.ts';
import type { LogEntry } from '../../src/log.ts';
import { applySource } from '../../src/html-editor.ts';
import { MAX_CHANGES, publish as publishDirect, type PublishContext } from '../../src/publish.ts';
import { checkAgainstSchema, extractFields, parseSchema } from '../../src/schema.ts';

let t: App;
let tok: string;

beforeEach(async () => {
  t = await makeApp();
  await t.addUser('ana', PASS, 'admin');
  tok = await t.login('ana', PASS);
});

const publish = (body: unknown, token = tok) => t.call('POST', '/publish', { token, body });

describe('/content', () => {
  test('devolve html, commit do HEAD e schemaVersion', async () => {
    const r = await t.call('GET', '/content', { token: tok });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, html: INDEX, commit: t.gh.head, schemaVersion: 1 });
  });

  test('C6: devolve as regras por campo do esquema do MESMO commit (tipo e limite) para o painel', async () => {
    const r = await t.call('GET', '/content', { token: tok });
    const fields = (r.json as Record<string, unknown>).fields as { key: string; type: string; max: number }[];
    expect(fields).toHaveLength(98);
    expect(fields).toContainEqual({ key: 'topo.selo2', type: 'text', max: 600 });
    expect(fields).toContainEqual({ key: 'contato.whatsapp', type: 'whatsapp', max: 30 });
    const s = JSON.parse(SCHEMA) as { fields: { key: string; max: number }[] };
    const f = s.fields.find((x) => x.key === 'topo.selo2');
    if (f) f.max = 5;
    await t.gh.commitFiles({ 'cms/schema.json': JSON.stringify(s) }, 'aperta');
    const r2 = await t.call('GET', '/content', { token: tok });
    expect((r2.json as Record<string, unknown>).fields as unknown[]).toContainEqual({
      key: 'topo.selo2',
      type: 'text',
      max: 5,
    });
  });
});

describe('/publish: um commit por publicação', () => {
  test('muda só o trecho marcado; autor, committer e mensagem do painel; um único commit', async () => {
    const { commit: base } = await t.content(tok);
    const r = await publish({
      base,
      changes: {
        'topo.botao': 'Cotação já',
        'seo.titulo': 'HG Transportes | Transporte de veículos para todo o Brasil',
      },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toEqual({ ok: true, commit: t.gh.head, changed: ['topo.botao'], rebased: false });
    const html = t.gh.text('index.html');
    expect(html).toBe(
      INDEX.replace(
        'data-cms-label="Botão principal">Fazer cotação grátis</span>',
        'data-cms-label="Botão principal">Cotação já</span>',
      ),
    );
    const d = diffRange(INDEX, html);
    const at = INDEX.indexOf('>Fazer cotação grátis</span>');
    expect(d.start).toBeGreaterThan(at);
    const c = t.gh.commit();
    expect(c.parents).toEqual([base]);
    expect(c.message).toBe('Painel: ana alterou 1 campo(s)\n\n- topo.botao: Botão principal\n');
    expect(c.author).toEqual({
      name: 'ana (painel)',
      email: 'ana@painel.hgtransportes.invalid',
      date: '2026-11-17T12:00:00.000Z',
    });
    expect(c.committer).toEqual(c.author);
    expect(t.gh.changedFiles()).toEqual(['index.html']);
    expect(t.gh.calls.filter((x) => x.method === 'POST' && x.path.endsWith('/git/commits'))).toHaveLength(1);
    expect(t.gh.calls.filter((x) => x.method === 'PATCH')).toHaveLength(1);
  });

  test('fotos vão no MESMO commit do index.html; o servidor gera o caminho', async () => {
    const { commit: base } = await t.content(tok);
    const r = await publish({
      base,
      changes: { 'topo.selo1': 'Seguro total' },
      images: {
        'cta.foto': { type: 'image/jpeg', data: b64(JPG) },
        'servicos.c1_foto': { type: 'image/png', data: b64(PNG) },
      },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const paths = r.json.paths as Record<string, string>;
    expect(paths['cta.foto']).toMatch(/^assets\/fotos\/cms-[0-9a-f]{16}\.jpg$/);
    expect(paths['servicos.c1_foto']).toMatch(/^assets\/fotos\/cms-[0-9a-f]{16}\.png$/);
    expect(r.json.changed).toEqual(['topo.selo1', 'cta.foto', 'servicos.c1_foto']);
    expect(t.gh.changedFiles()).toEqual([paths['cta.foto'], paths['servicos.c1_foto'], 'index.html'].sort());
    expect([...(t.gh.file(paths['cta.foto'] ?? '') ?? [])]).toEqual([...JPG]);
    const html = t.gh.text('index.html');
    expect(html).toContain(
      'data-cms="cta.foto" data-cms-type="image" data-cms-label="Foto" src="' +
        (paths['cta.foto'] ?? '?') +
        '"',
    );
    expect(t.gh.commit().message).toBe(
      'Painel: ana alterou 3 campo(s)\n\n- topo.selo1: Selo 1\n- cta.foto: Foto\n- servicos.c1_foto: Card 1 — foto\n',
    );
  });

  test('todos os tipos com escape e links derivados', async () => {
    const { commit: base } = await t.content(tok);
    const r = await publish({
      base,
      changes: {
        'topo.titulo1': '<script>alert(1)</script>',
        'seo.descricao': 'Desc "nova" $&',
        'local.sp_endereco': 'Rua X, 1\r\nSão Paulo – SP',
        'numeros.n2': '5000',
        'contato.tel1': '(51) 3333-4444',
        'contato.whatsapp': '(11) 91234-5678',
        'contato.email': 'novo@hg.com.br',
        'contato.facebook': 'https://www.facebook.com/hgnovo',
      },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const h = t.gh.text('index.html');
    expect(h).toContain('>&lt;script&gt;alert(1)&lt;/script&gt;</span>');
    expect(h).not.toContain('<script>alert(1)');
    expect(h).toContain('content="Desc &quot;nova&quot; $&"');
    expect(h).toContain('>Rua X, 1<br>São Paulo – SP</p>');
    expect(h).toContain(
      'href="https://www.google.com/maps/search/?api=1&query=Rua%20X%2C%201%2C%20S%C3%A3o%20Paulo%20%E2%80%93%20SP"',
    );
    expect(h).toContain(
      'data-count="5000" data-sep data-cms="numeros.n2" data-cms-type="number" data-cms-label="Número 2">5.000</span>',
    );
    expect(h).toContain('href="tel:+555133334444"');
    expect(h).toContain('content="5511912345678"');
    expect(h.match(/phone=5511912345678&text=/g)).toHaveLength(2);
    expect(h).toContain('href="mailto:novo@hg.com.br"');
  });

  test('valores inválidos, chave desconhecida e foto em changes: 422 com fields; nada é escrito', async () => {
    const { commit: base } = await t.content(tok);
    const before = t.gh.head;
    const r = await publish({
      base,
      changes: {
        'nao.existe': 'x',
        'contato.instagram': 'javascript:alert(1)',
        'numeros.n1': '-3',
        'topo.texto': '',
        'topo.botao': 'a\nb',
        'cta.foto': 'assets/fotos/frota-patio.jpg',
        'topo.selo1': 5,
      },
    });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('validation');
    expect(Object.keys(r.json.fields ?? {}).sort()).toEqual(['topo.selo1']);
    const r2 = await publish({
      base,
      changes: {
        'nao.existe': 'x',
        'contato.instagram': 'javascript:alert(1)',
        'numeros.n1': '-3',
        'topo.texto': '',
        'topo.botao': 'a\nb',
        'cta.foto': 'assets/fotos/frota-patio.jpg',
      },
    });
    expect(Object.keys(r2.json.fields ?? {}).sort()).toEqual([
      'contato.instagram',
      'cta.foto',
      'nao.existe',
      'numeros.n1',
      'topo.botao',
      'topo.texto',
    ]);
    expect(t.gh.head).toBe(before);
  });

  test('pedido malformado: base ausente/errada, nada para mudar, foto demais', async () => {
    expect((await publish({ changes: { 'topo.botao': 'x' } })).status).toBe(400);
    expect((await publish({ base: 'main', changes: { 'topo.botao': 'x' } })).status).toBe(400);
    const { commit: base } = await t.content(tok);
    expect((await publish({ base, changes: {} })).json.error).toBe('Nenhuma alteração.');
    const seven = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => ['k' + String(i), { type: 'image/jpeg', data: b64(JPG) }]),
    );
    expect((await publish({ base, images: seven })).status).toBe(400);
  });

  test('limite de MAX_CHANGES (200) campos por pedido: 200 passa do limite, 201 é recusado antes do GitHub', async () => {
    expect(MAX_CHANGES).toBe(200);
    const { commit: base } = await t.content(tok);
    const many = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => ['x.campo' + String(i), 'v']));
    const before = t.gh.calls.length;
    const over = await publish({ base, changes: many(MAX_CHANGES + 1) });
    expect(over.status).toBe(400);
    expect(over.json.error).toBe('Alterações demais de uma vez.');
    expect(t.gh.calls.length).toBe(before);
    // exatamente no limite: passa da contagem e cai na validação por campo (chaves fora do esquema)
    const at = await publish({ base, changes: many(MAX_CHANGES) });
    expect(at.status).toBe(422);
    expect(Object.keys(at.json.fields ?? {})).toHaveLength(MAX_CHANGES);
    expect(t.gh.text('index.html')).toBe(INDEX);
  });

  test('campo com valor igual ao atual não é reaplicado; nada mudou de fato: 400', async () => {
    const { commit: base } = await t.content(tok);
    const r = await publish({
      base,
      changes: {
        'topo.botao': '  Fazer cotação grátis  ',
        'contato.whatsapp': '555193775912',
        'local.rs_endereco':
          'RS-118, R. Lateral, 12440 – Jardim Betânia\r\nCachoeirinha – RS · CEP 94970-850',
      },
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('Nenhuma alteração.');
    expect(t.gh.text('index.html')).toBe(INDEX);
  });

  test('fotos inválidas: bytes mágicos falsos, tipo divergente, grande demais (413), tipo não aceito', async () => {
    const { commit: base } = await t.content(tok);
    const svg = b64(new TextEncoder().encode('<svg onload=alert(1)></svg>'));
    const cases: [unknown, number][] = [
      [{ type: 'image/jpeg', data: svg }, 422],
      [{ type: 'image/jpeg', data: b64(PNG) }, 422],
      [{ type: 'image/svg+xml', data: b64(JPG) }, 422],
      [{ type: 'image/jpeg', data: 'não é base64' }, 422],
      ['string', 422],
    ];
    for (const [img, status] of cases) {
      const r = await publish({ base, images: { 'cta.foto': img } });
      expect(r.status, JSON.stringify(img).slice(0, 60)).toBe(status);
      expect(r.json.fields).toHaveProperty('cta.foto');
    }
    const big = new Uint8Array(3 * 1024 * 1024 + 1);
    big.set(JPG);
    const large = await publish({ base, images: { 'cta.foto': { type: 'image/jpeg', data: b64(big) } } });
    expect(large.status).toBe(413);
    expect(large.json.code).toBe('too_large');
    const notImage = await publish({
      base,
      images: { 'topo.botao': { type: 'image/jpeg', data: b64(JPG) } },
    });
    expect(notImage.status).toBe(422);
    expect(t.gh.text('index.html')).toBe(INDEX);
  });

  test('corpo acima de 12 MB: 413 antes de qualquer chamada ao GitHub', async () => {
    const calls = t.gh.calls.length;
    const r = await t.call('POST', '/publish', {
      token: tok,
      raw: '{"base":"' + 'a'.repeat(40) + '","x":"' + 'x'.repeat(12 * 1024 * 1024) + '"}',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(r.status).toBe(413);
    expect(t.gh.calls.length).toBe(calls);
  });
});

describe('/publish: base, rebase e conflito por campo', () => {
  test('base diferente do HEAD, campos diferentes: rebase sobre o HEAD (mantém a mudança do outro)', async () => {
    const { commit: base } = await t.content(tok);
    const other = INDEX.replace('>Seguradora Tokio</span>', '>Seguradora X</span>');
    await t.gh.commitFiles({ 'index.html': other }, 'outra pessoa');
    const head = t.gh.head;
    const r = await publish({ base, changes: { 'topo.selo2': 'Brasil inteiro' } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const h = t.gh.text('index.html');
    expect(h).toContain('>Seguradora X</span>');
    expect(h).toContain('>Brasil inteiro</span>');
    expect(t.gh.commit().parents).toEqual([head]);
  });

  test('outra pessoa mudou o MESMO campo: 409 conflict com o campo em fields; nada é escrito', async () => {
    const { commit: base } = await t.content(tok);
    await t.gh.commitFiles(
      { 'index.html': INDEX.replace('>Seguradora Tokio</span>', '>Seguradora X</span>') },
      'outra',
    );
    const head = t.gh.head;
    const r = await publish({ base, changes: { 'topo.selo1': 'Minha versão', 'topo.selo2': 'ok' } });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('conflict');
    expect(r.json.error).toBe('O site foi alterado por outra pessoa. Recarregue o painel.');
    expect(Object.keys(r.json.fields ?? {})).toEqual(['topo.selo1']);
    expect(t.gh.head).toBe(head);
  });

  test('foto: conflito também vale para campo image', async () => {
    const { commit: base } = await t.content(tok);
    await t.gh.commitFiles(
      {
        'index.html': INDEX.replace(
          'src="assets/fotos/volvo-cegonha.jpg"',
          'src="assets/fotos/frota-patio.jpg"',
        ),
      },
      'outra',
    );
    const r = await publish({ base, images: { 'cta.foto': { type: 'image/jpeg', data: b64(JPG) } } });
    expect(r.status).toBe(409);
    expect(r.json.fields).toHaveProperty('cta.foto');
  });

  test('base que não existe: 409', async () => {
    const r = await publish({ base: 'f'.repeat(40), changes: { 'topo.botao': 'x y' } });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('conflict');
  });

  test('corrida entre a leitura e o PATCH: refaz sobre o HEAD novo (2ª tentativa), um commit só', async () => {
    const { commit: base } = await t.content(tok);
    t.gh.beforePatch = async (gh) => {
      await gh.commitFiles(
        { 'index.html': gh.text('index.html').replace('>Seguradora Tokio</span>', '>Seguradora X</span>') },
        'corrida',
      );
    };
    const r = await publish({ base, changes: { 'topo.selo2': 'Brasil inteiro' } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const h = t.gh.text('index.html');
    expect(h).toContain('>Seguradora X</span>');
    expect(h).toContain('>Brasil inteiro</span>');
    expect(t.gh.commit().message).toContain('topo.selo2');
    expect(t.gh.commit(t.gh.commit().parents[0]).message).toBe('corrida');
    expect(t.logs.some((l) => l.includes('"event":"publish"') && l.includes('"attempts":2'))).toBe(true);
  });

  test('corrida mexendo no MESMO campo durante o PATCH: 409 na nova tentativa', async () => {
    const { commit: base } = await t.content(tok);
    t.gh.beforePatch = async (gh) => {
      await gh.commitFiles(
        { 'index.html': gh.text('index.html').replace('>Todo o Brasil há 6 anos</span>', '>Outro</span>') },
        'corrida',
      );
    };
    const r = await publish({ base, changes: { 'topo.selo2': 'Brasil inteiro' } });
    expect(r.status).toBe(409);
    expect(r.json.fields).toHaveProperty('topo.selo2');
  });

  test('branch andando sem parar: desiste depois de 3 tentativas com 409', async () => {
    const { commit: base } = await t.content(tok);
    let n = 0;
    const bump = async (gh: typeof t.gh): Promise<void> => {
      n++;
      await gh.commitFiles({ ['outro-' + String(n) + '.txt']: 'x' }, 'ruído ' + String(n));
      gh.beforePatch = bump;
    };
    t.gh.beforePatch = bump;
    const r = await publish({ base, changes: { 'topo.selo2': 'Brasil inteiro' } });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/várias vezes/);
    expect(t.gh.calls.filter((c) => c.method === 'PATCH')).toHaveLength(3);
    t.gh.beforePatch = null;
  });
});

describe('/publish: rebase avisa o painel e confere o valor que o painel viu (C1)', () => {
  test('rebase: a resposta diz rebased e quais campos outra pessoa mudou entre a base e o HEAD', async () => {
    const { commit: base } = await t.content(tok);
    const r0 = await publish({ base, changes: { 'topo.botao': 'Cotação já' } });
    expect(r0.json).toMatchObject({ rebased: false });
    expect(r0.json.othersChanged).toBeUndefined();
    await t.gh.commitFiles(
      { 'index.html': t.gh.text('index.html').replace('>do Brasil.</span>', '>VALOR-DA-OUTRA</span>') },
      'outra pessoa',
    );
    const r = await publish({ base: String(r0.json.commit), changes: { 'topo.selo1': 'Selo de A' } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.rebased).toBe(true);
    expect(r.json.othersChanged).toEqual(['topo.titulo3']);
  });

  test('B4: base já avançada pelo rebase, mas o valor que o painel viu está velho: 409 no campo', async () => {
    const { commit: base0 } = await t.content(tok);
    // B1: outra pessoa publica titulo3
    await t.gh.commitFiles(
      { 'index.html': INDEX.replace('>do Brasil.</span>', '>VALOR-DA-OUTRA</span>') },
      'outra pessoa',
    );
    // B2: A publica selo1 com base velha (rebase) e recebe a base nova
    const b2 = await publish({ base: base0, changes: { 'topo.selo1': 'Selo de A' }, expected: {} });
    expect(b2.status).toBe(200);
    const base1 = String(b2.json.commit);
    // B4: A edita titulo3 ainda vendo o valor antigo ("do Brasil.") como original
    const head = t.gh.head;
    const b4 = await publish({
      base: base1,
      changes: { 'topo.titulo3': 'A sem ver a mudança' },
      expected: { 'topo.titulo3': 'do Brasil.' },
    });
    expect(b4.status, JSON.stringify(b4.json)).toBe(409);
    expect(b4.json.code).toBe('conflict');
    expect(Object.keys(b4.json.fields ?? {})).toEqual(['topo.titulo3']);
    expect(t.gh.head).toBe(head);
    expect(t.gh.text('index.html')).toContain('>VALOR-DA-OUTRA</span>');
    // com o valor certo (o painel recarregou depois do rebase) publica
    const ok = await publish({
      base: base1,
      changes: { 'topo.titulo3': 'A ciente da mudança' },
      expected: { 'topo.titulo3': 'VALOR-DA-OUTRA' },
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  });

  test('expected compara na forma canônica do tipo e vale para foto; formato inválido é 400', async () => {
    const { commit: base } = await t.content(tok);
    const r = await publish({
      base,
      changes: { 'contato.whatsapp': '(11) 91234-5678', 'topo.selo1': 'Novo selo' },
      images: { 'cta.foto': { type: 'image/jpeg', data: b64(JPG) } },
      expected: {
        'contato.whatsapp': '555193775912',
        'topo.selo1': '  Seguradora   Tokio ',
        'cta.foto': 'assets/fotos/volvo-cegonha.jpg',
      },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const { commit: base2 } = await t.content(tok);
    const foto = await publish({
      base: base2,
      images: { 'cta.foto': { type: 'image/jpeg', data: b64(JPG) } },
      expected: { 'cta.foto': 'assets/fotos/volvo-cegonha.jpg' },
    });
    expect(foto.status).toBe(409);
    expect(foto.json.fields).toHaveProperty('cta.foto');
    for (const expected of ['x', { 'topo.selo1': 5 }, { 'nao.mudou': 'x' }]) {
      const bad = await publish({ base: base2, changes: { 'topo.selo1': 'Outro' }, expected });
      expect(bad.status, JSON.stringify(expected)).toBe(400);
    }
  });
});

describe('/publish: tipo diferente no HEAD também é conflito (C10)', () => {
  test('outra pessoa trocou o tipo do campo (phone -> text) sem mudar o valor: 409 no campo', async () => {
    const { commit: base } = await t.content(tok);
    const html = INDEX.replace(' data-cms-href="contato.tel1"', '').replace(
      'data-cms="contato.tel1" data-cms-type="phone"',
      'data-cms="contato.tel1" data-cms-type="text"',
    );
    const s = JSON.parse(SCHEMA) as { fields: { key: string; type: string; max: number }[] };
    const f = s.fields.find((x) => x.key === 'contato.tel1');
    if (f) f.type = 'text';
    const schema = JSON.stringify(s);
    expect(checkAgainstSchema(html, parseSchema(JSON.parse(schema)))).toEqual({});
    expect(extractFields(html).byKey.get('contato.tel1')?.value).toBe(
      extractFields(INDEX).byKey.get('contato.tel1')?.value,
    );
    await t.gh.commitFiles({ 'index.html': html, 'cms/schema.json': schema }, 'tipo do telefone');
    const head = t.gh.head;
    const r = await publish({ base, changes: { 'contato.tel1': '(51) 3333-4444' } });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(Object.keys(r.json.fields ?? {})).toEqual(['contato.tel1']);
    expect(t.gh.head).toBe(head);
  });
});

describe('/publish: letras que mudam de tamanho em minúsculas (C5)', () => {
  test('"İstanbul" num texto publica certo e o HTML continua batendo com o esquema', async () => {
    const { commit: base } = await t.content(tok);
    const r = await publish({ base, changes: { 'seo.titulo': 'İstanbul İİİ', 'topo.titulo1': 'İzmir' } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const html = t.gh.text('index.html');
    expect(checkAgainstSchema(html, parseSchema(JSON.parse(SCHEMA)))).toEqual({});
    const v = extractFields(html).byKey;
    expect(v.get('seo.titulo')?.value).toBe('İstanbul İİİ');
    expect(v.get('topo.titulo1')?.value).toBe('İzmir');
  });

  test('verificação de integridade forçada a falhar: erro claro 422 "integrity" com o campo, sem commit', async () => {
    const gh = t.gh;
    const git = createGitHub({
      apiBase: 'https://api.github.com',
      owner: gh.owner,
      repo: gh.repo,
      branch: gh.branch,
      token: gh.token,
      fetch: gh.fetch,
    });
    const head = gh.head;
    const ctx: PublishContext = {
      git,
      username: 'ana',
      page: 'index.html',
      schemaPath: 'cms/schema.json',
      maxImageBytes: 1024,
      now: () => 0,
      // editor "quebrado": grava o valor errado (simula um bug futuro do editor)
      editor: (src, f, v) => applySource(src, f, v + ' (corrompido)'),
    };
    const err = await publishDirect(ctx, {
      base: head,
      changes: { 'topo.selo1': 'Novo' },
      images: {},
      expected: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ code: 'integrity', status: 422 });
    expect(Object.keys((err as HttpError).fields ?? {})).toEqual(['topo.selo1']);
    expect(gh.head).toBe(head);
    // pela rota: o roteador devolve o 422 "integrity" (não um 500 genérico) e registra o evento
    const logged: LogEntry[] = [];
    const out = toHttpError(err, (l) => logged.push(l));
    expect(out).toMatchObject({ code: 'integrity', status: 422 });
    expect(errorBody(out)).toMatchObject({
      ok: false,
      code: 'integrity',
      fields: { 'topo.selo1': expect.any(String) as unknown },
    });
    expect(logged).toEqual([
      { level: 'error', event: 'publish_integrity', error: 'topo.selo1: não ficou como esperado' },
    ]);
  });
});

describe('/publish: barreira de esquema da verificação final (rodada 2, item 1)', () => {
  test('editor que mantém os valores mas quebra a estrutura (marcador duplicado): 422 integrity, sem commit, log', async () => {
    const gh = t.gh;
    const git = createGitHub({
      apiBase: 'https://api.github.com',
      owner: gh.owner,
      repo: gh.repo,
      branch: gh.branch,
      token: gh.token,
      fetch: gh.fetch,
    });
    const head = gh.head;
    const calls = gh.calls.length;
    const ctx: PublishContext = {
      git,
      username: 'ana',
      page: 'index.html',
      schemaPath: 'cms/schema.json',
      maxImageBytes: 1024,
      now: () => 0,
      // aplica o valor certo e, de quebra, cola uma cópia do marcador no fim do body: a primeira ocorrência
      // (a que a leitura usa) continua com o valor pedido, então só a checagem de esquema pega
      editor: (src, f, v) =>
        applySource(src, f, v).replace('</body>', '<span data-cms="' + f.key + '">cópia</span></body>'),
    };
    const err = await publishDirect(ctx, {
      base: head,
      changes: { 'topo.selo1': 'Novo selo' },
      images: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ code: 'integrity', status: 422 });
    expect(Object.keys((err as HttpError).fields ?? {})).toEqual(['topo.selo1']);
    expect(gh.head).toBe(head);
    const writes = gh.calls.slice(calls).filter((c) => c.method !== 'GET');
    expect(writes).toEqual([]);
    const logged: LogEntry[] = [];
    const out = toHttpError(err, (l) => logged.push(l));
    expect(errorBody(out)).toMatchObject({ ok: false, code: 'integrity' });
    expect(logged).toEqual([
      { level: 'error', event: 'publish_integrity', error: 'topo.selo1: o resultado não passa no esquema' },
    ]);
  });
});

describe('/publish: esquema do mesmo commit', () => {
  test('HEAD com marcador faltando: 409 schema_mismatch com detalhes; nada é escrito', async () => {
    const { commit: base } = await t.content(tok);
    await t.gh.commitFiles({ 'index.html': INDEX.replace(' data-cms="topo.botao"', '') }, 'quebrou');
    const head = t.gh.head;
    const r = await publish({ base, changes: { 'topo.selo2': 'x y' } });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('schema_mismatch');
    expect(r.json.fields).toEqual({ 'topo.botao': 'Marcador faltando no HTML.' });
    expect(t.gh.head).toBe(head);
  });

  test('marcador duplicado e tipo diferente no HEAD: schema_mismatch', async () => {
    const { commit: base } = await t.content(tok);
    await t.gh.commitFiles(
      {
        'index.html': INDEX.replace(
          'data-cms="numeros.n1" data-cms-type="number"',
          'data-cms="numeros.n1" data-cms-type="text"',
        ),
      },
      'tipo',
    );
    const r = await publish({ base, changes: { 'topo.selo2': 'x y' } });
    expect(r.json.code).toBe('schema_mismatch');
    expect(r.json.fields?.['numeros.n1']).toMatch(/Tipo diferente/);
  });

  test('o esquema lido é o do MESMO commit: schema.json removido/ inválido no HEAD recusa', async () => {
    const { commit: base } = await t.content(tok);
    await t.gh.commitFiles({ 'cms/schema.json': '{"version":1}' }, 'esquema ruim');
    const r = await publish({ base, changes: { 'topo.selo2': 'x y' } });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('schema_mismatch');
    expect(r.json.fields).toHaveProperty(['cms/schema.json']);
    expect((await t.call('GET', '/content', { token: tok })).json.schemaVersion).toBeNull();
  });

  test('limite apertado no esquema do HEAD vale na validação', async () => {
    const s = JSON.parse(SCHEMA) as { fields: { key: string; max: number }[] };
    const f = s.fields.find((x) => x.key === 'topo.selo2');
    if (f) f.max = 5;
    await t.gh.commitFiles({ 'cms/schema.json': JSON.stringify(s) }, 'aperta');
    const { commit: base } = await t.content(tok);
    const r = await publish({ base, changes: { 'topo.selo2': 'grande demais' } });
    expect(r.status).toBe(422);
    expect(r.json.fields?.['topo.selo2']).toBe('Máximo de 5 caracteres.');
  });
});

describe('/history e /restore', () => {
  test('histórico lista commits do index.html com data, autor e mensagem', async () => {
    const { commit: base } = await t.content(tok);
    await publish({ base, changes: { 'topo.botao': 'Cotação já' } });
    await t.gh.commitFiles({ 'outro.txt': 'x' }, 'não toca o index');
    const h = await t.call('GET', '/history', { token: tok });
    expect(h.status).toBe(200);
    const versions = h.json.versions as { commit: string; date: string; author: string; message: string }[];
    expect(versions.map((v) => v.message)).toEqual([
      'Painel: ana alterou 1 campo(s)\n\n- topo.botao: Botão principal\n',
      'Estado inicial',
    ]);
    expect(versions[0]).toMatchObject({ author: 'ana (painel)', date: '2026-11-17T12:00:00.000Z' });
  });

  test('restore: mesmo pipeline (um commit, base = HEAD, esquema validado)', async () => {
    const first = t.gh.head;
    const { commit: base } = await t.content(tok);
    await publish({ base, changes: { 'topo.botao': 'Cotação já' } });
    const head = t.gh.head;
    const stale = await t.call('POST', '/restore', { token: tok, body: { commit: first, base: first } });
    expect(stale.status).toBe(409);
    expect(
      (await t.call('POST', '/restore', { token: tok, body: { commit: 'main', base: head } })).status,
    ).toBe(400);
    expect(
      (await t.call('POST', '/restore', { token: tok, body: { commit: 'a'.repeat(40), base: head } })).status,
    ).toBe(404);
    const r = await t.call('POST', '/restore', { token: tok, body: { commit: first, base: head } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toEqual({ ok: true, commit: t.gh.head });
    expect(t.gh.text('index.html')).toBe(INDEX);
    expect(t.gh.commit().parents).toEqual([head]);
    expect(t.gh.commit().message).toBe('Painel: ana voltou o site para a versão ' + first.slice(0, 7) + '\n');
    expect(t.gh.changedFiles()).toEqual(['index.html']);
    const same = await t.call('POST', '/restore', { token: tok, body: { commit: first, base: t.gh.head } });
    expect(same.status).toBe(400);
  });

  test('S1: restore só aceita commit do histórico do branch que tocou o index.html; fora: 404', async () => {
    const pr = await t.gh.commitDetached(
      { 'index.html': INDEX.replace('>Seguradora Tokio<', '>CONTEUDO-DE-PR<') },
      'PR não mesclado (refs/pull/1/head)',
    );
    const head = t.gh.head;
    expect(t.gh.commit(pr).parents).toEqual([head]);
    const r = await t.call('POST', '/restore', { token: tok, body: { commit: pr, base: head } });
    expect(r.status, JSON.stringify(r.json)).toBe(404);
    expect(r.json.code).toBe('not_found');
    expect(t.gh.head).toBe(head);
    expect(t.gh.text('index.html')).not.toContain('CONTEUDO-DE-PR');
    // commit do branch que NÃO tocou o index.html também não é "versão"
    const other = await t.gh.commitFiles({ 'outro.txt': 'x' }, 'não toca o index');
    const r2 = await t.call('POST', '/restore', { token: tok, body: { commit: other, base: t.gh.head } });
    expect(r2.status).toBe(404);
  });

  test('restore de versão que não passa no esquema atual: 409 schema_mismatch', async () => {
    const broken = await t.gh.commitFiles(
      { 'index.html': INDEX.replace(' data-cms="topo.botao"', '') },
      'sem marcador',
    );
    const good = await t.gh.commitFiles(
      { 'index.html': INDEX.replace('>Seguradora Tokio<', '>Seg<') },
      'conserta',
    );
    const r = await t.call('POST', '/restore', { token: tok, body: { commit: broken, base: good } });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('schema_mismatch');
    expect(t.gh.head).toBe(good);
  });
});

describe('GitHub: falhas, token e validade', () => {
  test('GitHub fora do ar ou 500: 502 upstream genérico, sem vazar token', async () => {
    t.gh.down = true;
    const r = await t.call('GET', '/content', { token: tok });
    expect(r.status).toBe(502);
    expect(r.json).toEqual({
      ok: false,
      error: 'O GitHub não respondeu como esperado. Tente de novo em instantes.',
      code: 'upstream',
    });
    t.gh.down = false;
    t.gh.failWhen = { re: /^POST .*\/git\/commits$/, status: 500 };
    const { commit: base } = await t.content(tok);
    const p = await publish({ base, changes: { 'topo.botao': 'x y' } });
    expect(p.status).toBe(502);
    expect(JSON.stringify(p.json) + t.logs.join('')).not.toContain('dev-token');
  });

  test('o token vai como Bearer só para o GitHub; credencial recusada vira 502 com log de erro', async () => {
    t.gh.token = 'outro';
    const r = await t.call('GET', '/content', { token: tok });
    expect(r.status).toBe(502);
    expect(
      t.logs.some(
        (l) =>
          l.includes('"event":"github_error"') &&
          l.includes('"code":"github_401"') &&
          l.includes('"level":"error"'),
      ),
    ).toBe(true);
  });

  test('/me para admin traz githubTokenExpiresAt (cabeçalho do GitHub); editor não vê', async () => {
    const me = await t.call('GET', '/me', { token: tok });
    expect(me.json.githubTokenExpiresAt).toBe('2027-01-15T12:00:00.000Z');
    t.gh.tokenExpiration = '2027-02-01 00:00:00 -0300';
    await t.call('GET', '/content', { token: tok }); // qualquer chamada atualiza
    expect((await t.call('GET', '/me', { token: tok })).json.githubTokenExpiresAt).toBe(
      '2027-02-01T03:00:00.000Z',
    );
    await t.addUser('edu', PASS, 'editor');
    const ed = await t.login('edu', PASS);
    const edMe = await t.call('GET', '/me', { token: ed });
    expect(edMe.json).toEqual({ ok: true, user: { username: 'edu', role: 'editor' } });
  });
});

describe('editor (não admin) publica e restaura', () => {
  test('publish e restore com sessão de editor: commit com o nome dele e auditoria', async () => {
    await t.addUser('edu', PASS2, 'editor');
    const ed = await t.login('edu', PASS2);
    const first = t.gh.head;
    const { commit: base } = await t.content(ed);
    const r = await publish({ base, changes: { 'topo.botao': 'Cotação já' } }, ed);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toEqual({ ok: true, commit: t.gh.head, changed: ['topo.botao'], rebased: false });
    expect(t.gh.text('index.html')).toContain('data-cms-label="Botão principal">Cotação já</span>');
    expect(t.gh.commit().message).toBe('Painel: edu alterou 1 campo(s)\n\n- topo.botao: Botão principal\n');
    expect(t.gh.commit().author).toMatchObject({
      name: 'edu (painel)',
      email: 'edu@painel.hgtransportes.invalid',
    });

    expect((await t.call('GET', '/history', { token: ed })).status).toBe(200);
    const head = t.gh.head;
    const rs = await t.call('POST', '/restore', { token: ed, body: { commit: first, base: head } });
    expect(rs.status, JSON.stringify(rs.json)).toBe(200);
    expect(t.gh.text('index.html')).toBe(INDEX);
    expect(t.gh.commit().parents).toEqual([head]);
    expect(t.gh.commit().message).toBe('Painel: edu voltou o site para a versão ' + first.slice(0, 7) + '\n');

    const a = await t.call('GET', '/audit', { token: tok });
    const entries = a.json.entries as { action: string; username: string }[];
    expect(entries.slice(0, 2).map((e) => [e.action, e.username])).toEqual([
      ['restore', 'edu'],
      ['publish', 'edu'],
    ]);
  });
});

describe('auditoria de conteúdo', () => {
  test('publish e restore entram na auditoria com valor antigo/novo, sem token', async () => {
    const first = t.gh.head;
    const { commit: base } = await t.content(tok);
    await publish({ base, changes: { 'topo.botao': 'Cotação já' } });
    await t.call('POST', '/restore', { token: tok, body: { commit: first, base: t.gh.head } });
    const a = await t.call('GET', '/audit', { token: tok });
    const entries = a.json.entries as { action: string; detail: Record<string, unknown> | null }[];
    expect(entries.map((e) => e.action).slice(0, 3)).toEqual(['restore', 'publish', 'login_ok']);
    expect(entries[1]?.detail).toMatchObject({
      base,
      rebased: false,
      attempts: 1,
      changes: [{ key: 'topo.botao', old: 'Fazer cotação grátis', new: 'Cotação já' }],
    });
    expect(JSON.stringify(a.json)).not.toContain(tok);
  });
});
