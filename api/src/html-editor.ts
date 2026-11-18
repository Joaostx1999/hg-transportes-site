/* Edição cirúrgica do index.html. Porta fiel das funções do protótipo (admin/admin.js):
 * escHtml, escAttr, escRe, digits, normWhats, fmtWhats, telHref, mapsHref, fmtNumber, derivedHref,
 * tagRe, setAttrInTag, editTags, applySource.
 * Só os trechos marcados mudam; o resto do arquivo fica byte a byte igual. Texto sempre escapado.
 * Substituições usam função (nunca string de substituição), então `$&`, `$1` etc. entram como texto. */

export type FieldType =
  'text' | 'meta' | 'address' | 'number' | 'phone' | 'whatsapp' | 'email' | 'link' | 'image';

export interface EditableField {
  key: string;
  type: FieldType;
  label?: string;
}

export class EditorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditorError';
  }
}

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Atributos: & só vira &amp; quando pareceria uma entidade, para não mexer em links que já funcionam. */
export function escAttr(s: string): string {
  return s
    .replace(/&(?=#?[a-zA-Z0-9]+;)/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function digits(s: string): string {
  return s.replace(/\D/g, '');
}

export function normWhats(v: string): string {
  let d = digits(v);
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d;
}

export function fmtWhats(v: string): string {
  let d = digits(v);
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
  if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
  return d;
}

export function telHref(v: string): string {
  let d = digits(v);
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return 'tel:+' + d;
}

export function mapsHref(v: string): string {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(v.split('\n').join(', '));
}

/** Mesmo resultado de n.toLocaleString('pt-BR') para inteiros >= 0, sem depender do ICU do runtime. */
function ptBrInt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function fmtNumber(hasSepAttr: boolean, v: string): string {
  const n = Number.parseInt(v, 10) || 0;
  return hasSepAttr ? ptBrInt(n) : String(n);
}

export function hasSep(tag: string): boolean {
  return /\sdata-sep[\s=>]/.test(tag);
}

export function derivedHref(type: FieldType, v: string, current: string): string {
  switch (type) {
    case 'whatsapp':
      return current.replace(/phone=\d*/, () => 'phone=' + normWhats(v));
    case 'phone':
      return telHref(v);
    case 'email':
      return 'mailto:' + v.trim();
    case 'address':
      return mapsHref(v);
    default:
      return current;
  }
}

/**
 * Início do próximo `</nome>` a partir de `from`, sem diferenciar maiúsculas (só ASCII, como o HTML).
 * Busca no texto ORIGINAL: `src.toLowerCase()` pode mudar o tamanho da string ('İ' vira 2 unidades) e os
 * índices deixariam de valer no original. `gt=false` aceita `</nome` sem o '>' (fim de <script>/<style>).
 * -1 se não houver.
 */
export function indexOfCloseTag(src: string, name: string, from: number, gt = true): number {
  // sem a flag "u": o "i" do JS não casa letra não-ASCII com ASCII (K de Kelvin não vira "k")
  const re = new RegExp('</' + escRe(name) + (gt ? '>' : ''), 'gi');
  re.lastIndex = from;
  return re.exec(src)?.index ?? -1;
}

export function tagRe(attr: string, key: string): RegExp {
  return new RegExp('<([a-zA-Z][\\w-]*)\\b[^>]*\\s' + attr + '="' + escRe(key) + '"[^>]*>', 'g');
}

export function setAttrInTag(tag: string, name: string, value: string): string {
  const re = new RegExp('(\\s' + escRe(name) + ')(="[^"]*")?(?=[\\s/>])');
  const safe = name + '="' + escAttr(value) + '"';
  return re.test(tag)
    ? tag.replace(re, () => ' ' + safe)
    : tag.replace(/\s*\/?>$/, (end) => ' ' + safe + end);
}

interface TagEdit {
  tag: string;
  inner?: string;
}

export function editTags(
  src: string,
  attr: string,
  key: string,
  fn: (tag: string, name: string) => TagEdit,
): { src: string; count: number } {
  const re = tagRe(attr, key);
  let out = '';
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1] ?? '';
    const res = fn(m[0], name);
    out += src.slice(last, m.index) + res.tag;
    last = m.index + m[0].length;
    if (res.inner !== undefined) {
      const close = indexOfCloseTag(src, name, last);
      if (close < 0) throw new EditorError('Marcador quebrado em ' + key);
      out += res.inner;
      last = close;
    }
    n++;
  }
  return { src: out + src.slice(last), count: n };
}

const DERIVED: ReadonlySet<FieldType> = new Set(['whatsapp', 'phone', 'email', 'address']);

/** Aplica o valor v (já validado) ao campo f em src. */
export function applySource(src: string, f: EditableField, v: string): string {
  const r = editTags(src, 'data-cms', f.key, (tag) => {
    switch (f.type) {
      case 'meta':
        return { tag: setAttrInTag(tag, 'content', v) };
      case 'whatsapp':
        return { tag: setAttrInTag(tag, 'content', normWhats(v)) };
      case 'number':
        return { tag: setAttrInTag(tag, 'data-count', v), inner: escHtml(fmtNumber(hasSep(tag), v)) };
      case 'link':
        return { tag: setAttrInTag(tag, 'href', v) };
      case 'image':
        return { tag: setAttrInTag(tag, 'src', v) };
      case 'address':
        return { tag, inner: v.split('\n').map(escHtml).join('<br>') };
      default:
        return { tag, inner: escHtml(v) };
    }
  });
  if (!r.count)
    throw new EditorError('Campo "' + (f.label ?? f.key) + '" não foi encontrado no site publicado.');
  let out = r.src;
  if (DERIVED.has(f.type)) {
    out = editTags(out, 'data-cms-href', f.key, (tag) => {
      const cur = (/\shref="([^"]*)"/.exec(tag)?.[1] ?? '').replace(/&amp;/g, '&');
      return { tag: setAttrInTag(tag, 'href', derivedHref(f.type, v, cur)) };
    }).src;
  }
  return out;
}
