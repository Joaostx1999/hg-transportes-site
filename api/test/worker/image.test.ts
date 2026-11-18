/* S10: metadados (EXIF/GPS, textos, XMP) e bytes depois do fim saem da foto antes de ir para o repositório. */
import { describe, expect, test } from 'vitest';
import { checkImage, stripMetadata } from '../../src/image.ts';
import {
  b64,
  JPEG_APP0,
  JPEG_SCAN,
  JPEG_SOS,
  JPG,
  jpegSeg,
  makeApp,
  PASS,
  PNG,
  PNG_IDAT,
  PNG_IEND,
  PNG_IHDR,
  PNG_SIG,
  pngChunk,
  riffChunk,
  u32le,
  webp,
} from './helpers.ts';

const ascii = (s: string): number[] => [...new TextEncoder().encode(s)];
const has = (hay: Uint8Array, needle: string): boolean => {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
};
const EXIF = jpegSeg(0xe1, [
  ...ascii('Exif'),
  0,
  0,
  ...ascii('MM GPSLatitude -30.0346 GPSLongitude -51.2177'),
]);
const XMP = jpegSeg(0xe1, [
  ...ascii('http://ns.adobe.com/xap/1.0/'),
  0,
  ...ascii('<x:xmpmeta>autor</x:xmpmeta>'),
]);
const COM = jpegSeg(0xfe, ascii('comentario secreto'));
const IPTC = jpegSeg(0xed, ascii('Photoshop 3.0 IPTC cidade'));
const ICC = jpegSeg(0xe2, [...ascii('ICC_PROFILE'), 0, 1, 1, 9, 9, 9]);
const ADOBE = jpegSeg(0xee, [...ascii('Adobe'), 0, 100, 0, 0, 0, 0, 1]);
const DQT = jpegSeg(0xdb, [0, ...Array.from({ length: 64 }, () => 1)]);

