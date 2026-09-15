/**
 * Lightweight website text scan for receptionist Q&A.
 * Short timeout budget so Twilio /think stays within limits.
 */

const MAX_TEXT_CHARS = 7500;
const FETCH_TIMEOUT_MS = 3500;
const PER_PAGE_TIMEOUT_MS = 2000;

/** Process-local cache: url → scraped text */
const websiteTextCache = new Map<string, { text: string; at: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

const FAQ_PATH_HINTS = ['/faq', '/faqs', '/about', '/services', '/service', '/pricing'];

function normalizeUrl(raw: string): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const u = new URL(withProto);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  let t = String(html || '');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<\/(p|div|br|li|h[1-6]|tr|section|article)>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

function sameOrigin(base: URL, href: string): string | null {
  try {
    const abs = new URL(href, base);
    if (abs.origin !== base.origin) return null;
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
    return abs.toString();
  } catch {
    return null;
  }
}

function extractSameOriginLinks(html: string, baseUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const found: string[] = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const abs = sameOrigin(base, m[1]);
    if (!abs) continue;
    const path = new URL(abs).pathname.toLowerCase();
    if (FAQ_PATH_HINTS.some((h) => path === h || path.startsWith(`${h}/`))) {
      found.push(abs);
    }
  }
  // Prefer unique, max 2 extras
  return [...new Set(found)].slice(0, 2);
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'EstimateAceReceptionistBot/1.0',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return '';
  const ctype = String(res.headers.get('content-type') || '');
  if (ctype && !/text\/html|application\/xhtml|text\/plain/i.test(ctype)) {
    return '';
  }
  const html = await res.text();
  return stripHtml(html);
}

/**
 * Fetch website (+ up to 2 FAQ/about/services pages) → plain text.
 * Soft-fails to empty string. Caches per normalized URL in-process.
 */
export async function fetchWebsiteKnowledgeText(
  websiteUrl: string,
  opts?: { force?: boolean; budgetMs?: number }
): Promise<string> {
  const url = normalizeUrl(websiteUrl);
  if (!url) return '';

  const cached = websiteTextCache.get(url);
  if (!opts?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.text;
  }

  const budget = opts?.budgetMs ?? FETCH_TIMEOUT_MS;
  const started = Date.now();
  const parts: string[] = [];

  try {
    const remaining = () => Math.max(400, budget - (Date.now() - started));
    const mainHtmlRes = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'EstimateAceReceptionistBot/1.0',
      },
      signal: AbortSignal.timeout(Math.min(PER_PAGE_TIMEOUT_MS, remaining())),
    });
    if (mainHtmlRes.ok) {
      const html = await mainHtmlRes.text();
      const mainText = stripHtml(html);
      if (mainText) parts.push(mainText);
      const extras = extractSameOriginLinks(html, url);
      for (const extra of extras) {
        if (Date.now() - started > budget - 300) break;
        try {
          const t = await fetchText(extra, Math.min(PER_PAGE_TIMEOUT_MS, remaining()));
          if (t) parts.push(t);
        } catch {
          /* soft fail per page */
        }
      }
    }
  } catch {
    /* soft fail */
  }

  const text = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT_CHARS);
  websiteTextCache.set(url, { text, at: Date.now() });
  return text;
}

/** Expose cache write for session-stashed text reuse across instances (optional). */
export function warmWebsiteTextCache(websiteUrl: string, text: string): void {
  const url = normalizeUrl(websiteUrl);
  if (!url || !text) return;
  websiteTextCache.set(url, { text: String(text).slice(0, MAX_TEXT_CHARS), at: Date.now() });
}
