/**
 * Customer-facing job media for the public approve / pay page.
 *
 * The page is reached with a signed client-action token (uid + document id). The server
 * loads THAT document row only, then picks its site photos and ready before/after
 * renderings. Every path must live in the contractor's own `media` folder
 * (`<uid>/...`); anything else (other accounts, external URLs, data: URIs, traversal) is
 * dropped. The browser only ever receives short-lived signed URLs — never storage paths.
 */
import { ownedMediaPath } from '@/lib/storage-paths';
import { resolveAiJobRenderingEnabled } from '@/lib/job-settings-snapshot';

export const CLIENT_MEDIA_LIMITS = {
  maxPhotos: 12,
  maxRenderings: 6,
  /** Signed URL lifetime (seconds). The page re-requests the document when they expire. */
  signedUrlTtlSec: 15 * 60,
} as const;

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i;
const NON_IMAGE_EXT = /\.(pdf|mp4|mov|m4v|webm|avi|txt|csv|docx?|xlsx?)$/i;

export type ClientMediaPlan = {
  photos: string[];
  renderings: Array<{ beforePath: string | null; afterPath: string; label: string }>;
};

function isImagePath(path: string): boolean {
  const clean = path.split('?')[0];
  if (NON_IMAGE_EXT.test(clean)) return false;
  // Uploads are normally re-encoded to .jpg; allow extensionless names but never other files.
  return IMAGE_EXT.test(clean) || !/\.[a-z0-9]{2,5}$/i.test(clean);
}

function ownedImage(ref: unknown, uid: string): string | null {
  if (typeof ref !== 'string') return null;
  const path = ownedMediaPath(ref, [uid]);
  if (!path || !isImagePath(path)) return null;
  // Never show receipts on the customer page even if one was mis-filed as a photo.
  if (path.split('/').some((seg) => /^receipts?$/i.test(seg))) return null;
  return path;
}

/**
 * Decide which media a document may show its customer.
 * - `row`: the estimates row already loaded for the token (uid + id checked by the caller).
 * - `settingsProfile`: the contractor's SETTINGS profile (for the AI-rendering switch).
 */
export function planClientMedia(
  row: Record<string, unknown> | null | undefined,
  uid: string,
  settingsProfile?: Record<string, unknown> | null
): ClientMediaPlan {
  const empty: ClientMediaPlan = { photos: [], renderings: [] };
  const owner = String(uid || '').trim();
  if (!row || !owner) return empty;
  if (String(row.user_id || '').trim() !== owner) return empty;

  type Obj = Record<string, unknown>;
  const profile = (row.profile && typeof row.profile === 'object' ? row.profile : {}) as Obj;
  const share = (profile._clientMedia && typeof profile._clientMedia === 'object'
    ? profile._clientMedia
    : {}) as Record<string, unknown>;
  const showPhotos = share.photos !== false;
  const renderingsEnabled = resolveAiJobRenderingEnabled(profile, settingsProfile);
  const showRenderings = share.renderings !== false && renderingsEnabled;

  const photos: string[] = [];
  if (showPhotos) {
    const raw = row.photoUrls ?? row.photourls ?? [];
    for (const ref of Array.isArray(raw) ? raw : []) {
      const path = ownedImage(ref, owner);
      if (path && !photos.includes(path)) photos.push(path);
      if (photos.length >= CLIENT_MEDIA_LIMITS.maxPhotos) break;
    }
  }

  const renderings: ClientMediaPlan['renderings'] = [];
  if (showRenderings) {
    const raw = Array.isArray(profile._jobRenderings) ? profile._jobRenderings : [];
    for (const item of raw as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Obj;
      if (r.status === 'error') continue;
      const afterPath = ownedImage(r.resultPath, owner);
      if (!afterPath) continue;
      renderings.push({
        beforePath: ownedImage(r.sourcePath, owner),
        afterPath,
        label: String(r.lineDescription || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      });
      if (renderings.length >= CLIENT_MEDIA_LIMITS.maxRenderings) break;
    }
  }
  return { photos, renderings };
}

export type ClientMediaPayload = {
  photos: Array<{ url: string }>;
  renderings: Array<{ beforeUrl: string | null; afterUrl: string; label: string }>;
  expiresAt: string | null;
  /** Per-line photos keyed by the client item id (see lib/line-item-photos.ts). */
  linePhotos?: Record<string, Array<{ url: string }>>;
};

type SignFn = (
  paths: string[],
  ttlSec: number
) => Promise<Array<{ path: string | null; signedUrl: string | null; error?: unknown }> | null>;

/** Turn a plan into short-lived signed URLs. Items whose signing fails are dropped. */
export async function signClientMedia(
  plan: ClientMediaPlan,
  sign: SignFn,
  now = Date.now()
): Promise<ClientMediaPayload> {
  const ttl = CLIENT_MEDIA_LIMITS.signedUrlTtlSec;
  const all = Array.from(
    new Set([
      ...plan.photos,
      ...plan.renderings.flatMap((r) => [r.afterPath, ...(r.beforePath ? [r.beforePath] : [])]),
    ])
  );
  if (all.length === 0) return { photos: [], renderings: [], expiresAt: null };
  const map = new Map<string, string>();
  try {
    const signed = (await sign(all, ttl)) || [];
    for (const s of signed) {
      if (s?.path && s.signedUrl && !s.error) map.set(s.path, s.signedUrl);
    }
  } catch {
    return { photos: [], renderings: [], expiresAt: null };
  }
  const photos = plan.photos.filter((p) => map.has(p)).map((p) => ({ url: map.get(p)! }));
  const renderings = plan.renderings
    .filter((r) => map.has(r.afterPath))
    .map((r) => ({
      beforeUrl: r.beforePath ? map.get(r.beforePath) || null : null,
      afterUrl: map.get(r.afterPath)!,
      label: r.label,
    }));
  return {
    photos,
    renderings,
    expiresAt: photos.length || renderings.length ? new Date(now + ttl * 1000).toISOString() : null,
  };
}
