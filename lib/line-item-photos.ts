/**
 * Photos attached to a single estimate / invoice line ("line photos").
 *
 * Storage: the private `media` bucket, same `<workspaceUserId>/...` folder rule (and the
 * same storage RLS policies) as Site Photos, under `<uid>/line-photo/<file>.jpg`.
 * DB link: the storage paths live on the line itself (`items[n].photos: string[]`) inside the
 * estimates row's existing `items` JSONB, so they save, reload, convert (estimate ⇄ invoice)
 * and copy together with the line and are covered by the estimates table's existing RLS.
 *
 * Site Photos (`photoUrls`) are a separate list and are never touched by these helpers.
 */
import { ownedMediaPath } from '@/lib/storage-paths';
import { lineOptionId } from '@/lib/optional-line-items';

export const LINE_PHOTO_LIMIT = 5;
/** Storage sub-folder under the workspace owner's folder. */
export const LINE_PHOTO_FOLDER = 'line-photo';

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i;

/** Clean list of stored photo refs on a line (strings only, de-duplicated, capped at 5). */
export function getLinePhotos(item: unknown): string[] {
  const raw = (item as { photos?: unknown } | null | undefined)?.photos;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const ref of raw) {
    if (typeof ref !== 'string') continue;
    const v = ref.trim();
    if (!v || out.includes(v)) continue;
    out.push(v);
    if (out.length >= LINE_PHOTO_LIMIT) break;
  }
  return out;
}

/** How many more photos this line can take. */
export function remainingLinePhotoSlots(item: unknown): number {
  return Math.max(0, LINE_PHOTO_LIMIT - getLinePhotos(item).length);
}

/** Return a copy of the line with `paths` appended (anything past the cap is dropped). */
export function withLinePhotosAdded<T extends Record<string, unknown>>(item: T, paths: string[]): T {
  const next = [...getLinePhotos(item)];
  for (const p of paths) {
    const v = typeof p === 'string' ? p.trim() : '';
    if (!v || next.includes(v)) continue;
    if (next.length >= LINE_PHOTO_LIMIT) break;
    next.push(v);
  }
  return { ...item, photos: next };
}

/** Return a copy of the line without the photo at `index`. */
export function withLinePhotoRemoved<T extends Record<string, unknown>>(item: T, index: number): T {
  const next = getLinePhotos(item).filter((_, i) => i !== index);
  return { ...item, photos: next };
}

/** Move the photo at `from` one step left (-1) or right (+1). Out-of-range moves are no-ops. */
export function withLinePhotoMoved<T extends Record<string, unknown>>(item: T, from: number, dir: -1 | 1): T {
  const list = getLinePhotos(item);
  const to = from + dir;
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return { ...item, photos: list };
  const next = [...list];
  [next[from], next[to]] = [next[to], next[from]];
  return { ...item, photos: next };
}

/** Every distinct line-photo ref across all lines (for resolving display URLs). */
export function allLinePhotoRefs(items: unknown): string[] {
  const out = new Set<string>();
  for (const it of Array.isArray(items) ? items : []) {
    for (const p of getLinePhotos(it)) out.add(p);
  }
  return Array.from(out);
}

function ownedImage(ref: unknown, uid: string): string | null {
  if (typeof ref !== 'string') return null;
  const path = ownedMediaPath(ref, [uid]);
  if (!path) return null;
  const clean = path.split('?')[0];
  if (/\.[a-z0-9]{2,5}$/i.test(clean) && !IMAGE_EXT.test(clean)) return null;
  if (path.split('/').some((seg) => /^receipts?$/i.test(seg))) return null;
  return path;
}

/** lineId → storage paths, owner folder + images only. lineId matches the client document's item id. */
export type ClientLinePhotoPlan = Array<{ lineId: string; paths: string[] }>;

/**
 * Decide which line photos the customer page may show. `items` are the row's items in the
 * same order the document route sends them (index is used for lines without an id).
 */
export function planClientLinePhotos(items: unknown, uid: string, maxLines = 40): ClientLinePhotoPlan {
  const owner = String(uid || '').trim();
  if (!owner || !Array.isArray(items)) return [];
  const plan: ClientLinePhotoPlan = [];
  items.slice(0, maxLines).forEach((it, index) => {
    const paths: string[] = [];
    for (const ref of getLinePhotos(it)) {
      const p = ownedImage(ref, owner);
      if (p && !paths.includes(p)) paths.push(p);
    }
    if (paths.length) plan.push({ lineId: lineOptionId(it, index), paths });
  });
  return plan;
}

