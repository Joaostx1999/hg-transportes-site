import { describe, expect, test } from 'vitest';
import { checkImage, detectType } from '../../src/image.ts';
import type { FieldType } from '../../src/html-editor.ts';
import {
  COMMON_PASSWORDS,
  normUsername,
  normalizeValue,
  passwordPolicy,
  validateValue,
  validUsername,
} from '../../src/validate.ts';
import { b64, JPG, PNG, WEBP } from './helpers.ts';

const v = (t: FieldType, value: string): string => validateValue(t, normalizeValue(value));
const ok = (t: FieldType, value: string): void => {
  expect(v(t, value), t + ' deveria aceitar ' + JSON.stringify(value)).toBe('');
};
const bad = (t: FieldType, value: string): void => {
  expect(v(t, value), t + ' deveria recusar ' + JSON.stringify(value)).not.toBe('');
};

describe('validação por tipo', () => {
  test('vazio é proibido em todos os tipos', () => {
    for (const t of [
      'text',
      'meta',
      'address',
      'number',
      'phone',
      'whatsapp',
      'email',
      'link',
      'image',
    ] as const)
      bad(t, '   ');
  });

  test('text e meta: limite e caracteres de controle; quebra de linha só em address', () => {
    ok('text', 'Olá <mundo> & "aspas" $& 🚚');
    ok('text', 'x'.repeat(600));
    bad('text', 'x'.repeat(601));
    bad('text', 'linha1\nlinha2');
    bad('text', 'a\u0000b');
    bad('text', 'a\tb');
    ok('meta', 'x'.repeat(300));
    bad('meta', 'x'.repeat(301));
    bad('meta', 'a\nb');
  });

  test('address aceita \\n (CRLF normalizado), máximo 300', () => {
    ok('address', 'Rua A\nCidade');
    ok('address', 'Rua A\r\nCidade');
    expect(normalizeValue('  Rua A\r\nCidade\r ')).toBe('Rua A\nCidade');
    bad('address', 'Rua\u0007A');
    bad('address', 'x'.repeat(301));
  });

  test('limite do esquema aperta o do tipo', () => {
    expect(validateValue('text', 'x'.repeat(11), 10)).toBe('Máximo de 10 caracteres.');
  });

  test('number, phone, whatsapp, email, link, image', () => {
    ok('number', '0');
    ok('number', '123456789');
    for (const x of ['1234567890', '-1', '1.5', '1e3', 'abc']) bad('number', x);
    ok('phone', '+55 (51) 99377-5912');
    ok('phone', '(51) 3333-4444');
    bad('phone', '9999-999');
    bad('phone', '12345678901234');
    ok('whatsapp', '(51) 99377-5912');
    ok('whatsapp', '5551993775912');
    for (const x of ['(51) 9937', '+1 415 555 123456', '5541234']) bad('whatsapp', x);
    ok('email', 'a@b.com');
    for (const x of ['a@b', 'a b@c.com', 'a@b.com"><script>', 'sem-arroba.com']) bad('email', x);
    ok('link', 'https://www.instagram.com/hg/');
    for (const x of [
      'http://x.com',
      'javascript:alert(1)',
      'https://x.com/"onmouseover="a',
      'https://x .com',
    ])
      bad('link', x);
    ok('image', 'assets/fotos/cms-0123456789abcdef.jpg');
    for (const x of [
      '../index.html',
      'assets/fotos/../../x.jpg',
      'https://evil.com/a.jpg',
      'assets/fotos/a.svg',
      'assets/fotos/a.jpg" onerror="x',
      'assets/outra/a.jpg',
    ]) {
      bad('image', x);
    }
  });
});

