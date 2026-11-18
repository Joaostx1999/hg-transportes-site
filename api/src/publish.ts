/* Publicação atômica via Git Data API: um commit por publicação (fotos + index.html), com checagem de base,
 * rebase quando outra pessoa publicou campos diferentes, conflito por campo, esquema validado no MESMO commit
 * do index.html e tentativa limitada quando o branch anda durante a publicação. Sem dependência de runtime:
 * o Worker usa com o cliente HTTP do GitHub; os testes usam com um GitHub falso ou com o mock git real. */
import { HttpError, MSG, type FieldErrors } from './http.ts';
import { applySource, EditorError, type EditableField } from './html-editor.ts';
import { checkImage, type ImageType } from './image.ts';
import {
  checkAgainstSchema,
  extractFields,
  parseSchema,
  schemaIndex,
  SchemaError,
  type FieldValue,
  type Schema,
  type SchemaField,
} from './schema.ts';
import { SHA_RE, type GitApi, type GitPerson } from './github.ts';
import { decodeUtf8Strict, hasOwn, isRecord, randomBytes, toHex, truncate, utf8 } from './util.ts';
import { canonicalValue, normalizeValue, validateValue } from './validate.ts';

export const PHOTOS_DIR = 'assets/fotos';
export const MAX_IMAGES = 6;
export const MAX_CHANGES = 200;
export const MAX_ATTEMPTS = 3;
/** Quantas versões do index.html (do branch) o /restore aceita como alvo. A tela mostra as 30 mais novas. */
export const RESTORE_DEPTH = 100;

export type Editor = (src: string, f: EditableField, v: string) => string;

export interface PublishContext {
  git: GitApi;
  username: string;
  page: string;
  schemaPath: string;
  maxImageBytes: number;
  now: () => number;
  /** fonte de aleatoriedade para o nome das fotos (injetável em teste) */
  random?: (n: number) => Uint8Array;
  maxAttempts?: number;
  /** editor do HTML (injetável só para testar a verificação de integridade) */
  editor?: Editor;
}

export interface DecodedImage {
  type: ImageType;
  ext: string;
  bytes: Uint8Array;
}

export interface PublishRequest {
  base: string;
  changes: Record<string, string>;
  images: Record<string, DecodedImage>;
  /** valor que o painel mostrava como "publicado" para cada campo enviado (conferido contra o HEAD) */
  expected?: Record<string, string>;
}

export interface ChangeRecord {
  key: string;
  old: string;
  new: string;
}

export interface PublishResult {
  commit: string;
  changed: string[];
  paths: Record<string, string>;
  attempts: number;
  rebased: boolean;
  /** rebase: campos que outra pessoa mudou entre a base do painel e o HEAD (o painel precisa recarregar) */
  othersChanged: string[];
  records: ChangeRecord[];
}

/**
 * Verificação interna do resultado que nunca deveria falhar (as propriedades do editor são testadas).
 * Vira 422 com código próprio ("integrity") e o campo, nunca um 500 genérico: nada é publicado.
 */
export class IntegrityError extends HttpError {
  readonly detail: string;
  constructor(key: string, detail: string) {
    super('integrity', MSG.integrity, { [key]: 'Este campo não ficou como esperado depois da edição.' });
    this.name = 'IntegrityError';
    this.detail = key + ': ' + detail;
  }
}

/* ---------------- entrada ---------------- */

export function parsePublishRequest(body: Record<string, unknown>, maxImageBytes: number): PublishRequest {
  const base = typeof body.base === 'string' ? body.base.toLowerCase() : '';
  if (!SHA_RE.test(base))
    throw new HttpError('bad_request', 'Pedido inválido: base precisa ser o commit do /content.');
  const rawChanges = body.changes ?? {};
  const rawImages = body.images ?? {};
  const rawExpected = body.expected ?? {};
  if (!isRecord(rawChanges) || !isRecord(rawImages) || !isRecord(rawExpected))
    throw new HttpError('bad_request', 'Pedido inválido.');
  const ck = Object.keys(rawChanges);
  const ik = Object.keys(rawImages);
  if (!ck.length && !ik.length) throw new HttpError('bad_request', MSG.noChange);
  if (ck.length > MAX_CHANGES) throw new HttpError('bad_request', 'Alterações demais de uma vez.');
  if (ik.length > MAX_IMAGES) {
    throw new HttpError('bad_request', 'No máximo ' + MAX_IMAGES + ' fotos por publicação.');
  }
  const errors: FieldErrors = {};
  const changes: Record<string, string> = {};
  for (const k of ck) {
    const v = rawChanges[k];
    if (typeof v !== 'string') errors[k] = 'Valor inválido.';
    else changes[k] = normalizeValue(v);
  }
  const images: Record<string, DecodedImage> = {};
  let tooLarge = false;
  for (const k of ik) {
    const img = rawImages[k];
    if (hasOwn(changes, k)) {
      errors[k] = 'Envie a foto só em images.';
      continue;
    }
    const r = isRecord(img)
      ? checkImage(img.type, img.data, maxImageBytes)
      : ({ ok: false, code: 'validation', error: 'Foto inválida.' } as const);
    if (r.ok) images[k] = { type: r.type, ext: r.ext, bytes: r.bytes };
    else {
      errors[k] = r.error;
      if (r.code === 'too_large') tooLarge = true;
    }
  }
  if (Object.keys(errors).length) {
    throw new HttpError(tooLarge ? 'too_large' : 'validation', tooLarge ? MSG.tooLarge : MSG.review, errors);
  }
  const expected: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawExpected)) {
    if (typeof v !== 'string' || v.length > 2000 || (!hasOwn(changes, k) && !hasOwn(images, k)))
      throw new HttpError('bad_request', 'Pedido inválido: expected só para campos enviados, em texto.');
    expected[k] = normalizeValue(v);
  }
  return { base, changes, images, expected };
}

