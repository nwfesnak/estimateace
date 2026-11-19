import type { CapacitorConfig } from '@capacitor/cli';

/**
 * EstimateAce native shell (App Store + Google Play).
 *
 * The app loads the live site (server.url) because estimates, billing, AI and webhooks
 * all run on the server. mobile/www is a tiny bundled fallback: offline.html shows when
 * the site can't be reached (no signal), with a Try again button.
 *
 * Navigation rule: only app.estimateace.com (and Supabase auth) stay inside the app.
 * Everything else — Stripe Checkout / customer pay links, the marketing site, Google
 * Maps, help links — opens in the system browser (Capacitor does this automatically for
 * hosts not listed in allowNavigation; lib/native-app.ts also routes window.open and
 * target=_blank links to the in-app Safari / Chrome Custom Tab).
 *
 * The "EstimateAceApp" user-agent token lets the website (client AND server) know it is
 * running inside the store app: purchase buttons/pricing are hidden (Apple 3.1.1 /
 * Google Play payments policy) and the Meta pixel is not loaded (no tracking = no ATT prompt).
 *
 * On the Mac: see docs/MOBILE_RELEASE.md.
 */
export const NATIVE_USER_AGENT_TOKEN = 'EstimateAceApp';

const config: CapacitorConfig = {
  appId: 'com.estimateace.app',
  appName: 'EstimateAce',
  webDir: 'mobile/www',
  appendUserAgent: `${NATIVE_USER_AGENT_TOKEN}/1.0`,
  backgroundColor: '#ffffff',
  server: {
    url: 'https://app.estimateace.com',
    cleartext: false,
    errorPath: 'offline.html',
    allowNavigation: [
      'app.estimateace.com',
      // Supabase auth (email confirm / password reset redirects pass through here)
      '*.supabase.co',
      // Cloudflare Turnstile bot check (iframe on login / signup / forgot password)
      'challenges.cloudflare.com',
    ],
  },
  ios: {
    // Web content handles safe areas itself (html.native-app padding in globals.css).
    contentInset: 'never',
    backgroundColor: '#ffffff',
    preferredContentMode: 'mobile',
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    backgroundColor: '#ffffff',
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      launchFadeOutDuration: 250,
      backgroundColor: '#ffffff',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: false,
      splashImmersive: false,
    },
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#ffffff',
      overlaysWebView: false,
    },
    SystemBars: {
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
      style: 'LIGHT',
    },
  },
};

export default config;
