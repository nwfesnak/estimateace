import type { MetadataRoute } from 'next';
import { PWA_BACKGROUND_COLOR, PWA_THEME_COLOR } from '@/lib/pwa-icon';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'EstimateAce',
    short_name: 'EstimateAce',
    description:
      'Professional contractor estimates, invoices, calendar, and AI pricing.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: PWA_BACKGROUND_COLOR,
    theme_color: PWA_THEME_COLOR,
    categories: ['business', 'productivity', 'finance'],
    icons: [
      {
        src: '/icon',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/apple-icon',
        sizes: '180x180',
        type: 'image/png',
      },
    ],
  };
}