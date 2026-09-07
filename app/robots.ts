import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/trial', '/terms', '/privacy', '/sms', '/login', '/signup', '/pricing'],
      // /welcome is an unlisted signup video link — not for search engines
      disallow: ['/api/', '/client/', '/welcome'],
    },
  };
}
