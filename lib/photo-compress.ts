/**
 * Client-side photo shrinking for the photo estimate.
 *
 * iPhone photos are 3–12 MB HEIC/JPEG. Vercel rejects request bodies over 4.5 MB before
 * the function runs, so every photo is decoded, resized to ≤1600 px on the long edge and
 * re-encoded as JPEG (~0.8) until the whole set fits a fixed character budget.
 * HEIC: iOS / macOS Safari (and the iOS app's WKWebView) decode HEIC natively; other
 * browsers can't, and get a clear message instead of a silent failure.
 */

export const PHOTO_UPLOAD_BUDGET = {
  /** Long edge in px for the first attempt (then 1280, 1024, 800). */
  maxEdges: [1600, 1280, 1024, 800] as const,
  qualities: [0.8, 0.7, 0.6, 0.5] as const,
  /** data: URL characters for all photos together (well under Vercel's 4.5 MB body cap). */
  totalChars: 3_200_000,
  /** Never more than this per photo, even when only one is attached. */
  perPhotoChars: 900_000,
} as const;

/** Per-photo character budget when `count` photos are attached. */
export function perPhotoBudget(count: number): number {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  return Math.min(PHOTO_UPLOAD_BUDGET.perPhotoChars, Math.floor(PHOTO_UPLOAD_BUDGET.totalChars / n));
}

/** Target size for an image whose long edge must not exceed `maxEdge` (never upscales). */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export function isHeicFile(file: { name?: string; type?: string }): boolean {
  const t = String(file.type || '').toLowerCase();
  const n = String(file.name || '').toLowerCase();
  return t.includes('heic') || t.includes('heif') || /\.(heic|heif)$/.test(n);
}

/** Image picker sometimes hands iOS photos over with an empty MIME type. */
export function looksLikeImageFile(file: { name?: string; type?: string }): boolean {
  const t = String(file.type || '').toLowerCase();
  if (t.startsWith('image/')) return true;
  if (t && t !== 'application/octet-stream') return false;
  return /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp|tiff?)$/i.test(String(file.name || '')) || !t;
}

type Drawable = { source: CanvasImageSource; width: number; height: number; close: () => void };

async function decode(file: File): Promise<Drawable> {
  // createImageBitmap applies EXIF orientation ("from-image") and is lighter on memory.
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* fall through to <img> (Safari decodes HEIC there) */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.decoding = 'async';
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('decode'));
      i.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(
      isHeicFile(file)
        ? 'This browser can’t read HEIC photos. Use the iPhone app or Safari, or export the photo as JPEG.'
        : 'Could not read that photo. Try a different one.'
    );
  }
}

/** Resize + JPEG-encode one photo so it fits `budgetChars` (data: URL length). */
export async function compressPhotoForUpload(file: File, budgetChars: number): Promise<string> {
  const img = await decode(file);
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not process that photo.');
    let last = '';
    for (const edge of PHOTO_UPLOAD_BUDGET.maxEdges) {
      const size = fitWithin(img.width, img.height, edge);
      canvas.width = size.width;
      canvas.height = size.height;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size.width, size.height);
      ctx.drawImage(img.source, 0, 0, size.width, size.height);
      for (const q of PHOTO_UPLOAD_BUDGET.qualities) {
        last = canvas.toDataURL('image/jpeg', q);
        if (!last.startsWith('data:image/jpeg')) throw new Error('Could not process that photo.');
        if (last.length <= budgetChars) return last;
      }
    }
    if (last && last.length <= PHOTO_UPLOAD_BUDGET.perPhotoChars) return last;
    throw new Error('That photo is too large to send. Try a different photo.');
  } finally {
    // Free the decoded bitmap / canvas memory right away (WKWebView is tight on memory).
    img.close();
  }
}
