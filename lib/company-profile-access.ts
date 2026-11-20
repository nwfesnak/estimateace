/**
 * Company Profile (SETTINGS-<ownerId> on public.estimates) is owner-only.
 * Crew may still render the owner's company name and logo on jobs/documents
 * and see a "Crew member of {company}" label, but they must not open or
 * write the Company Profile page.
 */

export const CREW_COMPANY_PROFILE_WRITE_DENIED =
  'Only the account owner can change the company profile.';

export const CREW_COMPANY_PROFILE_RESTRICTED =
  'Only the account owner can view and edit the company profile.';

/** Reserved workspace rows that crew must never write. */
export const RESERVED_DOCUMENT_ID = /^(SETTINGS-|RECEPTIONIST-SECRETS-|PLATFORM-)/i;

export function isReservedDocumentId(id: unknown): boolean {
  return RESERVED_DOCUMENT_ID.test(String(id || '').trim());
}

export function isCompanySettingsId(id: unknown, ownerUserId?: unknown): boolean {
  const raw = String(id || '').trim();
  if (!raw.startsWith('SETTINGS-')) return false;
  if (ownerUserId == null || ownerUserId === '') return true;
  return raw === `SETTINGS-${ownerUserId}`;
}
