/* Testes de propriedade da edição cirúrgica (contrato v3, seção 6), sobre o index.html REAL e as 98 chaves.
 * Gerador pseudoaleatório com semente fixa (mulberry32): falhas são reproduzíveis. */
import { describe, expect, test } from 'vitest';
import { applySource, escAttr, mapsHref, type FieldType } from '../../src/html-editor.ts';
import { applyChanges } from '../../src/publish.ts';
import {
  checkAgainstSchema,
  extractFields,
  parseSchema,
  scanMarkers,
  schemaIndex,
} from '../../src/schema.ts';
import { canonicalValue, validateValue } from '../../src/validate.ts';
import { INDEX as SRC, SCHEMA } from './helpers.ts';

const schema = parseSchema(JSON.parse(SCHEMA));
const idx = schemaIndex(schema);
const { list, byKey } = extractFields(SRC);
const DERIVED_FROM_VALUE: ReadonlySet<FieldType> = new Set(['address']);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  '<',
  '>',
  '&',
  '"',
  "'",
  '\n',
  '/',
  '=',
  ' ',
  '  ',
  '$&',
  '$1',
  '$`',
  "$'",
  '$$',
  'ç',
  'ã',
  'É',
  '🚚',
  '👍🏽',
  ' ',
  ' ',
  '&amp;',
  '&lt;',
  '&#60;',
  '&#x3c;',
  '&quot;',
  '</span>',
  '</p>',
  '</title>',
  '<script>',
  '<br>',
  '<!--',
  '-->',
  ']]>',
  '<img src=x onerror=alert(1)>',
  '" onmouseover="x',
  "' autofocus '",
  'data-cms="x"',
  'a',
  'b',
  'Z',
  '0',
  '9',
  'https://',
  'phone=1',
  '\\',
  '`',
  '{',
  '}',
  '%20',
  '%3C',
  // muda de tamanho em toLowerCase/toUpperCase (C5): İ vira "i̇" (2 unidades), ß vira "SS" etc.
  'İ',
  'İSTANBUL',
  'ı',
  'ß',
  'ẞ',
  'ﬁ',
  'ŉ',
  'Σ',
  'K',
  'Å',
];

function hostile(rand: () => number): string {
  const n = Math.floor(rand() * 18);
  let s = '';
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(rand() * PIECES.length)] ?? '';
  return s;
}

/** Regiões que a edição de `key` pode tocar: o marcador (tag + conteúdo) e as tags data-cms-href. */
function regions(src: string, key: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of scanMarkers(src).markers) {
    if (m.key === key) out.push([m.tagStart, m.closeStart ?? m.tagEnd]);
  }
  const re = /<[a-zA-Z][\w-]*\b[^>]*\sdata-cms-href="([^"]*)"[^>]*>/g;
  let h: RegExpExecArray | null;
  while ((h = re.exec(src))) if (h[1] === key) out.push([h.index, h.index + h[0].length]);
  return out.sort((a, b) => a[0] - b[0]);
}

function gaps(src: string, rs: [number, number][]): string[] {
  const out: string[] = [];
  let last = 0;
  for (const [a, b] of rs) {
    out.push(src.slice(last, a));
    last = b;
  }
  out.push(src.slice(last));
  return out;
}

