/**
 * Unlisted signup welcome video — shared via https://app.estimateace.com/welcome
 */

export type WelcomeVideoConfig = {
  title: string;
  description: string;
  /** Original URL (YouTube, Loom, Vimeo, or direct .mp4) */
  videoUrl: string;
  updatedAt?: string;
};

export function normalizeWelcomeVideo(raw: unknown): WelcomeVideoConfig {
  const o = raw && typeof raw === 'object' ? (raw as any) : {};
  return {
    title: String(o.title || 'Welcome to EstimateAce').slice(0, 200),
    description: String(
      o.description ||
        'A quick walkthrough of EstimateAce — estimates, AI quoting, invoices, and getting paid.'
    ).slice(0, 4000),
    videoUrl: String(o.videoUrl || o.url || '').trim(),
    updatedAt: o.updatedAt ? String(o.updatedAt) : undefined,
  };
}

export type WelcomeEmbed =
  | { kind: 'iframe'; src: string }
  | { kind: 'video'; src: string }
  | { kind: 'none' };

/** Turn common share links into an embeddable player URL. */
export function resolveWelcomeEmbed(rawUrl: string): WelcomeEmbed {
  const url = String(rawUrl || '').trim();
  if (!url) return { kind: 'none' };

  // Direct media file
  if (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url) || url.includes('/storage/v1/object/')) {
    return { kind: 'video', src: url };
  }

  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();

    // YouTube
    if (host === 'youtu.be') {
      const id = u.pathname.replace(/^\//, '').split('/')[0];
      if (id) return { kind: 'iframe', src: `https://www.youtube-nocookie.com/embed/${id}?rel=0` };
    }
    if (host.includes('youtube.com')) {
      const id = u.searchParams.get('v') || u.pathname.split('/embed/')[1]?.split('/')[0];
      if (id) return { kind: 'iframe', src: `https://www.youtube-nocookie.com/embed/${id}?rel=0` };
    }

    // Vimeo
    if (host.includes('vimeo.com')) {
      const id = u.pathname.split('/').filter(Boolean).pop();
      if (id && /^\d+$/.test(id)) {
        return { kind: 'iframe', src: `https://player.vimeo.com/video/${id}` };
      }
    }

    // Loom
    if (host.includes('loom.com')) {
      const share = u.pathname.match(/\/share\/([a-zA-Z0-9]+)/);
      const embed = u.pathname.match(/\/embed\/([a-zA-Z0-9]+)/);
      const id = share?.[1] || embed?.[1];
      if (id) return { kind: 'iframe', src: `https://www.loom.com/embed/${id}` };
    }
  } catch {
    /* fall through */
  }

  // Unknown https URL — try as video source
  if (/^https?:\/\//i.test(url)) {
    return { kind: 'video', src: url };
  }

  return { kind: 'none' };
}
