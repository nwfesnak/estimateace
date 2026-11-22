/**
 * Platform-wide help video tutorials (managed by EstimateAce platform admins).
 *
 * Link catalog: public.app_tutorials (writes only via /api/tutorials + service role).
 * Legacy uploaded files may still live on the estimates row PLATFORM-TUTORIALS.
 */

export const PLATFORM_TUTORIALS_ROW_ID = 'PLATFORM-TUTORIALS';

/** Built-in admins. Env PLATFORM_ADMIN_EMAILS can add more. */
export const DEFAULT_PLATFORM_ADMIN_EMAILS = [
  'admin@estimateace.com',
  'nwfesnak@gmail.com',
] as const;

export type PlatformTutorialKind = 'link' | 'file';

export type PlatformTutorial = {
  id: string;
  title: string;
  description: string;
  /** External https URL for link tutorials, or a signed playback URL for uploaded files. */
  url: string;
  thumbnailUrl?: string;
  sortOrder: number;
  createdAt: string;
  createdByEmail?: string;
  kind: PlatformTutorialKind;
  storagePath?: string;
  fileName?: string;
};

/** Comma-separated extra admin emails — server-only env (do not use NEXT_PUBLIC_*). */
export function emailsFromAdminEnv(raw: string | null | undefined): string[] {
  return String(raw || '')
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function getPlatformAdminEmails(
  envRaw: string | null | undefined = process.env.PLATFORM_ADMIN_EMAILS ||
    process.env.ESTIMATEACE_ADMIN_EMAILS ||
    ''
): string[] {
  const set = new Set<string>(DEFAULT_PLATFORM_ADMIN_EMAILS);
  for (const email of emailsFromAdminEnv(envRaw)) set.add(email);
  return [...set];
}

export function isPlatformAdminEmail(
  email: string | null | undefined,
  envRaw?: string | null
): boolean {
  if (!email) return false;
  return getPlatformAdminEmails(envRaw).includes(String(email).trim().toLowerCase());
}

export function isAllowedTutorialUrl(raw: string | null | undefined): boolean {
  const trimmed = String(raw || '').trim();
  if (!trimmed || trimmed.length > 2000) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (!parsed.hostname) return false;
  return true;
}

export function youtubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0] || '';
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] && ['embed', 'shorts', 'live', 'v'].includes(parts[0]) && parts[1] && /^[\w-]{11}$/.test(parts[1])) {
        return parts[1];
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function vimeoVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'vimeo.com' && host !== 'player.vimeo.com') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const id = host === 'player.vimeo.com' && parts[0] === 'video' ? parts[1] : parts[0];
    return id && /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Public thumbnail for YouTube or Vimeo; empty for other hosts. */
export function tutorialThumbnailUrl(url: string): string {
  const yt = youtubeVideoId(url);
  if (yt) return `https://img.youtube.com/vi/${yt}/hqdefault.jpg`;
  const vimeo = vimeoVideoId(url);
  if (vimeo) return `https://vumbnail.com/${vimeo}.jpg`;
  return '';
}

export function normalizeLinkTutorial(row: unknown, index = 0): PlatformTutorial | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const id = String(r.id || '').trim();
  const title = String(r.title || '').trim().slice(0, 200);
  const url = String(r.url || r.href || '').trim();
  if (!id || !title || !isAllowedTutorialUrl(url)) return null;
  const thumbnailUrl = tutorialThumbnailUrl(url);
  return {
    id,
    title,
    description: String(r.description || '').trim().slice(0, 2000),
    url,
    thumbnailUrl: thumbnailUrl || undefined,
    sortOrder: Number.isFinite(Number(r.sort_order ?? r.sortOrder))
      ? Number(r.sort_order ?? r.sortOrder)
      : index,
    createdAt: String(r.created_at ?? r.createdAt ?? ''),
    createdByEmail: r.created_by_email || r.createdByEmail
      ? String(r.created_by_email ?? r.createdByEmail)
      : undefined,
    kind: 'link',
  };
}

export function normalizeLinkTutorials(raw: unknown): PlatformTutorial[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row, i) => normalizeLinkTutorial(row, i))
    .filter((v): v is PlatformTutorial => Boolean(v))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
}

/** Legacy uploaded-file catalog stored on PLATFORM-TUTORIALS. */
export function normalizeTutorialsList(raw: unknown): PlatformTutorial[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row, i) => {
      if (!row || typeof row !== 'object') return null;
      const v = row as Record<string, unknown>;
      const id = String(v.id || '');
      const storagePath = String(v.storagePath || '');
      if (!id || !storagePath) return null;
      const url = String(v.videoUrl || v.url || '');
      return {
        id,
        title: String(v.title || 'Tutorial').slice(0, 200),
        description: String(v.description || '').slice(0, 2000),
        url,
        sortOrder: 10000 + i,
        createdAt: String(v.createdAt || new Date().toISOString()),
        createdByEmail: v.createdByEmail ? String(v.createdByEmail) : undefined,
        kind: 'file' as const,
        storagePath,
        fileName: String(v.fileName || ''),
      } as PlatformTutorial;
    })
    .filter((v): v is PlatformTutorial => Boolean(v));
}

export function mergeTutorialLists(
  links: PlatformTutorial[],
  files: PlatformTutorial[]
): PlatformTutorial[] {
  return [...normalizeLinkTutorials(links), ...normalizeTutorialsList(files)];
}
