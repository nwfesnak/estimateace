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

  async redirects() {
    return [
      { source: '/login', destination: '/', permanent: false },
      { source: '/signup', destination: '/trial', permanent: false },
      { source: '/register', destination: '/trial', permanent: false },
      { source: '/pricing', destination: '/trial', permanent: false },
    ];
  },

  async headers() {
    // Tighten CSP: drop unsafe-eval (major XSS amplifier). Keep unsafe-inline for Next.js
    // inline bootstrapping until nonce-based CSP is added.
    // Note: do NOT set Access-Control-Allow-Origin globally — public marketing APIs
    // set CORS per-route (e.g. /api/marketing/chat for estimateace.com).
    const cspHeader = `
      default-src 'self';
      script-src 'self' 'unsafe-inline' https://*.supabase.co https://js.stripe.com;
      style-src 'self' 'unsafe-inline';
      img-src 'self' blob: data: https://*.supabase.co https://*.supabase.in https://*.stripe.com;
      font-src 'self';
      connect-src 'self' https://*.supabase.co https://*.supabase.in https://libretranslate.com https://api.x.ai https://api.stripe.com https://*.stripe.com wss://*.supabase.co;
      media-src 'self' blob: https://*.supabase.co https://*.supabase.in;
      object-src 'none';
      frame-src https://js.stripe.com https://hooks.stripe.com https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://www.loom.com;
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
