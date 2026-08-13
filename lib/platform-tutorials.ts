/**
 * Platform-wide help video tutorials (managed by EstimateAce owner).
 * Catalog stored in estimates row PLATFORM-TUTORIALS; files in media/platform-tutorials/.
 */

export const PLATFORM_TUTORIALS_ROW_ID = 'PLATFORM-TUTORIALS';

export type PlatformTutorial = {
  id: string;
  title: string;
  description: string;
  storagePath: string;
  fileName: string;
  createdAt: string;
  createdByEmail?: string;
};

/** Comma-separated admin emails (server or NEXT_PUBLIC for UI). */
export function getPlatformAdminEmails(): string[] {
  const raw =
    process.env.PLATFORM_ADMIN_EMAILS ||
    process.env.ESTIMATEACE_ADMIN_EMAILS ||
    process.env.NEXT_PUBLIC_PLATFORM_ADMIN_EMAILS ||
    '';
  return String(raw)
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isPlatformAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const admins = getPlatformAdminEmails();
  if (admins.length === 0) return false;
  return admins.includes(String(email).trim().toLowerCase());
}

export function normalizeTutorialsList(raw: unknown): PlatformTutorial[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v: any) => ({
      id: String(v?.id || ''),
      title: String(v?.title || 'Tutorial').slice(0, 200),
      description: String(v?.description || '').slice(0, 2000),
      storagePath: String(v?.storagePath || ''),
      fileName: String(v?.fileName || ''),
      createdAt: String(v?.createdAt || new Date().toISOString()),
      createdByEmail: v?.createdByEmail ? String(v.createdByEmail) : undefined,
    }))
    .filter((v) => v.id && v.storagePath);
}
