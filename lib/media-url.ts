/** Extract a Supabase `media` bucket path from a storage path or legacy signed/public URL. */
export function extractMediaStoragePath(ref: string): string | null {
  if (!ref?.trim()) return null;
  const trimmed = ref.trim();
  if (!trimmed.startsWith('http')) return trimmed;

  const signMatch = trimmed.match(/\/object\/sign\/media\/(.+?)(?:\?|$)/);
  if (signMatch?.[1]) return decodeURIComponent(signMatch[1]);

  const publicMatch = trimmed.match(/\/object\/public\/media\/(.+?)(?:\?|$)/);
  if (publicMatch?.[1]) return decodeURIComponent(publicMatch[1]);

  return null;
}

export function isResolvableMediaRef(ref: string): boolean {
  if (!ref?.trim()) return false;
  if (!ref.startsWith('http')) return true;
  return extractMediaStoragePath(ref) !== null;
}

export function isMediaPdfRef(ref: string): boolean {
  return /\.pdf(?:\?|$)/i.test(ref || '');
}

export async function resolveMediaDisplayUrl(
  ref: string,
  createSignedUrl: (filePath: string) => Promise<string>
): Promise<string> {
  if (!ref?.trim()) return '';

  const storagePath = extractMediaStoragePath(ref);
  if (storagePath) {
    return (await createSignedUrl(storagePath)) || '';
  }

  return ref.startsWith('http') ? ref : '';
}