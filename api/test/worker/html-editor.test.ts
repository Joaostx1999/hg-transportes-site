import { describe, expect, test } from 'vitest';
import {
  applySource,
  derivedHref,
  editTags,
  escAttr,
  escHtml,
  fmtNumber,
  fmtWhats,
  mapsHref,
  normWhats,
  setAttrInTag,
  telHref,
} from '../../src/html-editor.ts';
import { extractFields, type FieldValue } from '../../src/schema.ts';
import { diffRange, INDEX as SRC } from './helpers.ts';

const { byKey } = extractFields(SRC);
const F = (k: string): FieldValue => {
  const f = byKey.get(k);
  if (!f) throw new Error('sem campo ' + k);
  return f;
};

describe('edição cirúrgica (porta do protótipo)', () => {
  test('texto muda só o conteúdo do elemento marcado, resto byte a byte igual', () => {
    const out = applySource(SRC, F('topo.texto'), 'Texto novo');
    const tagStart = SRC.indexOf('<p class="lead fade-up d1" data-cms="topo.texto"');
    const innerStart = SRC.indexOf('>', tagStart) + 1;
    const innerEnd = SRC.indexOf('</p>', innerStart);
    expect(out).toBe(SRC.slice(0, innerStart) + 'Texto novo' + SRC.slice(innerEnd));
    const d = diffRange(SRC, out);
    expect(d.start).toBeGreaterThanOrEqual(innerStart);
    expect(d.endA).toBeLessThanOrEqual(innerEnd);
  });

  test('escape: <script> e aspas viram texto, em conteúdo e em atributo', () => {
    const evil = '<script>alert(1)</script>" onmouseover="x';
    const t = applySource(SRC, F('topo.titulo1'), evil);
    expect(t).not.toContain('<script>alert(1)</script>');
    expect(t).toContain('&lt;script&gt;alert(1)&lt;/script&gt;" onmouseover="x');
    const m = applySource(SRC, F('seo.descricao'), evil);
    expect(m).toContain('content="&lt;script&gt;alert(1)&lt;/script&gt;&quot; onmouseover=&quot;x"');
    expect(m).not.toMatch(/content="[^"]*" onmouseover="x"/);
    const tt = applySource(SRC, F('seo.titulo'), '</title><script>x</script>');
    expect(tt).toContain(
      '<title data-cms="seo.titulo" data-cms-label="Título na aba e no Google">&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;</title>',
    );
  });

  test("$ é texto: $&, $1, $` e $' não viram padrão de substituição", () => {
    for (const v of ['https://x.com/?a=$&b=$1', "https://x.com/$`$'"]) {
      expect(applySource(SRC, F('contato.instagram'), v)).toContain('href="' + escAttr(v) + '"');
    }
    expect(applySource(SRC, F('topo.botao'), 'R$ 1.000 $& $1')).toContain('>R$ 1.000 $&amp; $1</span>');
    expect(applySource(SRC, F('seo.descricao'), 'custa $& $1')).toContain('content="custa $& $1"');
  });

  test('escHtml / escAttr', () => {
    expect(escHtml('a & <b> "c"')).toBe('a &amp; &lt;b&gt; "c"');
    expect(escAttr('a&b=1&amp;c "d" <e>')).toBe('a&b=1&amp;amp;c &quot;d&quot; &lt;e&gt;');
  });

  test('meta: só o atributo content muda', () => {
    const f = F('seo.descricao');
    const out = applySource(SRC, f, 'Nova descrição');
    expect(out).toContain(
      '<meta name="description" data-cms="seo.descricao" data-cms-type="meta" data-cms-label="Descrição que aparece no Google" content="Nova descrição">',
    );
    expect(out.length - SRC.length).toBe('Nova descrição'.length - f.value.length);
  });

  test('address: linhas viram <br>, link do mapa derivado, outros endereços intactos', () => {
    const out = applySource(SRC, F('local.rs_endereco'), 'Rua A, 1 & 2\nPorto Alegre – RS');
    expect(out).toContain(
      'data-cms-label="Base RS — endereço (o link do mapa acompanha)">Rua A, 1 &amp; 2<br>Porto Alegre – RS</p>',
    );
    expect(out).toContain(
      '<a data-cms-href="local.rs_endereco" href="' +
        mapsHref('Rua A, 1 & 2\nPorto Alegre – RS') +
        '" target="_blank"',
    );
    expect(mapsHref('a\nb')).toBe('https://www.google.com/maps/search/?api=1&query=a%2C%20b');
    expect(out).toContain(/<a data-cms-href="local\.pr_endereco"[^>]*>/.exec(SRC)?.[0]);
  });

  test('number: data-count e texto; data-sep usa separador pt-BR', () => {
    expect(applySource(SRC, F('numeros.n1'), '12000')).toContain(
      '<span data-count="12000" data-cms="numeros.n1" data-cms-type="number" data-cms-label="Número 1">12000</span>',
    );
    expect(applySource(SRC, F('numeros.n2'), '1234567')).toContain(
      '<span data-count="1234567" data-sep data-cms="numeros.n2" data-cms-type="number" data-cms-label="Número 2">1.234.567</span>',
    );
    expect(fmtNumber(true, '4000')).toBe((4000).toLocaleString('pt-BR'));
    expect(fmtNumber(true, '999')).toBe('999');
    expect(fmtNumber(false, '4000')).toBe('4000');
  });

  test('phone: texto e href tel: derivado; os outros telefones intactos', () => {
    const out = applySource(SRC, F('contato.tel2'), '(51) 3333-4444');
    expect(out).toContain('<a data-cms-href="contato.tel2" href="tel:+555133334444">');
    expect(out).toContain('data-cms-label="Telefone 2">(51) 3333-4444</span>');
    expect(out).toContain('href="tel:+5551993775912"');
    expect(telHref('+55 (51) 99377-5912')).toBe('tel:+5551993775912');
  });

  test('whatsapp: content normalizado e phone= dos dois links, preservando &text', () => {
    const out = applySource(SRC, F('contato.whatsapp'), '(11) 91234-5678');
    expect(out).toContain(
      'data-cms-label="Número do WhatsApp (recebe as cotações)" content="5511912345678">',
    );
    const links = out.match(/<a[^>]*data-cms-href="contato\.whatsapp"[^>]*>/g) ?? [];
    expect(links).toHaveLength(2);
    for (const a of links)
      expect(a).toContain(
        'href="https://api.whatsapp.com/send?phone=5511912345678&text=Ol%C3%A1%2C%20gostaria',
      );
    expect(normWhats('(51) 99377-5912')).toBe('5551993775912');
    expect(fmtWhats('555193775912')).toBe('(51) 9377-5912');
    expect(fmtWhats('5551993775912')).toBe('(51) 99377-5912');
  });

  test('email, link e image: só o trecho certo muda', () => {
    const e = applySource(SRC, F('contato.email'), 'contato@hg.com.br');
    expect(e).toContain('<a data-cms-href="contato.email" href="mailto:contato@hg.com.br">');
    const l = applySource(SRC, F('contato.facebook'), 'https://www.facebook.com/novo');
    expect(l).toContain(
      'data-cms-label="Link do Facebook" href="https://www.facebook.com/novo" target="_blank"',
    );
    expect(l).toContain('href="https://www.instagram.com/hgtransportesrs/"');
    const i = applySource(SRC, F('cta.foto'), 'assets/fotos/cms-0123456789abcdef.webp');
    expect(i).toContain(
      '<img data-cms="cta.foto" data-cms-type="image" data-cms-label="Foto" src="assets/fotos/cms-0123456789abcdef.webp" alt=',
    );
  });

  test('derivedHref e setAttrInTag', () => {
    expect(derivedHref('whatsapp', '(11) 91234-5678', 'https://x/?phone=123&text=a')).toBe(
      'https://x/?phone=5511912345678&text=a',
    );
    expect(derivedHref('email', ' a@b.co ', '')).toBe('mailto:a@b.co');
    expect(derivedHref('text', 'x', 'cur')).toBe('cur');
    expect(setAttrInTag('<img src="a.jpg">', 'alt', 'x"y')).toBe('<img src="a.jpg" alt="x&quot;y">');
    expect(setAttrInTag('<span data-sep data-count="1">', 'data-count', '2')).toBe(
      '<span data-sep data-count="2">',
    );
    expect(setAttrInTag('<img src="a.jpg"/>', 'src', 'b.jpg')).toBe('<img src="b.jpg"/>');
  });

  test('campo inexistente e marcador quebrado dão erro', () => {
    expect(() => applySource(SRC, { key: 'nao.existe', type: 'text' }, 'x')).toThrow(/não foi encontrado/);
    expect(() =>
      editTags('<p data-cms="a">sem fechar', 'data-cms', 'a', (t) => ({ tag: t, inner: 'x' })),
    ).toThrow(/Marcador quebrado/);
  });
});
