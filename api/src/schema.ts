/* Esquema versionado dos campos editáveis (cms/schema.json) e leitura dos marcadores data-cms do HTML.
 * Mesmo código no Worker, em scripts/gerar-schema.mjs e em scripts/validar-marcadores.mjs (Node >= 22.18
 * roda este .ts direto, com remoção de tipos nativa).
 *
 * Duas leituras independentes do HTML são comparadas:
 *  - regex de tag, idêntica à do editor (tagRe): é o que a edição cirúrgica de fato altera;
 *  - um tokenizador mínimo que entende comentários, <script>/<style>/<title>/<textarea> e aninhamento,
 *    usado para achar o grupo (data-cms-group do elemento ou de um ancestral) e o fechamento real.
 * Se as duas divergirem (marcador dentro de comentário/script, '>' em atributo, elemento aninhado do mesmo
 * tipo, atributo sem aspas duplas), o HTML é recusado: a edição por regex poderia corromper o arquivo. */
import { digits, fmtWhats, indexOfCloseTag, type FieldType } from './html-editor.ts';
import { isFieldType, TYPE_MAX } from './validate.ts';
import { hasOwn, isRecord } from './util.ts';

export const SCHEMA_VERSION = 1;
export const HEAD_GROUP = 'Google (busca)';
export const DEFAULT_GROUP = 'Outros';

export interface SchemaField {
  key: string;
  type: FieldType;
  group: string;
  label: string;
  max: number;
  required: true;
}

export interface Schema {
  version: number;
  page: string;
  fields: SchemaField[];
}

export interface Marker {
  key: string;
  /** valor bruto de data-cms-type ('' quando ausente = text) */
  rawType: string;
  label: string;
  group: string;
  tagName: string;
  tag: string;
  tagStart: number;
  tagEnd: number;
  /** início do fechamento real (respeitando aninhamento); null se não fechou */
  closeStart: number | null;
}

export interface FieldValue {
  key: string;
  type: FieldType;
  label: string;
  group: string;
  sep: boolean;
  value: string;
}

/* ---------------- entidades e leitura de atributos ---------------- */

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (all, e: string) => {
    if (e.startsWith('#')) {
      const cp =
        e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(cp);
      } catch {
        return all;
      }
    }
    return hasOwn(NAMED, e) ? (NAMED[e] ?? all) : all;
  });
}

/** Atributo entre aspas duplas (o formato que o editor sabe reescrever). */
function attrDq(tag: string, name: string): string | null {
  const m = new RegExp('\\s' + name + '="([^"]*)"').exec(tag);
  return m ? decodeEntities(m[1] ?? '') : null;
}

const ATTR_RE = /\s([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

interface Attrs {
  values: Map<string, string>;
  /** atributos cujo valor não está entre aspas duplas (o editor só reescreve aspas duplas) */
  notDoubleQuoted: Set<string>;
}

function parseAttrs(tagBody: string): Attrs {
  const values = new Map<string, string>();
  const notDoubleQuoted = new Set<string>();
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(tagBody))) {
    const name = (m[1] ?? '').toLowerCase();
    if (m[3] !== undefined || m[4] !== undefined) notDoubleQuoted.add(name);
    if (!values.has(name)) values.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return { values, notDoubleQuoted };
}

/* ---------------- tokenizador ---------------- */

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
const RAW_TEXT = new Set(['script', 'style', 'title', 'textarea']);
const EDITED_ATTRS = [
  'content',
  'href',
  'src',
  'data-count',
  'data-cms',
  'data-cms-href',
  'data-cms-type',
  'data-sep',
];

/** Fim da tag (índice após '>') respeitando aspas. */
function tagEndQuoted(src: string, from: number): number {
  let q: string | null = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '>') return i + 1;
  }
  return -1;
}

interface Open {
  name: string;
  group: string | null;
  marker: Marker | null;
}

export interface Scan {
  markers: Marker[];
  /** problemas estruturais encontrados pelo tokenizador */
  problems: { key: string; msg: string }[];
}

