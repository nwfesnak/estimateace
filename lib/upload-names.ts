/** Unguessable, storage-safe pieces for media upload paths. */
export function randomUploadId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  if (c?.getRandomValues) {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** Keep a readable, safe file name (letters, digits, . _ -), max 80 chars. */
export function safeUploadName(name: string): string {
  const cleaned = String(name || 'file')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._]+/, '');
  return (cleaned || 'file').slice(-80);
}
