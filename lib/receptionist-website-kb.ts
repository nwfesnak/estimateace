/**
 * Lightweight website text scan for receptionist Q&A.
 * Short timeout budget so Twilio /think stays within limits.
 * A setup import can pass a longer budgetMs and guardRedirects.
 */

import { lookup } from 'dns/promises';

const MAX_TEXT_CHARS = 7500;
const FETCH_TIMEOUT_MS = 3500;
const PER_PAGE_TIMEOUT_MS = 2000;

/** Process-local cache: url → scraped text */
const websiteTextCache = new Map<string, { text: string; at: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

const FAQ_PATH_HINTS = [
  '/faq',
  '/faqs',
  '/about',
  '/services',
  '/service',
  '/pricing',
  '/contact',
  '/service-area',
];

/** Hosts and IPs that must never be fetched from a user-entered website. */
export function isBlockedWebsiteHost(hostname: string): boolean {
  let h = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.startsWith('::ffff:')) h = h.slice('::ffff:'.length);
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  ) {
    return true;
  }
  if (h.includes(':')) {
    if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) {
      return true;
    }
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const n = m.slice(1).map(Number);
  if (n.some((x) => x > 255)) return true;
  const [a, b] = n;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function normalizeUrl(raw: string): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const u = new URL(withProto);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    if (u.port && u.port !== '80' && u.port !== '443') return null;
    if (isBlockedWebsiteHost(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Normalize a public http(s) URL and confirm DNS does not point at a private address. */
export async function resolvePublicWebsiteUrl(raw: string): Promise<string | null> {
  const url = normalizeUrl(raw);
  if (!url) return null;
  const hostname = new URL(url).hostname;
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    if (!records.length) return null;
    if (records.some((r) => isBlockedWebsiteHost(r.address))) return null;
  } catch {
    return null;
  }
  return url;
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

type PageFetch = { html: string; finalUrl: string };

async function readPage(
  url: string,
  timeoutMs: number,
  guardRedirects: boolean
): Promise<PageFetch | null> {
  let current = url;
  const hops = guardRedirects ? 4 : 1;
  for (let hop = 0; hop < hops; hop++) {
    if (guardRedirects) {
      const pub = await resolvePublicWebsiteUrl(current);
      if (!pub) return null;
      current = pub;
    }
    const res = await fetch(current, {
      method: 'GET',
      redirect: guardRedirects ? 'manual' : 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'EstimateAceReceptionistBot/1.0',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (guardRedirects && res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return null;
      try {
        current = new URL(loc, current).toString();
      } catch {
        return null;
      }
      continue;
    }
    if (!res.ok) return null;
    const ctype = String(res.headers.get('content-type') || '');
    if (ctype && !/text\/html|application\/xhtml|text\/plain/i.test(ctype)) return null;
    const html = await res.text();
    return { html, finalUrl: current };
  }
  return null;
}

/**
 * Fetch website (+ up to 2 FAQ/about/services pages) → plain text.
 * Soft-fails to empty string. Caches per normalized URL in-process.
 */
export async function fetchWebsiteKnowledgeText(
  websiteUrl: string,
  opts?: { force?: boolean; budgetMs?: number; maxChars?: number; guardRedirects?: boolean }
): Promise<string> {
  const url = normalizeUrl(websiteUrl);
  if (!url) return '';

  const cached = websiteTextCache.get(url);
  if (!opts?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.text;
  }

  const budget = opts?.budgetMs ?? FETCH_TIMEOUT_MS;
  const maxChars = Math.min(20000, Math.max(1000, opts?.maxChars ?? MAX_TEXT_CHARS));
  const perPageLimit = opts?.budgetMs
    ? Math.min(8000, Math.max(PER_PAGE_TIMEOUT_MS, Math.floor(opts.budgetMs / 3)))
    : PER_PAGE_TIMEOUT_MS;
  const guardRedirects = opts?.guardRedirects === true;
  const started = Date.now();
  const parts: string[] = [];

  try {
    const remaining = () => Math.max(400, budget - (Date.now() - started));
    const main = await readPage(url, Math.min(perPageLimit, remaining()), guardRedirects);
    if (main?.html) {
      const mainText = stripHtml(main.html);
      if (mainText) parts.push(mainText);
      const extras = extractSameOriginLinks(main.html, main.finalUrl);
      for (const extra of extras) {
        if (Date.now() - started > budget - 300) break;
        if (!normalizeUrl(extra)) continue;
        try {
          const page = await readPage(extra, Math.min(perPageLimit, remaining()), guardRedirects);
          const t = page?.html ? stripHtml(page.html) : '';
          if (t) parts.push(t);
        } catch {
          /* soft fail per page */
        }
      }
    }
  } catch {
    /* soft fail */
  }

  const text = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
  websiteTextCache.set(url, { text, at: Date.now() });
  return text;
}

/** Expose cache write for session-stashed text reuse across instances (optional). */
export function warmWebsiteTextCache(websiteUrl: string, text: string): void {
  const url = normalizeUrl(websiteUrl);
  if (!url || !text) return;
  websiteTextCache.set(url, { text: String(text).slice(0, MAX_TEXT_CHARS), at: Date.now() });
}
