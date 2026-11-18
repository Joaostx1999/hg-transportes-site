/* Fotos enviadas no /publish: tipo declarado, bytes mágicos, tamanho e limpeza de metadados (S10).
 * Sem re-encode (o Worker não tem biblioteca de imagem; o painel já redimensiona via canvas, o que
 * re-encoda). A limpeza aqui vale para quem chama a API direto: percorre os segmentos/chunks em TS puro,
 * tira EXIF/GPS, XMP, IPTC, comentários e textos, e corta qualquer byte depois do fim da imagem.
 * Sem EXIF, a orientação gravada pela câmera se perde (o painel já aplica a rotação antes de enviar). */
import { b64ToBytesStrict } from './util.ts';

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';
export const IMAGE_EXT: Readonly<Record<ImageType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function isImageType(t: unknown): t is ImageType {
  return t === 'image/jpeg' || t === 'image/png' || t === 'image/webp';
}

export function detectType(b: Uint8Array): ImageType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && png.every((x, i) => b[i] === x)) return 'image/png';
  const ascii = (from: number, to: number): string => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export type ImageCheck =
  | { ok: true; type: ImageType; ext: string; bytes: Uint8Array }
  | { ok: false; code: 'validation' | 'too_large'; error: string };

/** Valida {type, data} vindo do JSON. `data` é base64 puro (aceita também o prefixo data:<type>;base64,). */
export function checkImage(type: unknown, data: unknown, maxBytes: number): ImageCheck {
  if (!isImageType(type)) return { ok: false, code: 'validation', error: 'Use uma foto JPG, PNG ou WebP.' };
  if (typeof data !== 'string' || !data)
    return { ok: false, code: 'validation', error: 'Nenhuma foto recebida.' };
  const prefix = 'data:' + type + ';base64,';
  const b64 = data.startsWith(prefix) ? data.slice(prefix.length) : data;
  // checa o tamanho antes de decodificar (base64 tem 4 caracteres para cada 3 bytes)
  if (Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0) > maxBytes) {
    return tooLarge(maxBytes);
  }
  const bytes = b64ToBytesStrict(b64);
  if (!bytes?.length) return { ok: false, code: 'validation', error: 'Foto corrompida (base64 inválido).' };
  if (bytes.length > maxBytes) return tooLarge(maxBytes);
  const real = detectType(bytes);
  if (!real)
    return { ok: false, code: 'validation', error: 'O arquivo não é uma foto JPG, PNG ou WebP válida.' };
  if (real !== type)
    return { ok: false, code: 'validation', error: 'O tipo do arquivo não confere com a foto enviada.' };
  const clean = stripMetadata(real, bytes);
  if (!clean)
    return { ok: false, code: 'validation', error: 'O arquivo da foto está corrompido ou incompleto.' };
  return { ok: true, type: real, ext: IMAGE_EXT[real], bytes: clean };
}

/* ---------------- limpeza de metadados ---------------- */

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const startsWithAscii = (b: Uint8Array, at: number, s: string): boolean => {
  if (at + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

/** Foto sem metadados e sem bytes depois do fim. null = estrutura inválida (recusar). */
export function stripMetadata(type: ImageType, b: Uint8Array): Uint8Array | null {
  if (type === 'image/jpeg') return stripJpeg(b);
  if (type === 'image/png') return stripPng(b);
  return stripWebp(b);
}

/**
 * JPEG: mantém APP0 (JFIF), APP2 "ICC_PROFILE" (cor) e APP14 "Adobe" (transformação de cor); tira os
 * outros APPn (APP1 = EXIF/GPS e XMP, APP13 = IPTC...) e COM. Os dados comprimidos depois de cada SOS
 * vão até o próximo marcador que não seja FF00 (byte escapado) nem RSTn; termina no EOI e corta o resto.
 */
function stripJpeg(b: Uint8Array): Uint8Array | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return null;
    let m = b[i + 1] ?? 0;
    // bytes de preenchimento 0xFF antes do marcador são permitidos
    while (m === 0xff && i + 2 < b.length) {
      i++;
      m = b[i + 1] ?? 0;
    }
    if (m === 0xd9) {
      parts.push(b.subarray(i, i + 2));
      return concat(parts);
    }
    if (m === 0xd8 || m === 0x00 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) return null;
    if (i + 4 > b.length) return null;
    const len = ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0);
    if (len < 2 || i + 2 + len > b.length) return null;
    const end = i + 2 + len;
    const isApp = m >= 0xe0 && m <= 0xef;
    const keep =
      !isApp && m !== 0xfe
        ? true
        : (m === 0xe0 && startsWithAscii(b, i + 4, 'JFIF')) ||
          (m === 0xe2 && startsWithAscii(b, i + 4, 'ICC_PROFILE\0')) ||
          (m === 0xee && startsWithAscii(b, i + 4, 'Adobe'));
    if (m !== 0xda) {
      if (keep) parts.push(b.subarray(i, end));
      i = end;
      continue;
    }
    // SOS: cabeçalho + dados comprimidos até o próximo marcador de verdade
    let j = end;
    for (;;) {
      if (j + 1 >= b.length) return null; // acabou sem EOI
      if (b[j] === 0xff) {
        const n = b[j + 1] ?? 0;
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) {
          j += n === 0xff ? 1 : 2;
          continue;
        }
        break;
      }
      j++;
    }
    parts.push(b.subarray(i, j));
    i = j;
  }
  return null;
}