/** Nomes de atributo de uma tag (oráculo independente do tokenizador). */
function attrNames(tag: string): string[] {
  return [...tag.matchAll(/\s([^\s"'>/=]+)(?:="[^"]*")?/g)].map((m) => m[1] ?? '').sort();
}

/** Prova que editar `key` com `v` não criou tag nova nem mexeu fora das regiões do campo. */
function assertSurgical(before: string, after: string, key: string, type: FieldType, v: string): void {
  const rb = regions(before, key);
  const ra = regions(after, key);
  expect(ra.length, key).toBe(rb.length);
  expect(gaps(after, ra), key + ': fora do trecho nada muda').toEqual(gaps(before, rb));
  for (let i = 0; i < ra.length; i++) {
    const [a0, a1] = ra[i] ?? [0, 0];
    const [b0, b1] = rb[i] ?? [0, 0];
    const segA = after.slice(a0, a1);
    const segB = before.slice(b0, b1);
    const tagA = segA.slice(0, segA.indexOf('>') + 1);
    const tagB = segB.slice(0, segB.indexOf('>') + 1);
    expect(attrNames(tagA), key + ': mesmos atributos').toEqual(attrNames(tagB));
    const inner = segA.slice(tagA.length);
    const lt = inner.split('<').length - 1;
    const brs = (inner.match(/<br>/g) ?? []).length;
    if (type === 'address') {
      expect(lt, key + ': só <br> dentro do endereço').toBe(brs);
      if (i === 0) expect(brs).toBe(v.split('\n').length - 1);
    } else if (segB.slice(tagB.length).includes('<')) {
      // conteúdo original com tags (não ocorre no site), aceita só se o editor não tocou o conteúdo
      expect(inner).toBe(segB.slice(tagB.length));
    } else expect(lt, key + ': nenhuma tag nova no conteúdo').toBe(0);
  }
  // o tokenizador continua vendo os mesmos 98 marcadores, com os mesmos tipos e sem problema estrutural
  expect(checkAgainstSchema(after, schema), key).toEqual({});
}

describe('propriedades da edição cirúrgica sobre as 98 chaves do site real', () => {
  test('o site real tem 98 chaves únicas e confere com o esquema', () => {
    expect(list).toHaveLength(98);
    expect(new Set(list.map((f) => f.key)).size).toBe(98);
    expect(schema.fields).toHaveLength(98);
    expect(checkAgainstSchema(SRC, schema)).toEqual({});
  });

  test('aplicar o valor original devolve o arquivo idêntico byte a byte', () => {
    // pela função do /publish (applyChanges): 98 de 98, nada muda e nada conta como alterado
    const all = Object.fromEntries(list.map((f) => [f.key, f.value]));
    const r = applyChanges(SRC, idx, byKey, all);
    expect(r.changed).toEqual([]);
    expect(r.html).toBe(SRC);
    // e direto no editor: idêntico para todas as chaves cujo link derivado não é escrito à mão
    for (const f of list) {
      const out = applySource(SRC, f, f.value);
      if (!DERIVED_FROM_VALUE.has(f.type)) {
        expect(out, f.key).toBe(SRC);
        continue;
      }
      // endereço: o texto volta igual; só o href do mapa (escrito à mão no site) seria regenerado.
      // É por isso que o /publish não reaplica campo com valor igual ao atual.
      const strip = (s: string): string =>
        s.replace(new RegExp('(<a data-cms-href="' + f.key.replace('.', '\\.') + '" href=")[^"]*'), '$1');
      expect(strip(out), f.key).toBe(strip(SRC));
      expect(out).toContain('data-cms-href="' + f.key + '" href="' + escAttr(mapsHref(f.value)) + '"');
    }
  });

  test('aplicar v e depois o original volta ao byte original', () => {
    const rand = mulberry32(0xc0ffee);
    for (const f of list) {
      for (let i = 0; i < 6; i++) {
        const v = hostile(rand) || 'x';
        const there = applySource(SRC, f, v);
        const back = applySource(there, f, f.value);
        if (DERIVED_FROM_VALUE.has(f.type)) expect(back, f.key).toBe(applySource(SRC, f, f.value));
        else expect(back, f.key + ' com ' + JSON.stringify(v)).toBe(SRC);
      }
    }
  });

  test('aplicar v duas vezes = aplicar uma vez (idempotência)', () => {
    const rand = mulberry32(42);
    for (const f of list) {
      for (let i = 0; i < 6; i++) {
        const v = hostile(rand);
        const once = applySource(SRC, f, v);
        expect(applySource(once, f, v), f.key + ' com ' + JSON.stringify(v)).toBe(once);
      }
    }
  });

  test('strings hostis aleatórias nunca criam tag nova nem mexem fora do trecho do campo', () => {
    const rand = mulberry32(20261117);
    let checked = 0;
    for (const f of list) {
      for (let i = 0; i < 10; i++) {
        const v = hostile(rand);
        assertSurgical(SRC, applySource(SRC, f, v), f.key, f.type, v);
        checked++;
      }
    }
    expect(checked).toBe(980);
  });

  test('valor válido volta idêntico na leitura (forma canônica do tipo)', () => {
    const rand = mulberry32(7);
    let valid = 0;
    for (const f of list) {
      const field = idx.get(f.key);
      if (!field || f.type === 'number' || f.type === 'whatsapp' || f.type === 'phone') continue;
      for (let i = 0; i < 8; i++) {
        let v = hostile(rand).replace(/\r/g, '').trim();
        if (f.type === 'link') v = 'https://ex.com/' + v.replace(/[\s"<>]/g, '');
        if (f.type === 'email') v = 'a' + v.replace(/[\s@<>"]/g, '') + '@ex.com';
        if (f.type === 'image') v = 'assets/fotos/x' + String(i) + '.jpg';
        if (validateValue(f.type, v, field.max)) continue;
        const out = applySource(SRC, f, v);
        const read = extractFields(out).byKey.get(f.key)?.value ?? '';
        expect(canonicalValue(f.type, read), f.key + ' com ' + JSON.stringify(v)).toBe(
          canonicalValue(f.type, v),
        );
        valid++;
      }
    }
    expect(valid).toBeGreaterThan(200);
  });
});
