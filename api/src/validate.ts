/* Validação por tipo (o servidor é a autoridade), usuário e política de senha.
 * Mesmas regras do validate() do protótipo (admin/admin.js), mais: imagem só em assets/fotos, nada vazio,
 * sem caracteres de controle (\n só em address). */
import { digits, normWhats, type FieldType } from './html-editor.ts';
import { LEAKED_PASSWORDS } from './senhas-comuns.ts';

/** Limite de caracteres por tipo. O esquema (cms/schema.json) pode apertar, nunca afrouxar. */
export const TYPE_MAX: Readonly<Record<FieldType, number>> = {
  text: 600,
  meta: 300,
  address: 300,
  number: 9,
  phone: 30,
  whatsapp: 30,
  email: 120,
  link: 300,
  image: 200,
};

export const FIELD_TYPES = Object.keys(TYPE_MAX) as FieldType[];

export function isFieldType(t: string): t is FieldType {
  return Object.prototype.hasOwnProperty.call(TYPE_MAX, t);
}

export const IMAGE_PATH_RE = /^assets\/fotos\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/;
// eslint-disable-next-line no-control-regex
const CTRL_ANY = /[\u0000-\u001F\u007F]/;
// eslint-disable-next-line no-control-regex
const CTRL_BUT_LF = /[\u0000-\u0009\u000B-\u001F\u007F]/;

/** Normaliza o valor recebido como o protótipo faz antes de aplicar (CRLF/CR viram LF; trim). */
export function normalizeValue(v: string): string {
  return v.replace(/\r\n?/g, '\n').trim();
}

/** '' se válido, senão a mensagem em pt-BR. `v` já normalizado. `max` vem do esquema. */
export function validateValue(type: FieldType, v: string, max: number = TYPE_MAX[type]): string {
  if (!v.trim()) return 'Não pode ficar vazio.';
  if ((type === 'address' ? CTRL_BUT_LF : CTRL_ANY).test(v)) {
    return type === 'address'
      ? 'Caractere inválido.'
      : 'Use uma linha só, sem caracteres especiais de controle.';
  }
  if (v.length > max) return 'Máximo de ' + max + ' caracteres.';
  switch (type) {
    case 'image':
      return IMAGE_PATH_RE.test(v) ? '' : 'Foto inválida. Envie uma foto JPG, PNG ou WebP.';
    case 'number':
      return /^\d{1,9}$/.test(v) ? '' : 'Use só números.';
    case 'phone': {
      const d = digits(v).length;
      return d < 10 || d > 13 ? 'Telefone com DDD, ex.: +55 (51) 99999-9999.' : '';
    }
    case 'whatsapp':
      return /^55\d{10,11}$/.test(normWhats(v)) ? '' : 'Número com DDD, ex.: (51) 99377-5912.';
    case 'email':
      return /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(v) ? '' : 'E-mail inválido.';
    case 'link':
      return /^https:\/\/[^\s"<>]+$/i.test(v) ? '' : 'O link precisa começar com https://';
    default:
      return '';
  }
}

/** Forma canônica para comparar o valor pedido com o valor lido do HTML (mesma leitura do protótipo). */
export function canonicalValue(type: FieldType, v: string): string {
  switch (type) {
    case 'text':
    case 'phone':
    case 'email':
      return v.replace(/\s+/g, ' ').trim();
    case 'whatsapp':
      return normWhats(v);
    case 'number':
      return String(Number.parseInt(v, 10) || 0);
    case 'address':
      return v
        .split('\n')
        .map((l) => l.trim())
        .join('\n');
    default:
      return v;
  }
}

/* ---------------- usuários e senhas ---------------- */

export const ROLES = ['admin', 'editor'] as const;
export type Role = (typeof ROLES)[number];
export function isRole(r: unknown): r is Role {
  return r === 'admin' || r === 'editor';
}

export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
export const MSG_USERNAME =
  'Use de 3 a 32 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado.';

export function normUsername(u: unknown): string {
  return typeof u === 'string' ? u.trim().toLowerCase() : '';
}
export function validUsername(u: string): boolean {
  return USERNAME_RE.test(u);
}

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

/** Senhas óbvias do contexto da HG (somadas às 10 mil vazadas mais comuns de src/senhas-comuns.ts). */
const LOCAL_COMMON = [
  '12345678910',
  '1234567890',
  '0123456789',
  '123456789012',
  '1234567890123',
  '9876543210',
  '1122334455',
  'senha12345',
  'senha123456',
  'senhasenha',
  'minhasenha',
  'minhasenha123',
  'mudar12345',
  'mudar123456',
  'trocar12345',
  'password123',
  'password1234',
  'qwertyuiop',
  'qwerty12345',
  'asdfghjkl1',
  'abc1234567',
  'abcdefghij',
  'admin12345',
  'admin123456',
  'administrador',
  'hgtransportes',
  'hgtransportes1',
  'hgtransportes123',
  'hgtransportes2025',
  'hgtransportes2026',
  'transportes123',
  'transportes2026',
  'cegonha123',
  'cegonha12345',
  'brasil12345',
  'iloveyou123',
];
/** Normalização da comparação: minúsculas, só letras e números ("P@ss-Word!" vira "password"). */
export const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** S7: lista embutida (sem rede), já normalizada. */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  ...LEAKED_PASSWORDS.split('\n'),
  ...LOCAL_COMMON.map(squash),
]);

/** '' se a senha atende à política, senão a mensagem em pt-BR. */
export function passwordPolicy(password: unknown, username: string): string {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return 'A senha precisa ter de ' + PASSWORD_MIN + ' a ' + PASSWORD_MAX + ' caracteres.';
  }
  if (new Set(password).size < 3) return 'Use pelo menos 3 caracteres diferentes.';
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    return 'A senha não pode conter o nome de usuário.';
  }
  if (COMMON_PASSWORDS.has(squash(password))) return 'Essa senha é muito comum. Escolha outra.';
  return '';
}