/* ---------------- leitura de uma versão ---------------- */

function decodeHtml(bytes: Uint8Array): string {
  try {
    return decodeUtf8Strict(bytes);
  } catch {
    throw new HttpError('upstream', 'O arquivo do site não está em UTF-8.');
  }
}

async function readHtml(ctx: PublishContext, commit: string): Promise<string | null> {
  const b = await ctx.git.getFile(commit, ctx.page);
  return b ? decodeHtml(b) : null;
}

export async function readSchema(
  ctx: Pick<PublishContext, 'git' | 'schemaPath'>,
  commit: string,
): Promise<Schema> {
  const b = await ctx.git.getFile(commit, ctx.schemaPath);
  const bad = (m: string): never => {
    throw new HttpError('schema_mismatch', MSG.schema, { [ctx.schemaPath]: m });
  };
  if (!b) return bad('Arquivo de esquema não encontrado no commit.');
  try {
    return parseSchema(JSON.parse(decodeUtf8Strict(b)) as unknown);
  } catch (e) {
    return bad(e instanceof SchemaError ? e.message : 'schema.json inválido.');
  }
}

function assertSchema(html: string, schema: Schema): void {
  const problems = checkAgainstSchema(html, schema);
  if (Object.keys(problems).length) throw new HttpError('schema_mismatch', MSG.schema, problems);
}

/* ---------------- conteúdo ---------------- */

export interface FieldRule {
  key: string;
  type: SchemaField['type'];
  max: number;
}

/**
 * HTML e commit do HEAD, mais as regras por campo (tipo e limite) do esquema do MESMO commit: o painel usa
 * o limite daqui em vez de repetir números (C6). Esquema inválido: schemaVersion e fields null.
 */
export async function loadContent(ctx: Pick<PublishContext, 'git' | 'page' | 'schemaPath'>): Promise<{
  html: string;
  commit: string;
  schemaVersion: number | null;
  fields: FieldRule[] | null;
}> {
  const commit = await ctx.git.getHead();
  const b = await ctx.git.getFile(commit, ctx.page);
  if (!b) throw new HttpError('upstream', 'O arquivo do site não foi encontrado no GitHub.');
  let schema: Schema | null = null;
  try {
    schema = await readSchema(ctx, commit);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
  }
  return {
    html: decodeHtml(b),
    commit,
    schemaVersion: schema?.version ?? null,
    fields: schema ? schema.fields.map((f) => ({ key: f.key, type: f.type, max: f.max })) : null,
  };
}

/* ---------------- publicação ---------------- */

/**
 * Aplica as mudanças de texto sobre `html`. Valor igual ao atual (na forma canônica do tipo) não é reaplicado,
 * e mudança que não altera nenhum byte não conta. Mesma função usada pelo /publish e pelos testes.
 */
export function applyChanges(
  html: string,
  idx: Map<string, SchemaField>,
  current: Map<string, FieldValue>,
  changes: Record<string, string>,
  editor: Editor = applySource,
): { html: string; changed: string[]; records: ChangeRecord[] } {
  let out = html;
  const changed: string[] = [];
  const records: ChangeRecord[] = [];
  for (const [k, v] of Object.entries(changes)) {
    const f = idx.get(k);
    const cur = current.get(k);
    if (!f || !cur) continue;
    if (canonicalValue(f.type, v) === canonicalValue(f.type, cur.value)) continue;
    const next = editor(out, f, v);
    if (next === out) continue;
    out = next;
    changed.push(k);
    records.push({ key: k, old: truncate(cur.value), new: truncate(v) });
  }
  return { html: out, changed, records };
}

export function author(username: string, nowMs: number): GitPerson {
  return {
    name: username + ' (painel)',
    email: username + '@painel.hgtransportes.invalid',
    date: new Date(nowMs).toISOString(),
  };
}

