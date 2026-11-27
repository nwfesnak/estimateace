/**
 * Line item photos in the estimate / invoice email.
 *
 * Same mechanism as Site Photos in the email: the browser signs the storage paths
 * (long-lived signed URLs, createEmailMediaUrls) and sends https URLs; the server only
 * accepts https URLs and renders <img> thumbnails.
 * - `linePhotoUrls` (keyed by line id) always render under their own line.
 * - `siteLinePhotos` (captioned groups) join the "Site photos" block only when the Send
 *   "Site Photos" switch is on (the browser omits them otherwise; the server re-checks
 *   `includeSitePhotos`).
 */
import { LINE_PHOTO_LIMIT } from '@/lib/line-item-photos';

const MAX_LINES = 40;

function httpsUrls(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const u of raw) {
    const v = String(u || '').trim();
    if (!/^https:\/\//i.test(v) || out.includes(v)) continue;
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

export function sanitizeEmailLinePhotoUrls(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let n = 0;
  for (const [id, urls] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_LINES) break;
    const key = String(id).slice(0, 64);
    const list = httpsUrls(urls, LINE_PHOTO_LIMIT);
    if (key && list.length) {
      out[key] = list;
      n++;
    }
  }
  return out;
}

export type EmailSiteLinePhotoGroup = { caption: string; urls: string[] };

export function sanitizeEmailSiteLinePhotos(raw: unknown, includeSitePhotos: boolean): EmailSiteLinePhotoGroup[] {
  if (!includeSitePhotos || !Array.isArray(raw)) return [];
  const out: EmailSiteLinePhotoGroup[] = [];
  for (const g of raw.slice(0, MAX_LINES)) {
    if (!g || typeof g !== 'object') continue;
    const caption = String((g as { caption?: unknown }).caption || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const urls = httpsUrls((g as { urls?: unknown }).urls, LINE_PHOTO_LIMIT);
    if (urls.length) out.push({ caption: caption || 'Line photos', urls });
  }
  return out;
}

type Esc = (s: string) => string;

/** Thumbnails under one line's description in the email table. */
export function emailLinePhotoThumbsHtml(urls: string[] | undefined, esc: Esc): string {
  const list = (urls || []).slice(0, LINE_PHOTO_LIMIT);
  if (!list.length) return '';
  const imgs = list
    .map(
      (url) =>
        `<img src="${esc(url)}" alt="Line photo" width="64" height="64" style="object-fit:cover;border-radius:6px;border:1px solid #e2e8f0;width:64px;height:64px;margin:4px 4px 0 0;" />`
    )
    .join('');
  return `<div style="margin-top:4px;">${imgs}</div>`;
}

function siteThumb(url: string, esc: Esc, alt: string) {
  return `<img src="${esc(url)}" alt="${esc(alt)}" width="96" height="96" style="object-fit:cover;border-radius:8px;border:1px solid #e2e8f0;width:96px;height:96px;margin:3px;" />`;
}

/** The email "Site photos" block: site photos, then captioned line photo groups. '' when empty. */
export function emailSitePhotosBlockHtml(
  sitePhotoUrls: string[],
  siteLinePhotos: EmailSiteLinePhotoGroup[],
  esc: Esc
): string {
  if (!sitePhotoUrls.length && !siteLinePhotos.length) return '';
  const site = sitePhotoUrls.map((u) => siteThumb(u, esc, 'Site photo')).join('');
  const groups = siteLinePhotos
    .map(
      (g) =>
        `<p style="font-size:12px;color:#475569;margin:10px 0 2px;">${esc(g.caption)}</p>${g.urls
          .map((u) => siteThumb(u, esc, `${g.caption} photo`))
          .join('')}`
    )
    .join('');
  return `<div style="margin-top:20px;"><p style="font-size:13px;font-weight:600;margin:0 0 8px;">Site photos</p>${site}${groups}</div>`;
}
