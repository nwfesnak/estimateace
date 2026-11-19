'use client';

import * as React from 'react';
import { isNativeApp, nativePlatform, openExternalUrl, shouldOpenExternally } from '@/lib/native-app';

/**
 * Only does anything inside the EstimateAce iOS / Android app; renders nothing and
 * changes nothing on the website.
 *  - tags <html> with `native-app` (+ `native-ios` / `native-android`) for safe-area CSS
 *  - hides the launch splash, sets the status bar style
 *  - opens links that leave app.estimateace.com (Stripe, maps, marketing site, help) and
 *    any target=_blank / window.open in the system browser instead of the app WebView
 *  - Android hardware back button: go back in history, or leave the app at the root
 */
export function NativeAppBridge() {
  React.useEffect(() => {
    if (!isNativeApp()) return;
    const platform = nativePlatform();
    const root = document.documentElement;
    root.classList.add('native-app', `native-${platform}`);

    let cancelled = false;
    const cleanups: Array<() => void> = [];

    void (async () => {
      try {
        const { SplashScreen } = await import('@capacitor/splash-screen');
        if (!cancelled) await SplashScreen.hide();
      } catch {
        /* plugin not in this build */
      }
      try {
        const { StatusBar, Style } = await import('@capacitor/status-bar');
        if (!cancelled) {
          await StatusBar.setStyle({ style: Style.Light });
          if (platform === 'android') await StatusBar.setBackgroundColor({ color: '#ffffff' });
        }
      } catch {
        /* ignore */
      }
      try {
        const { App } = await import('@capacitor/app');
        const handle = await App.addListener('backButton', ({ canGoBack }) => {
          if (canGoBack) window.history.back();
          else void App.exitApp();
        });
        if (cancelled) void handle.remove();
        else cleanups.push(() => void handle.remove());
      } catch {
        /* ignore */
      }
    })();

    // Links: anything off-app or target=_blank → system browser.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      if (!href || href.startsWith('#')) return;
      const external = shouldOpenExternally(href, window.location.href);
      const newTab = anchor.target === '_blank' && /^https?:/i.test(anchor.href);
      if (!external && !newTab) return;
      event.preventDefault();
      void openExternalUrl(anchor.href);
    };
    document.addEventListener('click', onClick, true);
    cleanups.push(() => document.removeEventListener('click', onClick, true));

    // window.open(url, '_blank') (pay links, terms links, Stripe) → system browser.
    const originalOpen = window.open;
    window.open = function nativeOpen(url?: string | URL, target?: string, features?: string) {
      const href = url ? String(url) : '';
      if (href && /^(https?:|\/)/i.test(href)) {
        void openExternalUrl(href);
        return null;
      }
      return originalOpen.call(window, url, target, features);
    } as typeof window.open;
    cleanups.push(() => {
      window.open = originalOpen;
    });

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    };
  }, []);

  return null;
}
