import type { CapacitorConfig } from '@capacitor/cli';

/**
 * App Store shell. The native app loads the live Next.js site because
 * estimates, billing, and webhooks run on the server.
 * Open ios/App/App.xcworkspace on a Mac to archive for TestFlight.
 */
const config: CapacitorConfig = {
  appId: 'com.estimateace.app',
  appName: 'EstimateAce',
  webDir: 'public',
  server: {
    url: 'https://app.estimateace.com',
    cleartext: false,
    allowNavigation: [
      'app.estimateace.com',
      '*.estimateace.com',
      '*.supabase.co',
      '*.supabase.in',
      'checkout.stripe.com',
      'js.stripe.com',
      'hooks.stripe.com',
      '*.stripe.com',
    ],
  },
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#10b981',
    preferredContentMode: 'mobile',
  },
};

export default config;