export type ClientLinePhotos = Record<string, Array<{ url: string }>>;

type SignFn = (
  paths: string[],
  ttlSec: number
) => Promise<Array<{ path: string | null; signedUrl: string | null; error?: unknown }> | null>;

/** Sign a line-photo plan. Failures are dropped; storage paths never reach the browser. */
export async function signClientLinePhotos(
  plan: ClientLinePhotoPlan,
  sign: SignFn,
  ttlSec: number
): Promise<ClientLinePhotos> {
  const all = Array.from(new Set(plan.flatMap((l) => l.paths)));
  if (all.length === 0) return {};
  const map = new Map<string, string>();
  try {
    const signed = (await sign(all, ttlSec)) || [];
    for (const s of signed) if (s?.path && s.signedUrl && !s.error) map.set(s.path, s.signedUrl);
  } catch {
    return {};
  }
  const out: ClientLinePhotos = {};
  for (const l of plan) {
    const urls = l.paths.filter((p) => map.has(p)).map((p) => ({ url: map.get(p)! }));
    if (urls.length) out[l.lineId] = urls;
  }
  return out;
}

/** Storage path for a new line photo (unique; never overwrites). */
export function newLinePhotoPath(workspaceUserId: string, ext: string, rand: string, now = Date.now()): string {
  const safeExt = String(ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  return `${workspaceUserId}/${LINE_PHOTO_FOLDER}/${now}-${rand}.${safeExt}`;
}

/** Short caption for a line's photos inside the Site Photos section ("Line 2: Paint living room"). */
export function linePhotoCaption(item: unknown, index: number, max = 60): string {
  const desc = String((item as { description?: unknown } | null)?.description || '')
    .replace(/\s+/g, ' ')
    .trim();
  const short = desc.length > max ? `${desc.slice(0, max - 1).trimEnd()}…` : desc;
  return short ? `Line ${index + 1}: ${short}` : `Line ${index + 1}`;
}

export type LinePhotoGroup = {
  /** Same id the customer document uses (lineOptionId). */
  lineId: string;
  /** Editor line id (items[n].id) for remove/sync; null for legacy lines without an id. */
  itemId: number | string | null;
  lineIndex: number;
  caption: string;
  refs: string[];
};

/**
 * Line photos as shown inside the Site Photos section. DERIVED from the line items every
 * render (never copied into photoUrls), so removing a photo from its line removes it here too.
 * Refs that are already a Site Photo are skipped so nothing shows twice.
 * `include: false` (the Send "Site Photos" switch is off) → no line photos in the section;
 * they still show under their own lines.
 */
export function siteSectionLinePhotoGroups(
  items: unknown,
  sitePhotoRefs: string[] = [],
  include = true
): LinePhotoGroup[] {
  if (!include || !Array.isArray(items)) return [];
  const site = new Set((sitePhotoRefs || []).map((r) => String(r || '').trim()).filter(Boolean));
  const seen = new Set<string>();
  const groups: LinePhotoGroup[] = [];
  items.forEach((it, index) => {
    const refs = getLinePhotos(it).filter((r) => !site.has(r) && !seen.has(r));
    refs.forEach((r) => seen.add(r));
    if (refs.length === 0) return;
    const rawId = (it as { id?: unknown } | null)?.id;
    groups.push({
      lineId: lineOptionId(it, index),
      itemId: typeof rawId === 'number' || typeof rawId === 'string' ? rawId : null,
      lineIndex: index,
      caption: linePhotoCaption(it, index),
      refs,
    });
  });
  return groups;
}

/** Total photos the Site Photos section shows: site photos + derived line photos. */
export function siteSectionPhotoCount(sitePhotoRefs: string[], items: unknown, include = true): number {
  const site = (sitePhotoRefs || []).filter((r) => String(r || '').trim()).length;
  return site + siteSectionLinePhotoGroups(items, sitePhotoRefs, include).reduce((n, g) => n + g.refs.length, 0);
}

/** Customer page: signed line photos grouped with captions for the Site Photos section. */
export function clientSiteLinePhotoGroups(
  items: unknown,
  linePhotos: ClientLinePhotos,
  include: boolean,
  maxLines = 40
): Array<{ caption: string; photos: Array<{ url: string }> }> {
  if (!include || !Array.isArray(items)) return [];
  const out: Array<{ caption: string; photos: Array<{ url: string }> }> = [];
  items.slice(0, maxLines).forEach((it, index) => {
    const photos = linePhotos[lineOptionId(it, index)];
    if (photos && photos.length) out.push({ caption: linePhotoCaption(it, index), photos });
  });
  return out;
}
