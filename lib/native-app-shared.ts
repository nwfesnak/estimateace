/** Pure helpers shared by the browser, the server and tests (no Capacitor / React imports). */

/** Appended to the WebView user agent by capacitor.config.ts (appendUserAgent). */
export const NATIVE_UA_TOKEN = 'EstimateAceApp';

/** Hosts that stay inside the app WebView; everything else opens in the system browser. */
export const IN_APP_HOSTS = ['app.estimateace.com', 'localhost'];

/** Shown wherever a purchase button / price would be on the web. */
export const NATIVE_MANAGE_PLAN_TEXT =
  'Plans, add-ons and crew seats are managed in your EstimateAce account on the web at estimateace.com.';

export const NATIVE_SIGNUP_TEXT =
  'New to EstimateAce? Create your account on the web at estimateace.com, then log in here.';

export function isNativeUserAgent(ua: string | null | undefined): boolean {
  return new RegExp(`\\b${NATIVE_UA_TOKEN}\\b`).test(String(ua || ''));
}

/**
 * Should this link leave the app? http(s) URLs on another host do; same-app links,
 * relative links, mailto:/tel:/sms: (handled by the OS already) and javascript: don't.
 */
export function shouldOpenExternally(href: string, baseUrl = 'https://app.estimateace.com/'): boolean {
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  return !IN_APP_HOSTS.includes(url.hostname.toLowerCase());
}
