/**
 * Cross-device sync for estimate / invoice rows.
 *
 * The editor saves the whole `estimates` row (upsert) from whatever the open tab has in
 * memory. Before this module, a tab that had been open for a while (e.g. the PC) would write
 * its old `photoUrls` / `items[n].photos` back over photos another device (the phone) had
 * just saved. Now every owner save does a three-way check against the version this tab last
 * loaded or saved (the "base"):
 *
 *   - nothing changed anywhere                 -> skip the write
 *   - only this tab changed                    -> write as before
 *   - only the other device changed            -> do NOT write; adopt the newer row
 *   - both changed                             -> write this tab's edits, but three-way
 *                                                 merge the media lists (site photos,
 *                                                 videos, receipts, line photos, AI
 *                                                 renderings) so neither side's adds or
 *                                                 removes are lost
 *
 * Non-media fields keep "this tab wins" when both devices edited them at once (same as
 * before). Pure functions only, so they are unit-tested in scripts/test-photo-sync.test.mjs.
 */

export type DocRow = Record<string, unknown>;

/** Payload keys the editor writes that are compared between versions (no id / timestamps). */
export const DOC_SYNC_KEYS = [
  'jobName',
  'address',
  'city',
  'state',
  'zipCode',
  'phones',
  'emails',
  'date',
  'items',
  'terms',
  'profile',
  'documentType',
  'dueDate',
  'paymentStatus',
  'amountPaid',
  'paymentMethod',
  'photoUrls',
  'videoUrls',
  'receiptUrls',
  'receiptDetails',
  'laborHours',
  'laborRate',
  'laborFixedAmount',
  'useHourlyLabor',
  'laborAmount',
  'taxRate',
  'taxAmount',
  'isTaxExempt',
  'taxLabor',
] as const;

/** Read a column that may come back camelCase (quoted) or lowercase (unquoted schema). */
export function readDocField(row: DocRow | null | undefined, key: string): unknown {
  if (!row || typeof row !== 'object') return undefined;
  if (key in row && row[key] !== undefined) return row[key];
  const lower = key.toLowerCase();
  return row[lower];
}

/** JSON with sorted object keys (Postgres jsonb does not keep key order). */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function normalizedField(row: DocRow | null | undefined, key: string): string {
  const v = readDocField(row, key);
  if (v === undefined || v === null) return 'null';
  if (key === 'amountPaid' || key === 'laborHours' || key === 'laborRate' || key === 'laborFixedAmount' ||
      key === 'laborAmount' || key === 'taxRate' || key === 'taxAmount') {
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : 'null';
  }
  return stableStringify(v);
}

/** True when two versions of a document have the same saved content (ignores id / updated_at). */
export function sameDocContent(a: DocRow | null | undefined, b: DocRow | null | undefined): boolean {
  if (!a || !b) return false;
  return DOC_SYNC_KEYS.every((k) => normalizedField(a, k) === normalizedField(b, k));
}