export function publishMessage(username: string, items: { key: string; label: string }[]): string {
  const lines = items.map((i) => '- ' + i.key + ': ' + i.label.replace(/\s+/g, ' ').trim());
  return 'Painel: ' + username + ' alterou ' + items.length + ' campo(s)\n\n' + lines.join('\n') + '\n';
}

function newPhotoPath(ext: string, random: (n: number) => Uint8Array): string {
  return PHOTOS_DIR + '/cms-' + toHex(random(8)) + '.' + ext;
}

export async function publish(ctx: PublishContext, req: PublishRequest): Promise<PublishResult> {
  const random = ctx.random ?? randomBytes;
  const maxAttempts = ctx.maxAttempts ?? MAX_ATTEMPTS;
  const editor = ctx.editor ?? applySource;
  const keys = [...Object.keys(req.changes), ...Object.keys(req.images)];
  // caminho e blob de cada foto: gerados uma vez e reaproveitados nas novas tentativas
  const paths: Record<string, string> = {};
  for (const [k, img] of Object.entries(req.images)) paths[k] = newPhotoPath(img.ext, random);
  const imageBlobs = new Map<string, string>();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const head = await ctx.git.getHead();
    const headCommit = await ctx.git.getCommit(head);
    if (!headCommit) throw new HttpError('upstream', MSG.upstream);
    const headHtml = await readHtml(ctx, head);
    if (headHtml === null) throw new HttpError('upstream', 'O arquivo do site não foi encontrado no GitHub.');
    const schema = await readSchema(ctx, head);
    assertSchema(headHtml, schema);
    const idx = schemaIndex(schema);

    // 1. chaves e valores pelo esquema do HEAD
    const errors: FieldErrors = {};
    for (const [k, v] of Object.entries(req.changes)) {
      const f = idx.get(k);
      if (!f) errors[k] = 'Campo desconhecido.';
      else if (f.type === 'image') errors[k] = 'Para trocar a foto, envie a imagem.';
      else {
        const msg = validateValue(f.type, v, f.max);
        if (msg) errors[k] = msg;
      }
    }
    for (const k of Object.keys(req.images)) {
      const f = idx.get(k);
      if (!f) errors[k] = 'Campo desconhecido.';
      else if (f.type !== 'image') errors[k] = 'Este campo não é uma foto.';
    }
    if (Object.keys(errors).length) throw new HttpError('validation', MSG.review, errors);

    // 2. base diferente do HEAD: conflito só se alguém mexeu nos MESMOS campos; senão rebase.
    //    E, com ou sem rebase, o valor que o painel mostrava (expected) tem de ser o do HEAD: protege contra
    //    painel com base nova e campo velho (C1).
    const headVals = extractFields(headHtml).byKey;
    const rebased = head !== req.base;
    const conflicts: FieldErrors = {};
    const othersChanged: string[] = [];
    const CONFLICT_MSG = 'Outra pessoa alterou este campo depois que você abriu o painel.';
    if (rebased) {
      const baseHtml = (await ctx.git.getCommit(req.base)) ? await readHtml(ctx, req.base) : null;
      if (baseHtml === null) throw new HttpError('conflict', MSG.conflict);
      const baseVals = extractFields(baseHtml).byKey;
      for (const k of keys) {
        const b = baseVals.get(k);
        const h = headVals.get(k);
        // tipo trocado no HEAD (ex.: phone -> text com o mesmo texto) também é mudança de outra pessoa:
        // a edição foi pensada para o tipo antigo (C10; teste em api-content "tipo diferente no HEAD")
        let same = false;
        if (b && h) same = b.value === h.value && b.type === h.type;
        if (!same) conflicts[k] = CONFLICT_MSG;
      }
      for (const f of schema.fields) {
        const b = baseVals.get(f.key);
        const h = headVals.get(f.key);
        if (b?.value !== h?.value || b?.type !== h?.type || !b) othersChanged.push(f.key);
      }
    }
    for (const [k, want] of Object.entries(req.expected ?? {})) {
      const f = idx.get(k);
      const h = headVals.get(k);
      if (!f || !h || conflicts[k]) continue;
      if (canonicalValue(f.type, want) !== canonicalValue(f.type, h.value)) conflicts[k] = CONFLICT_MSG;
    }
    if (Object.keys(conflicts).length) throw new HttpError('conflict', MSG.conflict, conflicts);

    // 3. edição cirúrgica sobre o HEAD (campo com valor igual ao atual não é reaplicado)
    let html: string;
    let changed: string[];
    let records: ChangeRecord[];
    const intended = new Map<string, string>();
    try {
      ({ html, changed, records } = applyChanges(headHtml, idx, headVals, req.changes, editor));
      for (const k of changed) intended.set(k, req.changes[k] ?? '');
      for (const k of Object.keys(req.images)) {
        const f = idx.get(k);
        const p = paths[k];
        if (!f || !p) continue;
        html = editor(html, f, p);
        changed.push(k);
        intended.set(k, p);
        records.push({ key: k, old: truncate(headVals.get(k)?.value ?? ''), new: p });
      }
    } catch (e) {
      if (e instanceof EditorError) throw new HttpError('schema_mismatch', MSG.schema, { site: e.message });
      throw e;
    }
    if (!changed.length) throw new HttpError('bad_request', MSG.noChange);

    // 4. verificação do resultado: esquema intacto, campos alterados com o valor pedido, resto igual
    const broken = Object.keys(checkAgainstSchema(html, schema));
    if (broken.length) throw new IntegrityError(broken[0] ?? 'site', 'o resultado não passa no esquema');
    const outVals = extractFields(html).byKey;
    for (const f of schema.fields) {
      const o = outVals.get(f.key)?.value ?? '';
      const want = intended.get(f.key);
      const ok =
        want === undefined
          ? o === (headVals.get(f.key)?.value ?? '')
          : canonicalValue(f.type, o) === canonicalValue(f.type, want);
      if (!ok) throw new IntegrityError(f.key, 'não ficou como esperado');
    }

    // 5. um commit: blobs das fotos + index.html, tree sobre a do HEAD, parent = HEAD
    const entries = [];
    for (const [k, img] of Object.entries(req.images)) {
      let sha = imageBlobs.get(k);
      if (!sha) {
        sha = await ctx.git.createBlob(img.bytes);
        imageBlobs.set(k, sha);
      }
      entries.push({ path: paths[k] ?? '', sha });
    }
    entries.push({ path: ctx.page, sha: await ctx.git.createBlob(utf8(html)) });
    const tree = await ctx.git.createTree(headCommit.tree, entries);
    const who = author(ctx.username, ctx.now());
    const message = publishMessage(
      ctx.username,
      changed.map((k) => ({ key: k, label: idx.get(k)?.label ?? k })),
    );
    const commit = await ctx.git.createCommit({
      message,
      tree,
      parents: [head],
      author: who,
      committer: who,
    });
    if ((await ctx.git.updateHead(commit)) === 'ok') {
      const outPaths: Record<string, string> = {};
      for (const k of Object.keys(req.images)) if (paths[k]) outPaths[k] = paths[k];
      return { commit, changed, paths: outPaths, attempts: attempt, rebased, othersChanged, records };
    }
    // o branch andou entre a leitura e o PATCH: recomeça do HEAD novo
  }
  throw new HttpError('conflict', 'O site mudou várias vezes durante a publicação. Tente de novo.');
}

