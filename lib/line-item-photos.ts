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