function timeOf(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Remote row differs from the version this tab is based on. */
export function remoteChangedSince(base: DocRow | null | undefined, remote: DocRow | null | undefined): boolean {
  if (!base || !remote) return false;
  const bt = timeOf(readDocField(base, 'updated_at'));
  const rt = timeOf(readDocField(remote, 'updated_at'));
  if (bt !== null && rt !== null && bt === rt) return false;
  return !sameDocContent(base, remote);
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const s = x.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Three-way merge of a list of refs: keep this tab's list, drop what the other device removed
 * (was in base, gone from remote), then append what the other device added (not in base).
 */
export function mergeRefList(base: unknown, local: unknown, remote: unknown): string[] {
  const b = new Set(stringList(base));
  const l = stringList(local);
  const r = stringList(remote);
  const rSet = new Set(r);
  const out = l.filter((x) => !(b.has(x) && !rSet.has(x)));
  for (const x of r) {
    if (!b.has(x) && !out.includes(x)) out.push(x);
  }
  return out;
}

function objList(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];
}

/** Three-way merge of a list of objects keyed by `keyOf` (renderings by id, receipt details by url). */
export function mergeKeyedList(
  base: unknown,
  local: unknown,
  remote: unknown,
  keyOf: (x: Record<string, unknown>) => string
): Record<string, unknown>[] {
  const b = new Set(objList(base).map(keyOf));
  const r = objList(remote);
  const rKeys = new Set(r.map(keyOf));
  const out = objList(local).filter((x) => {
    const k = keyOf(x);
    return !(b.has(k) && !rKeys.has(k));
  });
  const outKeys = new Set(out.map(keyOf));
  for (const x of r) {
    const k = keyOf(x);
    if (!b.has(k) && !outKeys.has(k)) {
      out.push(x);
      outKeys.add(k);
    }
  }
  return out;
}

const lineKey = (it: Record<string, unknown>) => (it.id != null ? String(it.id) : '');

/**
 * Keep this tab's lines (text, qty, price…) but three-way merge each line's `photos`, and keep
 * lines the other device added. `photoLimit` matches LINE_PHOTO_LIMIT.
 */
export function mergeLineItems(base: unknown, local: unknown, remote: unknown, photoLimit = 5): Record<string, unknown>[] {
  const bLines = objList(base);
  const rLines = objList(remote);
  // This tab did not touch the lines at all: take the other device's lines as they are.
  if (stableStringify(objList(local)) === stableStringify(bLines)) return rLines;
  const bById = new Map(bLines.map((x) => [lineKey(x), x] as const));
  const rById = new Map(rLines.map((x) => [lineKey(x), x] as const));
  const out = objList(local).map((line) => {
    const k = lineKey(line);
    if (!k) return line;
    const r = rById.get(k);
    if (!r) return line;
    const b = bById.get(k);
    const photos = mergeRefList(b?.photos, line.photos, r.photos).slice(0, photoLimit);
    if (stableStringify(photos) === stableStringify(stringList(line.photos))) return line;
    return { ...line, photos };
  });
  const outKeys = new Set(out.map(lineKey));
  for (const r of rLines) {
    const k = lineKey(r);
    if (k && !bById.has(k) && !outKeys.has(k)) {
      out.push(r);
      outKeys.add(k);
    }
  }
  return out;
}

export type MergedMedia = {
  photoUrls: string[];
  videoUrls: string[];
  receiptUrls: string[];
  receiptDetails: Record<string, unknown>[];
  items: Record<string, unknown>[];
  jobRenderings: Record<string, unknown>[];
};

function renderingsOf(row: DocRow | null | undefined): unknown {
  const p = readDocField(row, 'profile') as Record<string, unknown> | null | undefined;
  return (p && typeof p === 'object' ? p._jobRenderings : undefined) ?? readDocField(row, '_jobRenderings');
}

const receiptKey = (d: Record<string, unknown>) =>
  String(d.url || d.path || d.id || stableStringify(d));
const renderingKey = (r: Record<string, unknown>) =>
  String(r.id || r.resultPath || r.sourcePath || stableStringify(r));

/** Three-way merge of every media list on the document. */
export function mergeDocumentMedia(base: DocRow, local: DocRow, remote: DocRow, photoLimit = 5): MergedMedia {
  return {
    photoUrls: mergeRefList(readDocField(base, 'photoUrls'), readDocField(local, 'photoUrls'), readDocField(remote, 'photoUrls')),
    videoUrls: mergeRefList(readDocField(base, 'videoUrls'), readDocField(local, 'videoUrls'), readDocField(remote, 'videoUrls')),
    receiptUrls: mergeRefList(readDocField(base, 'receiptUrls'), readDocField(local, 'receiptUrls'), readDocField(remote, 'receiptUrls')),
    receiptDetails: mergeKeyedList(
      readDocField(base, 'receiptDetails'),
      readDocField(local, 'receiptDetails'),
      readDocField(remote, 'receiptDetails'),
      receiptKey
    ),
    items: mergeLineItems(readDocField(base, 'items'), readDocField(local, 'items'), readDocField(remote, 'items'), photoLimit),
    jobRenderings: mergeKeyedList(renderingsOf(base), renderingsOf(local), renderingsOf(remote), renderingKey),
  };
}

export type SyncDecision =
  | { action: 'write' }
  | { action: 'skip' }
  | { action: 'adopt-remote' }
  | { action: 'write-merged'; media: MergedMedia };

/**
 * Decide what a save should do. `base` = version this tab last loaded or saved (null if the
 * tab never had one, e.g. a brand-new document), `local` = what it is about to write,
 * `remote` = the row currently in the database (null if none / unreadable).
 */
export function decideDocumentSync(
  base: DocRow | null | undefined,
  local: DocRow,
  remote: DocRow | null | undefined,
  photoLimit = 5
): SyncDecision {
  if (!base || !remote) return { action: 'write' };
  const remoteChanged = remoteChangedSince(base, remote);
  const localChanged = !sameDocContent(local, base);
  if (!remoteChanged) return localChanged ? { action: 'write' } : { action: 'skip' };
  if (!localChanged) return { action: 'adopt-remote' };
  return { action: 'write-merged', media: mergeDocumentMedia(base, local, remote, photoLimit) };
}

/** Apply merged media onto a save payload (returns a new object). */
export function applyMergedMedia<T extends DocRow>(payload: T, media: MergedMedia): T {
  const profile = (payload.profile && typeof payload.profile === 'object' ? payload.profile : {}) as Record<string, unknown>;
  return {
    ...payload,
    photoUrls: media.photoUrls,
    videoUrls: media.videoUrls,
    receiptUrls: media.receiptUrls,
    receiptDetails: media.receiptDetails,
    items: media.items,
    profile: { ...profile, _jobRenderings: media.jobRenderings },
  };
}

/** Highest trailing document sequence (EST-3F9A1C-0007 -> 7) across rows / ids. */
export function maxDocumentSequence(rowsOrIds: unknown[]): number {
  let max = 0;
  for (const r of rowsOrIds || []) {
    const ids =
      typeof r === 'string'
        ? [r]
        : r && typeof r === 'object'
          ? [(r as DocRow).id, readDocField(r as DocRow, 'invoiceNumber')]
          : [];
    for (const id of ids) {
      const m = /^(?:EST|INV)-(?:[0-9A-F]{6}-)?(\d+)$/i.exec(String(id || '').trim());
      if (m) max = Math.max(max, parseInt(m[1], 10) || 0);
    }
  }
  return max;
}

/**
 * Next document sequence. The old code only used this device's localStorage counter, so a
 * phone and a PC could both mint EST-XXXXXX-0007 and the second save overwrote the first
 * device's estimate. Take the larger of the local counter and every number already used.
 */
export function nextDocumentSequence(localCounter: number, rowsOrIds: unknown[]): number {
  const local = Number.isFinite(localCounter) ? Math.max(0, Math.floor(localCounter)) : 0;
  return Math.max(local, maxDocumentSequence(rowsOrIds)) + 1;
}
