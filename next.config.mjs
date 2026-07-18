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
      }
    ],
  },

  async headers() {
    // Strong security headers + Content Security Policy (tightened for production)
    const cspHeader = `
      default-src 'self';
      script-src 'self' 'unsafe-eval' 'unsafe-inline' https://*.supabase.co https://www.paypal.com https://www.sandbox.paypal.com;
      style-src 'self' 'unsafe-inline' https://www.paypal.com https://www.sandbox.paypal.com;
      img-src 'self' blob: data: https://*.supabase.co https://*.supabase.in https://www.paypal.com https://www.sandbox.paypal.com https://*.paypalobjects.com;
      font-src 'self' data:;
      connect-src 'self' https://*.supabase.co https://*.supabase.in https://libretranslate.com https://api.x.ai wss://*.supabase.co https://www.paypal.com https://www.sandbox.paypal.com https://*.paypal.com;
      media-src 'self' blob: https://*.supabase.co;
      object-src 'none';
      frame-src 'self' https://www.paypal.com https://www.sandbox.paypal.com https://*.paypal.com;
      frame-ancestors 'none';
      base-uri 'self';
      form-action 'self' https://www.paypal.com https://www.sandbox.paypal.com;
      worker-src 'self' blob:;
      upgrade-insecure-requests;
    `.replace(/\s{2,}/g, ' ').trim();

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
            value: "camera=(self), microphone=(self), geolocation=()",
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