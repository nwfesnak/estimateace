/**
 * Helpers for the EstimateAce App Store / Google Play app (Capacitor shell that loads
 * https://app.estimateace.com — see capacitor.config.ts).
 *
 * Inside the store app:
 *  - No in-app purchase UI: plan / add-on / crew-seat checkout buttons and prices are
 *    hidden (Apple guidelines 3.1.1 / 3.1.3(f) "free companion app to a paid web tool",
 *    Google Play payments policy). People manage their
 *    plan at estimateace.com in a browser. Customer (client) payment links for real-world
 *    jobs are NOT affected — those are physical services and are allowed.
 *  - Links that leave app.estimateace.com open in the system browser.
 *  - The Meta pixel is not loaded (no cross-app tracking → no ATT prompt needed).
 *
 * On the regular website every helper here returns "not native", so web behaviour is
 * unchanged.
 */
import { Capacitor } from '@capacitor/core';
import { useSyncExternalStore } from 'react';
import { isNativeUserAgent } from '@/lib/native-app-shared';

export {
  NATIVE_UA_TOKEN,
  IN_APP_HOSTS,
  NATIVE_MANAGE_PLAN_TEXT,
  NATIVE_SIGNUP_TEXT,
  isNativeUserAgent,
  shouldOpenExternally,
} from '@/lib/native-app-shared';

/** True inside the iOS / Android app (Capacitor bridge or our user-agent token). */
export function isNativeApp(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (Capacitor.isNativePlatform()) return true;
  } catch {
    /* bridge not injected */
  }
  return isNativeUserAgent(window.navigator?.userAgent);
}

export function nativePlatform(): 'ios' | 'android' | 'web' {
  if (!isNativeApp()) return 'web';
  try {
    const p = Capacitor.getPlatform();
    if (p === 'ios' || p === 'android') return p;
  } catch {
    /* ignore */
  }
  return /android/i.test(window.navigator.userAgent) ? 'android' : 'ios';
}

const noopSubscribe = () => () => {};

/** React hook: false during SSR / on the web, true inside the store app. */
export function useIsNativeApp(): boolean {
  return useSyncExternalStore(noopSubscribe, isNativeApp, () => false);
}

/**
 * Open a URL outside the app WebView (Safari View Controller / Chrome Custom Tab).
 * On the web this is a normal new tab.
 */
export async function openExternalUrl(href: string): Promise<void> {
  if (typeof window === 'undefined') return;
  const absolute = new URL(href, window.location.href).toString();
  if (isNativeApp()) {
    let bridge = false;
    try {
      bridge = Capacitor.isNativePlatform();
    } catch {
      bridge = false;
    }
    if (bridge) {
      try {
        const { Browser } = await import('@capacitor/browser');
        await Browser.open({ url: absolute, presentationStyle: 'popover' });
        return;
      } catch {
        /* plugin missing in an old build: fall through */
      }
    }
    // Top-level navigation to a host outside allowNavigation: Capacitor hands it to the
    // system browser. (Never call window.open here — NativeAppBridge overrides it.)
    window.location.href = absolute;
    return;
  }
  window.open(absolute, '_blank', 'noopener,noreferrer');
}