/* ---------------- restauração ---------------- */

export async function restore(
  ctx: PublishContext,
  target: string,
  base: string,
): Promise<{ commit: string; restored: string }> {
  const commitSha = target.toLowerCase();
  const baseSha = base.toLowerCase();
  if (!SHA_RE.test(commitSha) || !SHA_RE.test(baseSha))
    throw new HttpError('bad_request', 'Pedido inválido.');
  const head = await ctx.git.getHead();
  if (head !== baseSha) throw new HttpError('conflict', MSG.conflict);
  const headCommit = await ctx.git.getCommit(head);
  if (!headCommit) throw new HttpError('upstream', MSG.upstream);
  // S1: só versões do PRÓPRIO branch que tocaram o index.html (as que a tela "Versões" lista). Um sha
  // qualquer do repositório (ex.: refs/pull/N/head de um PR não revisado) não vira site publicado.
  const versions = await ctx.git.history(ctx.page, RESTORE_DEPTH);
  if (!versions.some((v) => v.commit === commitSha))
    throw new HttpError('not_found', 'Versão não encontrada.');
  if (!(await ctx.git.getCommit(commitSha))) throw new HttpError('not_found', 'Versão não encontrada.');
  const old = await readHtml(ctx, commitSha);
  if (old === null) throw new HttpError('not_found', 'Versão não encontrada.');
  const cur = await readHtml(ctx, head);
  if (cur === old) throw new HttpError('bad_request', 'Esta já é a versão atual do site.');
  assertSchema(old, await readSchema(ctx, head));
  const tree = await ctx.git.createTree(headCommit.tree, [
    { path: ctx.page, sha: await ctx.git.createBlob(utf8(old)) },
  ]);
  const who = author(ctx.username, ctx.now());
  const message = 'Painel: ' + ctx.username + ' voltou o site para a versão ' + commitSha.slice(0, 7) + '\n';
  const commit = await ctx.git.createCommit({ message, tree, parents: [head], author: who, committer: who });
  if ((await ctx.git.updateHead(commit)) !== 'ok') throw new HttpError('conflict', MSG.conflict);
  return { commit, restored: commitSha };
}