export function scanMarkers(src: string): Scan {
  const markers: Marker[] = [];
  const problems: { key: string; msg: string }[] = [];
  const stack: Open[] = [];
  let i = 0;
  const closeTo = (name: string, at: number): void => {
    let j = stack.length - 1;
    while (j >= 0 && stack[j]?.name !== name) j--;
    if (j < 0) return;
    const top = stack[j];
    if (top?.marker) top.marker.closeStart = at;
    stack.length = j;
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      i = e < 0 ? src.length : e + 3;
      continue;
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const e = src.indexOf('>', lt);
      i = e < 0 ? src.length : e + 1;
      continue;
    }
    const endTag = /^<\/([a-zA-Z][\w-]*)\s*>/.exec(src.slice(lt, lt + 80));
    if (endTag) {
      closeTo((endTag[1] ?? '').toLowerCase(), lt);
      i = lt + endTag[0].length;
      continue;
    }
    const start = /^<([a-zA-Z][\w-]*)/.exec(src.slice(lt, lt + 80));
    if (!start) {
      i = lt + 1;
      continue;
    }
    const name = (start[1] ?? '').toLowerCase();
    const end = tagEndQuoted(src, lt + 1);
    if (end < 0) break;
    const tag = src.slice(lt, end);
    const parsed = parseAttrs(src.slice(lt + 1 + name.length, end - 1));
    const attrs = parsed.values;
    const selfClosing = VOID.has(name) || /\/\s*>$/.test(tag);
    const ownGroup = attrs.get('data-cms-group') ?? null;
    let marker: Marker | null = null;
    const key = attrs.get('data-cms');
    if (key !== undefined) {
      let inherited: string | null = null;
      for (let j = stack.length - 1; j >= 0 && inherited === null; j--) inherited = stack[j]?.group ?? null;
      const inHead = stack.some((o) => o.name === 'head');
      marker = {
        key,
        rawType: attrs.get('data-cms-type') ?? '',
        label: attrs.get('data-cms-label') ?? key,
        group: ownGroup ?? inherited ?? (inHead ? HEAD_GROUP : DEFAULT_GROUP),
        tagName: name,
        tag,
        tagStart: lt,
        tagEnd: end,
        closeStart: null,
      };
      markers.push(marker);
      if (src.indexOf('>', lt) + 1 !== end)
        problems.push({ key, msg: 'Atributo com ">" dentro do marcador.' });
    }
    if (marker !== null || attrs.has('data-cms-href')) {
      for (const a of EDITED_ATTRS) {
        if (parsed.notDoubleQuoted.has(a)) {
          problems.push({
            key: key ?? attrs.get('data-cms-href') ?? '?',
            msg: 'Atributo ' + a + ' sem aspas duplas.',
          });
        }
      }
    }
    if (RAW_TEXT.has(name) && !selfClosing) {
      const close = indexOfCloseTag(src, name, end, false);
      if (marker) marker.closeStart = close < 0 ? null : close;
      i = close < 0 ? src.length : close;
      continue;
    }
    if (!selfClosing) stack.push({ name, group: ownGroup, marker });
    i = end;
  }
  return { markers, problems };
}

/* ---------------- leitura de valores (mesma do protótipo) ---------------- */

const ATTR_TYPES: ReadonlySet<FieldType> = new Set(['meta', 'whatsapp', 'link', 'image']);

export function hasInner(type: FieldType): boolean {
  return !ATTR_TYPES.has(type);
}

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''));
}

/** Conteúdo como o editor enxerga: até o primeiro </nome> depois da tag. */
function editorInner(src: string, m: Marker): string | null {
  const close = indexOfCloseTag(src, m.tagName, m.tagEnd);
  return close < 0 ? null : src.slice(m.tagEnd, close);
}

export function readValue(tag: string, inner: string | null, type: FieldType): string {
  switch (type) {
    case 'meta':
    case 'whatsapp':
      return attrDq(tag, 'content') ?? '';
    case 'number':
      // `||` de propósito: data-count vazio cai para o texto, como no protótipo
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      return attrDq(tag, 'data-count') || digits(textOf(inner ?? ''));
    case 'link':
      return attrDq(tag, 'href') ?? '';
    case 'image':
      return attrDq(tag, 'src') ?? '';
    case 'address':
      return (inner ?? '')
        .split(/<br\s*\/?>/i)
        .map((p) => textOf(p).trim())
        .join('\n');
    default:
      return textOf(inner ?? '')
        .replace(/\s+/g, ' ')
        .trim();
  }
}

function typeOf(m: Marker): FieldType {
  const t = m.rawType || 'text';
  return isFieldType(t) ? t : 'text';
}

/** Campos e valores atuais. Primeira ocorrência de cada chave define o campo (igual ao protótipo). */
export function extractFields(src: string): { list: FieldValue[]; byKey: Map<string, FieldValue> } {
  const list: FieldValue[] = [];
  const byKey = new Map<string, FieldValue>();
  for (const m of scanMarkers(src).markers) {
    if (byKey.has(m.key)) continue;
    const type = typeOf(m);
    let value = readValue(m.tag, hasInner(type) ? editorInner(src, m) : null, type);
    if (type === 'whatsapp') value = fmtWhats(value);
    const f: FieldValue = {
      key: m.key,
      type,
      label: m.label,
      group: m.group,
      sep: /\sdata-sep[\s=>]/.test(m.tag),
      value,
    };
    list.push(f);
    byKey.set(m.key, f);
  }
  return { list, byKey };
}

/* ---------------- esquema ---------------- */

export function buildSchema(src: string, page: string): Schema {
  return {
    version: SCHEMA_VERSION,
    page,
    fields: extractFields(src).list.map((f) => ({
      key: f.key,
      type: f.type,
      group: f.group,
      label: f.label,
      max: TYPE_MAX[f.type],
      required: true,
    })),
  };
}