/** PNG: só os chunks que mudam a imagem; tira tEXt/zTXt/iTXt/eXIf/tIME e desconhecidos; corta após o IEND. */
const PNG_KEEP: ReadonlySet<string> = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'gAMA',
  'cHRM',
  'sRGB',
  'iCCP',
  'sBIT',
  'bKGD',
  'pHYs',
  'acTL',
  'fcTL',
  'fdAT',
]);

function stripPng(b: Uint8Array): Uint8Array | null {
  if (b.length < 8) return null;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  let first = true;
  while (i + 12 <= b.length) {
    const len =
      (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0;
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (!/^[A-Za-z]{4}$/.test(type) || end > b.length) return null;
    if (first && type !== 'IHDR') return null;
    first = false;
    if (PNG_KEEP.has(type)) parts.push(b.subarray(i, end));
    if (type === 'IEND') return concat(parts);
    i = end;
  }
  return null;
}

/** WebP: tira os chunks EXIF e "XMP ", limpa as flags deles no VP8X, refaz o tamanho do RIFF, corta o resto. */
function stripWebp(b: Uint8Array): Uint8Array | null {
  if (b.length < 12 || !startsWithAscii(b, 0, 'RIFF') || !startsWithAscii(b, 8, 'WEBP')) return null;
  const riffLen = ((b[4] ?? 0) | ((b[5] ?? 0) << 8) | ((b[6] ?? 0) << 16) | ((b[7] ?? 0) << 24)) >>> 0;
  const stop = 8 + riffLen;
  if (stop > b.length || riffLen < 4) return null;
  const parts: Uint8Array[] = [];
  let i = 12;
  let image = false;
  while (i < stop) {
    if (i + 8 > stop) return null;
    const type = String.fromCharCode(...b.subarray(i, i + 4));
    const len =
      ((b[i + 4] ?? 0) | ((b[i + 5] ?? 0) << 8) | ((b[i + 6] ?? 0) << 16) | ((b[i + 7] ?? 0) << 24)) >>> 0;
    const end = i + 8 + len + (len % 2);
    if (end > stop) return null;
    if (type === 'VP8 ' || type === 'VP8L' || type === 'ANMF') image = true;
    if (type === 'VP8X') {
      const c = b.slice(i, end);
      c[8] = (c[8] ?? 0) & ~(0x08 | 0x04); // flags EXIF (bit 3) e XMP (bit 2)
      parts.push(c);
    } else if (type !== 'EXIF' && type !== 'XMP ') parts.push(b.subarray(i, end));
    i = end;
  }
  if (!image) return null;
  const body = concat(parts);
  const size = body.length + 4;
  const head = new Uint8Array([
    0x52,
    0x49,
    0x46,
    0x46,
    size & 255,
    (size >>> 8) & 255,
    (size >>> 16) & 255,
    (size >>> 24) & 255,
    0x57,
    0x45,
    0x42,
    0x50,
  ]);
  return concat([head, body]);
}

function tooLarge(max: number): ImageCheck {
  return {
    ok: false,
    code: 'too_large',
    error: 'Foto muito grande (máx. ' + Math.floor(max / 1048576) + ' MB).',
  };
}
