/* C6: as regras do painel (admin/rules.js, JS puro do navegador) e as do servidor (src/validate.ts) dão o
 * MESMO resultado: forma canônica (decide se o campo mudou) e válido/inválido, em milhares de valores. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import type { FieldType } from '../../src/html-editor.ts';
import { canonicalValue, normalizeValue, TYPE_MAX, validateValue } from '../../src/validate.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const sandbox: { HG_RULES?: Record<string, unknown> } = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'admin', 'rules.js'), 'utf8'), sandbox);
const R = sandbox.HG_RULES as {
  TYPE_MAX: Record<string, number>;
  normalizeValue: (v: string) => string;
  canonicalValue: (t: string, v: string) => string;
  validate: (t: string, v: string, max?: number) => string;
};

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
  ' ',
  '  ',
  '\t',
  '\n',
  '\r\n',
  '\r',
  ' ',
  'a',
  'Z',
  'ç',
  'İ',
  '0',
  '5',
  '9',
  '(51)',
  '+55',
  '-',
  '.',
  '@',
  'x.com',
  'https://',
  'http://',
  '"',
  '<',
  '>',
  '&',
  '\u0007',
  '\u007f',
  '🚚',
  'assets/fotos/a.jpg',
  '55',
  '993775912',
  '3333-4444',
  'mailto:',
  '/',
  '%20',
];
const TYPES: FieldType[] = ['text', 'meta', 'address', 'number', 'phone', 'whatsapp', 'email', 'link'];

describe('admin/rules.js x src/validate.ts', () => {
  test('mesmo teto por tipo', () => {
    expect(R.TYPE_MAX).toEqual(TYPE_MAX);
  });

  test('mesma normalização, forma canônica e validade em 8 mil valores (8 tipos)', () => {
    const rand = mulberry32(0x5eed);
    let n = 0;
    for (const type of TYPES) {
      for (let i = 0; i < 1000; i++) {
        let v = '';
        const len = Math.floor(rand() * 12);
        for (let j = 0; j < len; j++) v += PIECES[Math.floor(rand() * PIECES.length)] ?? '';
        const nv = normalizeValue(v);
        expect(R.normalizeValue(v), JSON.stringify(v)).toBe(nv);
        expect(R.canonicalValue(type, nv), type + ' ' + JSON.stringify(v)).toBe(canonicalValue(type, nv));
        const max = 1 + Math.floor(rand() * TYPE_MAX[type]);
        expect(R.validate(type, nv, max) === '', type + ' ' + JSON.stringify(v)).toBe(
          validateValue(type, nv, max) === '',
        );
        n++;
      }
    }
    expect(n).toBe(8000);
  });

  test('o caso da revisão: espaço duplo num texto não é mudança nos dois lados', () => {
    const a = 'Seguro de carga e CT-e';
    const b = 'Seguro  de carga e CT-e';
    expect(R.canonicalValue('text', b)).toBe(R.canonicalValue('text', a));
    expect(canonicalValue('text', b)).toBe(canonicalValue('text', a));
  });
});