describe('JPEG', () => {
  test('tira EXIF/GPS, XMP, IPTC e comentário; mantém JFIF, ICC e Adobe; corta o lixo depois do EOI', () => {
    const dirty = new Uint8Array([
      0xff,
      0xd8,
      ...JPEG_APP0,
      ...EXIF,
      ...XMP,
      ...ICC,
      ...ADOBE,
      ...IPTC,
      ...COM,
      ...DQT,
      ...JPEG_SOS,
      ...JPEG_SCAN,
      0xff,
      0xd9,
      ...ascii('<?php lixo depois do fim ?>'),
    ]);
    const out = stripMetadata('image/jpeg', dirty);
    expect(out).not.toBeNull();
    expect([...(out ?? [])]).toEqual([
      0xff,
      0xd8,
      ...JPEG_APP0,
      ...ICC,
      ...ADOBE,
      ...DQT,
      ...JPEG_SOS,
      ...JPEG_SCAN,
      0xff,
      0xd9,
    ]);
    for (const s of ['GPS', 'Exif', 'xmpmeta', 'IPTC', 'secreto', 'php']) expect(has(out!, s), s).toBe(false);
  });

  test('JPEG progressivo (vários SOS com DHT no meio) e foto limpa passam intactos', () => {
    const DHT = jpegSeg(0xc4, [0, ...Array.from({ length: 16 }, () => 0)]);
    const prog = new Uint8Array([
      0xff,
      0xd8,
      ...JPEG_APP0,
      ...JPEG_SOS,
      1,
      2,
      ...DHT,
      ...JPEG_SOS,
      3,
      4,
      0xff,
      0xd9,
    ]);
    expect([...(stripMetadata('image/jpeg', prog) ?? [])]).toEqual([...prog]);
    expect([...(stripMetadata('image/jpeg', JPG) ?? [])]).toEqual([...JPG]);
  });

  test('estrutura quebrada: sem EOI, segmento maior que o arquivo, sem SOI: null', () => {
    expect(stripMetadata('image/jpeg', JPG.subarray(0, JPG.length - 2))).toBeNull();
    expect(
      stripMetadata('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2])),
    ).toBeNull();
    expect(stripMetadata('image/jpeg', new Uint8Array([0xff, 0xd9]))).toBeNull();
    expect(checkImage('image/jpeg', b64(JPG.subarray(0, JPG.length - 2)), 1000)).toMatchObject({
      ok: false,
      code: 'validation',
    });
  });
});

describe('PNG', () => {
  test('tira tEXt/zTXt/iTXt/eXIf/tIME; mantém gAMA, iCCP, tRNS; corta o lixo depois do IEND', () => {
    const GAMA = pngChunk('gAMA', [0, 0, 0xb1, 0x8f]);
    const ICCP = pngChunk('iCCP', [...ascii('icc'), 0, 0, 1, 2]);
    const TRNS = pngChunk('tRNS', [0, 0]);
    const dirty = new Uint8Array([
      ...PNG_SIG,
      ...PNG_IHDR,
      ...pngChunk('tEXt', [...ascii('Author'), 0, ...ascii('Fulano GPS')]),
      ...GAMA,
      ...ICCP,
      ...pngChunk('eXIf', ascii('MM GPS')),
      ...pngChunk('zTXt', [...ascii('Comment'), 0, 0, 1]),
      ...TRNS,
      ...PNG_IDAT,
      ...pngChunk('iTXt', [...ascii('XML:com.adobe.xmp'), 0, 0, 0, 0, 0, ...ascii('<xmp/>')]),
      ...pngChunk('tIME', [7, 0xea, 11, 17, 12, 0, 0]),
      ...PNG_IEND,
      ...ascii('lixo depois do IEND'),
    ]);
    const out = stripMetadata('image/png', dirty);
    expect([...(out ?? [])]).toEqual([
      ...PNG_SIG,
      ...PNG_IHDR,
      ...GAMA,
      ...ICCP,
      ...TRNS,
      ...PNG_IDAT,
      ...PNG_IEND,
    ]);
    expect([...(stripMetadata('image/png', PNG) ?? [])]).toEqual([...PNG]);
  });

  test('chunk truncado ou sem IEND: null', () => {
    expect(stripMetadata('image/png', PNG.subarray(0, PNG.length - 12))).toBeNull();
    expect(stripMetadata('image/png', PNG.subarray(0, 20))).toBeNull();
  });
});

describe('WebP', () => {
  test('tira EXIF e XMP, limpa as flags do VP8X, corrige o tamanho do RIFF e corta o lixo', () => {
    const vp8x = (flags: number) => riffChunk('VP8X', [flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const data = riffChunk('VP8L', [0x2f, 0, 0, 0, 0]);
    const dirty = new Uint8Array([
      ...webp([
        vp8x(0x08 | 0x04 | 0x20),
        riffChunk('ICCP', [1, 2, 3]),
        data,
        riffChunk('EXIF', ascii('MM GPS')),
        riffChunk('XMP ', ascii('<x/>')),
      ]),
      ...ascii('lixo'),
    ]);
    const out = stripMetadata('image/webp', dirty);
    const want = webp([vp8x(0x20), riffChunk('ICCP', [1, 2, 3]), data]);
    expect([...(out ?? [])]).toEqual([...want]);
    expect(
      stripMetadata('image/webp', new Uint8Array([...ascii('RIFF'), ...u32le(100), ...ascii('WEBP')])),
    ).toBeNull();
  });
});

describe('/publish grava a foto já limpa', () => {
  test('JPEG com EXIF/GPS e bytes depois do fim: o blob no repositório não tem nenhum dos dois', async () => {
    const t = await makeApp();
    await t.addUser('ana', PASS);
    const tok = await t.login('ana', PASS);
    const { commit: base } = await t.content(tok);
    const dirty = new Uint8Array([
      0xff,
      0xd8,
      ...JPEG_APP0,
      ...EXIF,
      ...JPEG_SOS,
      ...JPEG_SCAN,
      0xff,
      0xd9,
      1,
      2,
      3,
    ]);
    const r = await t.call('POST', '/publish', {
      token: tok,
      body: { base, images: { 'cta.foto': { type: 'image/jpeg', data: b64(dirty) } } },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const path = (r.json.paths as Record<string, string>)['cta.foto'] ?? '';
    expect([...(t.gh.file(path) ?? [])]).toEqual([...JPG]);
  });
});
