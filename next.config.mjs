/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
      },
      {
        protocol: 'https',
        hostname: '*.supabase.in',
      },
    ],
  },

  async headers() {
    const appOrigin = (process.env.NEXT_PUBLIC_APP_URL || 'https://app.estimateace.com')
      .trim()
      .replace(/\/$/, '');

    // Tighten CSP: drop unsafe-eval (major XSS amplifier). Keep unsafe-inline for Next.js
    // inline bootstrapping until nonce-based CSP is added.
    const cspHeader = `
      default-src 'self';
      script-src 'self' 'unsafe-inline' https://*.supabase.co https://js.stripe.com;
      style-src 'self' 'unsafe-inline';
      img-src 'self' blob: data: https://*.supabase.co https://*.supabase.in https://*.stripe.com;
      font-src 'self';
      connect-src 'self' https://*.supabase.co https://*.supabase.in https://libretranslate.com https://api.x.ai https://api.stripe.com https://*.stripe.com wss://*.supabase.co;
      media-src 'self' blob: https://*.supabase.co;
      object-src 'none';
      frame-src https://js.stripe.com https://hooks.stripe.com;
      frame-ancestors 'none';
      base-uri 'self';
      form-action 'self' https://checkout.stripe.com;
      worker-src 'self' blob:;
      upgrade-insecure-requests;
    `
      .replace(/\s{2,}/g, ' ')
      .trim();

    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: cspHeader,
          },
          {
            // Lock CORS to the app origin (replaces any wide-open * from platform defaults)
            key: 'Access-Control-Allow-Origin',
            value: appOrigin,
          },
          {
            key: 'Vary',
            value: 'Origin',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(self), geolocation=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
