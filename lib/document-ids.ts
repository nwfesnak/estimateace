/**
 * Document numbers double as the `estimates.id` primary key, which is shared by every
 * account. Plain "EST-0001" collided between contractors, so new numbers carry a short
 * per-account code: EST-3F9A1C-0001 (INV-3F9A1C-0001 after conversion).
 *
 * Existing documents keep their old numbers/ids, so saved links keep working.
 * The EST ↔ INV twin logic (`^(EST|INV)-?(.+)$`) still pairs these numbers.
 */

export const DOC_ID_REFUSED_MESSAGE =
  'Save was refused: this document number belongs to another account (or your access changed). Start a new document to get a fresh number.';

/** 6-char uppercase code derived from the workspace (owner) user id. */
export function accountDocCode(workspaceUserId: string | null | undefined): string {
  const hex = String(workspaceUserId || '').replace(/[^0-9a-f]/gi, '');
  return hex.slice(0, 6).toUpperCase();
}

/** New document number, e.g. EST-3F9A1C-0007. Falls back to EST-0007 if no user id yet. */
export function newDocumentNumber(
  prefix: 'EST' | 'INV',
  sequence: number,
  workspaceUserId: string | null | undefined
): string {
  const n = String(Math.max(1, Math.floor(sequence) || 1)).padStart(4, '0');
  const code = accountDocCode(workspaceUserId);
  return code ? `${prefix}-${code}-${n}` : `${prefix}-${n}`;
}

/** True when Supabase refused a write because of row-level security / permissions. */
export function isRlsRefusal(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string; details?: string };
  if (e.code === '42501') return true;
  return /row-level security|permission denied/i.test(`${e.message || ''} ${e.details || ''}`);
}
