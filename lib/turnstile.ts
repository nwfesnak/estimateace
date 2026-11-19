/**
 * Cloudflare Turnstile (bot check) for the public auth forms: trial signup, login
 * and "forgot password".
 *
 * Verification is done by Supabase Auth ("Bot and Abuse Protection" → CAPTCHA →
 * Turnstile, with the Turnstile SECRET key set in the Supabase dashboard). The app only
 * renders the widget and passes its token as `options.captchaToken` on
 * signUp / signInWithPassword / resetPasswordForEmail.
 *
 * OFF unless NEXT_PUBLIC_TURNSTILE_SITE_KEY is set (no widget, no token sent).
 * Order matters: set the site key in Vercel and redeploy BEFORE turning CAPTCHA on in
 * Supabase, otherwise Supabase rejects logins that arrive without a token.
 */
export const TURNSTILE_SITE_KEY = (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '').trim();

export const turnstileEnabled = TURNSTILE_SITE_KEY.length > 0;

export const TURNSTILE_SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export const TURNSTILE_REQUIRED_MESSAGE =
  'Please complete the security check (the box above the button), then try again.';

/** Options fragment for Supabase auth calls: empty when Turnstile is off. */
export function captchaOption(token: string | null | undefined): { captchaToken?: string } {
  return turnstileEnabled && token ? { captchaToken: token } : {};
}

/** Friendlier text for Supabase's CAPTCHA errors (expired / missing / failed token). */
export function friendlyCaptchaError(message: string | undefined | null): string | null {
  if (!message) return null;
  if (/captcha/i.test(message)) {
    return 'The security check expired or failed. Please complete it again and retry.';
  }
  return null;
}
