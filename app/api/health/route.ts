import { NextRequest, NextResponse } from 'next/server';
import packageJson from '@/package.json';
import { getXaiRuntimeConfig } from '@/lib/xai-config';
import {
  isGooglePlacesConfigured,
  probeAddressAutocomplete,
} from '@/lib/address-autocomplete';

export const dynamic = 'force-dynamic';

/**
 * Lightweight runtime health check — confirms which model aliases and
 * dependency versions the deployed build is using.
 */
export async function GET(request: NextRequest) {
  const xai = getXaiRuntimeConfig();
  const probe = request.nextUrl.searchParams.get('probe');

  if (probe === 'address') {
    const addressProbe = await probeAddressAutocomplete();
    return NextResponse.json({
      ok: addressProbe.combinedCount > 0,
      service: 'estimateace',
      timestamp: new Date().toISOString(),
      addressProbe,
    });
  }

  return NextResponse.json({
    ok: true,
    service: 'estimateace',
    timestamp: new Date().toISOString(),
    runtime: {
      node: process.version,
    },
    xai: {
      chatModel: xai.chatModel,
      visionModel: xai.visionModel,
      apiKeyConfigured: xai.hasApiKey,
      modelPolicy: 'Uses xAI -latest aliases; override via GROK_MODEL / GROK_CHAT_MODEL / GROK_VISION_MODEL',
    },
    addressAutocomplete: {
      googlePlacesConfigured: isGooglePlacesConfigured(),
      fallbackProviders: ['nominatim', 'census', 'photon'],
      probeUrl: '/api/health?probe=address',
    },
    dependencies: {
      next: packageJson.dependencies?.next ?? 'unknown',
      react: packageJson.dependencies?.react ?? 'unknown',
      supabase: packageJson.dependencies?.['@supabase/supabase-js'] ?? 'unknown',
    },
  });
}