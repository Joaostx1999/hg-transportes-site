import { describe, expect, test } from 'vitest';
import {
  buildSchema,
  checkAgainstSchema,
  extractFields,
  parseSchema,
  serializeSchema,
  SchemaError,
} from '../../src/schema.ts';
import { INDEX as SRC, SCHEMA } from './helpers.ts';

const schema = parseSchema(JSON.parse(SCHEMA));

describe('extração dos campos', () => {
  test('tipos, valores e grupos do site real (mesma leitura do protótipo)', () => {
    const { list, byKey } = extractFields(SRC);
    expect(list).toHaveLength(98);
    const types: Record<string, number> = {};
    for (const f of list) types[f.type] = (types[f.type] ?? 0) + 1;
    expect(types).toEqual({
      text: 79,
      meta: 1,
      whatsapp: 1,
      number: 4,
      image: 4,
      address: 3,
      link: 2,
      phone: 3,
      email: 1,
    });
    expect(byKey.get('seo.titulo')?.value).toBe('HG Transportes | Transporte de veículos para todo o Brasil');
    expect(byKey.get('seo.titulo')?.group).toBe('Google (busca)');
    expect(byKey.get('contato.whatsapp')?.value).toBe('(51) 9377-5912');
    expect(byKey.get('contato.whatsapp')?.group).toBe('Contato e rodapé'); // grupo no próprio <meta>
    expect(byKey.get('numeros.n2')).toMatchObject({ value: '4000', sep: true, group: 'Números' });
    expect(byKey.get('local.rs_endereco')?.value).toBe(
      'RS-118, R. Lateral, 12440 – Jardim Betânia\nCachoeirinha – RS · CEP 94970-850',
    );
    expect(byKey.get('servicos.c1_foto')).toMatchObject({
      value: 'assets/fotos/frota-patio.jpg',
      group: 'Serviços',
    });
  });

  test('cms/schema.json versionado é exatamente o que o gerador produz hoje (sem desvio)', () => {
    expect(serializeSchema(buildSchema(SRC, 'index.html'))).toBe(SCHEMA);
  });

  test('grupo: do elemento, do ancestral, "Google (busca)" no head, "Outros" no resto', () => {
    const html =
      '<html><head><title data-cms="a">A</title><meta data-cms="b" data-cms-type="meta" data-cms-group="G1" content="x"></head>' +
      '<body><section data-cms-group="S"><div><p data-cms="c">C</p></div></section><p data-cms="d">D</p>' +
      '<!-- <p data-cms="e">comentário</p> --><script>var s = "<p data-cms=\\"f\\">";</script></body></html>';
    const { list } = extractFields(html);
    expect(list.map((f) => [f.key, f.group])).toEqual([
      ['a', 'Google (busca)'],
      ['b', 'G1'],
      ['c', 'S'],
      ['d', 'Outros'],
    ]);
  });
});

describe('checagem contra o esquema (schema_mismatch)', () => {
  test('o site real confere', () => {
    expect(checkAgainstSchema(SRC, schema)).toEqual({});
  });

  test('marcador faltando', () => {
    const html = SRC.replace(' data-cms="topo.botao"', '');
    expect(checkAgainstSchema(html, schema)).toEqual({ 'topo.botao': 'Marcador faltando no HTML.' });
  });

  test('marcador duplicado', () => {
    const html = SRC.replace('<span data-cms="topo.botao"', '<span data-cms="topo.selo1"');
    const p = checkAgainstSchema(html, schema);
    expect(p['topo.selo1']).toMatch(/duplicado/);
    expect(p['topo.botao']).toMatch(/faltando/);
  });

  test('tipo diferente', () => {
    const html = SRC.replace(
      'data-cms="numeros.n1" data-cms-type="number"',
      'data-cms="numeros.n1" data-cms-type="text"',
    );
    expect(checkAgainstSchema(html, schema)['numeros.n1']).toMatch(/Tipo diferente/);
  });

  test('marcador novo fora do esquema', () => {
    const html = SRC.replace('</footer>', '<p data-cms="novo.campo">x</p></footer>');
    expect(checkAgainstSchema(html, schema)['novo.campo']).toMatch(/não está no esquema/);
  });

  test('marcador dentro de comentário ou script conta como duplicado/lugar inválido', () => {
    const c = SRC.replace('</body>', '<!-- <span data-cms="topo.botao">velho</span> --></body>');
    expect(checkAgainstSchema(c, schema)['topo.botao']).toMatch(/duplicado/);
    const s = SRC.replace('</body>', '<script>var x = \'<b data-cms="zz.x">\';</script></body>');
    expect(checkAgainstSchema(s, schema)['zz.x']).toMatch(/não está no esquema/);
  });

  test('estruturas que a edição por regex corromperia são recusadas', () => {
    const nested = SRC.replace(
      'data-cms-label="Botão principal">Fazer cotação grátis</span>',
      'data-cms-label="Botão principal">Fazer <span>cotação</span> grátis</span>',
    );
    expect(checkAgainstSchema(nested, schema)['topo.botao']).toMatch(/aninhado/);
    const quote = SRC.replace(
      'data-cms="cta.foto" data-cms-type="image" data-cms-label="Foto" src="',
      'data-cms="cta.foto" data-cms-type="image" data-cms-label="Foto" data-x="a>b" src="',
    );
    expect(checkAgainstSchema(quote, schema)['cta.foto']).toMatch(/">"/);
    const sq = SRC.replace(/(data-cms="contato\.facebook"[^>]*?) href="([^"]*)"/, "$1 href='$2'");
    expect(sq).not.toBe(SRC);
    expect(checkAgainstSchema(sq, schema)['contato.facebook']).toMatch(/aspas duplas/);
    const href = SRC.replace('</footer>', '<a data-cms-href="topo.botao" href="#">x</a></footer>');
    expect(checkAgainstSchema(href, schema)['topo.botao']).toMatch(/data-cms-href só vale/);
  });
});

describe('formato do schema.json', () => {
  const base = JSON.parse(SCHEMA) as { fields: Record<string, unknown>[] };
  const mut = (f: (s: typeof base) => void): unknown => {
    const s = structuredClone(base);
    f(s);
    return s;
  };

  test('aceita o versionado e recusa formas inválidas', () => {
    expect(parseSchema(base).fields).toHaveLength(98);
    const bad: unknown[] = [
      null,
      [],
      { ...base, version: 2 },
      { ...base, fields: [] },
      mut((s) => (s.fields[0] = { ...s.fields[0], type: 'html' })),
      mut((s) => (s.fields[1] = { ...s.fields[1], key: s.fields[0]?.key })),
      mut((s) => (s.fields[0] = { ...s.fields[0], max: 601 })),
      mut((s) => (s.fields[0] = { ...s.fields[0], required: false })),
      mut((s) => (s.fields[0] = { ...s.fields[0], key: '../x' })),
    ];
    for (const b of bad) expect(() => parseSchema(b), JSON.stringify(b).slice(0, 80)).toThrow(SchemaError);
  });
});