export function serializeSchema(s: Schema): string {
  return JSON.stringify(s, null, 2) + '\n';
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Valida a forma do schema.json. Lança SchemaError com a primeira falha. */
export function parseSchema(raw: unknown): Schema {
  const fail = (m: string): never => {
    throw new SchemaError(m);
  };
  if (!isRecord(raw)) return fail('schema.json não é um objeto.');
  if (raw.version !== SCHEMA_VERSION) return fail('Versão do esquema não suportada: ' + String(raw.version));
  if (typeof raw.page !== 'string' || !raw.page) return fail('schema.json sem "page".');
  if (!Array.isArray(raw.fields) || raw.fields.length === 0) return fail('schema.json sem "fields".');
  const seen = new Set<string>();
  const fields: SchemaField[] = [];
  for (const f of raw.fields as unknown[]) {
    if (!isRecord(f)) return fail('Campo inválido no esquema.');
    const { key, type, group, label, max, required } = f;
    if (typeof key !== 'string' || !KEY_RE.test(key))
      return fail('Chave inválida no esquema: ' + String(key));
    if (seen.has(key)) return fail('Chave duplicada no esquema: ' + key);
    seen.add(key);
    if (typeof type !== 'string' || !isFieldType(type)) return fail('Tipo inválido em ' + key);
    if (typeof group !== 'string' || !group) return fail('Grupo inválido em ' + key);
    if (typeof label !== 'string' || !label) return fail('Rótulo inválido em ' + key);
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > TYPE_MAX[type]) {
      return fail('Limite inválido em ' + key + ' (1 a ' + TYPE_MAX[type] + ').');
    }
    if (required !== true) return fail('required precisa ser true em ' + key);
    fields.push({ key, type, group, label, max, required: true });
  }
  return { version: SCHEMA_VERSION, page: raw.page, fields };
}

/**
 * Confere o HTML contra o esquema. Devolve {chave: problema}; vazio = ok.
 * Falha se: marcador do esquema falta, aparece mais de uma vez, tem outro tipo; há marcador fora do esquema;
 * o marcador está num lugar que a edição por regex não trata com segurança.
 */
export function checkAgainstSchema(src: string, schema: Schema): Record<string, string> {
  const problems: Record<string, string> = {};
  const add = (k: string, msg: string): void => {
    problems[k] = problems[k] ? problems[k] + ' ' + msg : msg;
  };
  const scan = scanMarkers(src);
  for (const p of scan.problems) add(p.key, p.msg);

  const tokCount = new Map<string, Marker[]>();
  for (const m of scan.markers) tokCount.set(m.key, [...(tokCount.get(m.key) ?? []), m]);
  const rawCount = new Map<string, number>();
  const RAW = /<[a-zA-Z][\w-]*\b[^>]*\sdata-cms="([^"]*)"[^>]*>/g;
  let rm: RegExpExecArray | null;
  while ((rm = RAW.exec(src))) rawCount.set(rm[1] ?? '', (rawCount.get(rm[1] ?? '') ?? 0) + 1);

  const inSchema = new Set<string>();
  for (const f of schema.fields) {
    inSchema.add(f.key);
    const ms = tokCount.get(f.key) ?? [];
    const raw = rawCount.get(f.key) ?? 0;
    if (ms.length === 0 && raw === 0) {
      add(f.key, 'Marcador faltando no HTML.');
      continue;
    }
    if (ms.length > 1 || raw > 1) {
      add(f.key, 'Marcador duplicado (' + Math.max(ms.length, raw) + ' vezes).');
      continue;
    }
    if (ms.length !== raw) {
      add(f.key, 'Marcador em lugar inválido (comentário, script ou atributo malformado).');
      continue;
    }
    const m = ms[0];
    if (!m) continue;
    const t = m.rawType || 'text';
    if (t !== f.type) {
      add(f.key, 'Tipo diferente: HTML "' + t + '", esquema "' + f.type + '".');
      continue;
    }
    if (hasInner(f.type)) {
      const editorClose = indexOfCloseTag(src, m.tagName, m.tagEnd);
      if (m.closeStart === null || editorClose < 0) add(f.key, 'Marcador sem fechamento.');
      else if (editorClose !== m.closeStart)
        add(f.key, 'Marcador com elemento <' + m.tagName + '> aninhado.');
    }
  }
  for (const [k, ms] of tokCount) {
    if (!inSchema.has(k)) add(k, 'Marcador no HTML que não está no esquema (' + ms.length + 'x).');
  }
  for (const [k, n] of rawCount) {
    if (!inSchema.has(k) && !tokCount.has(k))
      add(k, 'Marcador no HTML que não está no esquema (' + n + 'x).');
  }
  const HREF = /<[a-zA-Z][\w-]*\b[^>]*\sdata-cms-href="([^"]*)"[^>]*>/g;
  let hm: RegExpExecArray | null;
  while ((hm = HREF.exec(src))) {
    const k = hm[1] ?? '';
    const f = schema.fields.find((x) => x.key === k);
    if (!f) add(k, 'data-cms-href aponta para um campo que não existe.');
    else if (!['whatsapp', 'phone', 'email', 'address'].includes(f.type)) {
      add(k, 'data-cms-href só vale para whatsapp, phone, email ou address.');
    }
  }
  return problems;
}

/** Atalho: tipo/rótulo/limite por chave. */
export function schemaIndex(schema: Schema): Map<string, SchemaField> {
  return new Map(schema.fields.map((f) => [f.key, f]));
}
