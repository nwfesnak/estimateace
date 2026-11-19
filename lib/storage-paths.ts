/**
 * Ownership checks for `media` bucket paths that the server reads with the service
 * role (which bypasses storage RLS). Every path must sit inside one of the allowed
 * workspace folders (`<ownerId>/...`) and may not climb out of it.
 */
import { extractMediaStoragePath } from '@/lib/media-url';

/** Normalise a storage path / legacy signed or public URL, or null when unusable. */
export function normalizeMediaPath(ref: string): string | null {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  let path: string | null;
  if (/^https?:\/\//i.test(raw)) {
    path = extractMediaStoragePath(raw);
  } else if (raw.includes('://') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return null; // javascript:, data:, file:, etc.
  } else {
    path = raw;
  }
  if (!path) return null;
  path = path.replace(/^\/+/, '');
  if (!path || path.length > 512) return null;
  // Check the path as given and once more decoded (catches %2e%2e / %2f tricks).
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* literal % in a file name: check the raw form only */
  }
  for (const form of [path, decoded]) {
    if (/[\\\0]/.test(form)) return null;
    if (form.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
  }
  return path;
}

/**
 * Returns the normalised path when it lives under one of `allowedOwnerIds`'s folders,
 * otherwise null.
 */
export function ownedMediaPath(ref: string, allowedOwnerIds: Array<string | null | undefined>): string | null {
  const path = normalizeMediaPath(ref);
  if (!path) return null;
  const top = path.split('/')[0];
  const allowed = allowedOwnerIds.map((id) => String(id || '').trim()).filter(Boolean);
  return allowed.includes(top) ? path : null;
}
