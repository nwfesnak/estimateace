/**
 * Store-reviewer demo account (Apple App Review / Google Play app access).
 *
 * Only this allowlisted email may skip Cloudflare Turnstile, and only through
 * POST /api/auth/reviewer-login (server checks the email again). Everyone else
 * still completes the captcha via Supabase Auth.
 *
 * Override the email with REVIEWER_DEMO_EMAIL (comma-separated) if needed.
 * The default is the published reviewer login in docs/store-listing/review-notes.md.
 */
export const DEFAULT_REVIEWER_DEMO_EMAIL = 'appreview@estimateace.com';

export function reviewerDemoEmails(): string[] {
  const fromEnv = String(process.env.REVIEWER_DEMO_EMAIL || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : [DEFAULT_REVIEWER_DEMO_EMAIL];
}

export function isReviewerDemoEmail(email: string | null | undefined): boolean {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  return reviewerDemoEmails().includes(e);
}