describe('usuário e política de senha', () => {
  test('usuário', () => {
    expect(normUsername('  Maria.Silva ')).toBe('maria.silva');
    expect(normUsername(5)).toBe('');
    expect(validUsername('maria.silva')).toBe(true);
    expect(validUsername('abc')).toBe(true);
    for (const u of ['ab', 'a'.repeat(33), 'maria silva', 'Maria', 'ana/../x'])
      expect(validUsername(u)).toBe(false);
  });

  test('senha: tamanho, caracteres distintos, nome de usuário, lista de comuns', () => {
    expect(passwordPolicy('Cegonha-Azul-2026', 'ana')).toBe('');
    expect(passwordPolicy('x'.repeat(9) + 'y', 'ana')).toMatch(/3 caracteres diferentes/);
    expect(passwordPolicy('abababababab', 'ana')).toMatch(/3 caracteres diferentes/);
    expect(passwordPolicy('curta', 'ana')).toMatch(/de 10 a 200/);
    expect(passwordPolicy('x'.repeat(201), 'ana')).toMatch(/de 10 a 200/);
    expect(passwordPolicy(null, 'ana')).toMatch(/de 10 a 200/);
    expect(passwordPolicy('minha-MARIA-123', 'maria')).toMatch(/nome de usuário/);
    for (const p of [
      '12345678910',
      'Senha12345',
      'HG-Transportes',
      'hgtransportes123',
      'Admin@12345',
      'QWERTYUIOP',
    ]) {
      expect(passwordPolicy(p, 'ana'), p).toMatch(/muito comum/);
    }
  });
});

describe('senhas vazadas/comuns embutidas (S7)', () => {
  test('lista com 10 mil senhas normalizadas (sem rede); as óbvias da HG continuam', () => {
    expect(COMMON_PASSWORDS.size).toBeGreaterThanOrEqual(9000);
    for (const p of COMMON_PASSWORDS) expect(p).toMatch(/^[a-z0-9]+$/);
    for (const p of ['hgtransportes2026', 'cegonha12345', 'senha123456'])
      expect(COMMON_PASSWORDS.has(p)).toBe(true);
  });

  test('recusa senhas da lista mesmo com maiúsculas, espaços e pontuação; aceita senha forte', () => {
    for (const p of [
      'Password123!',
      'Pass.Word!!',
      'qwertyuiop[]',
      'Ilove-You!!',
      'Super-Man!!',
      '1q2w3e4r5t',
      'TrustNo1!!!',
    ])
      expect(passwordPolicy(p, 'ana'), p).toMatch(/muito comum/);
    expect(passwordPolicy('Caminhao-Azul-77', 'ana')).toBe('');
    expect(passwordPolicy('Cegonha-Azul-2026', 'ana')).toBe('');
  });
});

describe('fotos', () => {
  const MAX = 100;
  test('bytes mágicos, tipo declarado, base64 estrito e tamanho', () => {
    expect(detectType(JPG)).toBe('image/jpeg');
    expect(detectType(PNG)).toBe('image/png');
    expect(detectType(WEBP)).toBe('image/webp');
    expect(checkImage('image/jpeg', b64(JPG), MAX)).toMatchObject({ ok: true, ext: 'jpg' });
    expect(checkImage('image/png', 'data:image/png;base64,' + b64(PNG), MAX)).toMatchObject({
      ok: true,
      ext: 'png',
    });
    expect(checkImage('image/webp', b64(WEBP), MAX)).toMatchObject({ ok: true, ext: 'webp' });
    const svg = new TextEncoder().encode('<svg onload=alert(1)>');
    expect(checkImage('image/jpeg', b64(svg), MAX)).toMatchObject({ ok: false, code: 'validation' });
    expect(checkImage('image/jpeg', b64(PNG), MAX)).toMatchObject({ ok: false, code: 'validation' });
    expect(checkImage('image/svg+xml', b64(JPG), MAX)).toMatchObject({ ok: false, code: 'validation' });
    expect(checkImage('image/jpeg', b64(JPG) + ' ', MAX)).toMatchObject({ ok: false, code: 'validation' });
    expect(checkImage('image/jpeg', '!!!!', MAX)).toMatchObject({ ok: false, code: 'validation' });
    expect(checkImage('image/jpeg', '', MAX)).toMatchObject({ ok: false, code: 'validation' });
    expect(checkImage('image/jpeg', b64(JPG), 5)).toMatchObject({ ok: false, code: 'too_large' });
    expect(checkImage('image/jpeg', 'A'.repeat(1000), MAX)).toMatchObject({ ok: false, code: 'too_large' });
  });
});
