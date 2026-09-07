import { NextRequest, NextResponse } from 'next/server';
import {
  isGooglePlacesConfigured,
  probeAddressAutocomplete,
} from '@/lib/address-autocomplete';

export const dynamic = 'force-dynamic';

/**
 * Lightweight runtime health check.
 * Detailed probes require Authorization: Bearer $CRON_SECRET (or non-production).
 */
export async function GET(request: NextRequest) {
  const probe = request.nextUrl.searchParams.get('probe');
  const cronSecret = (process.env.CRON_SECRET || '').trim();
  const authHeader = request.headers.get('authorization');
  const detailedAllowed =
    process.env.NODE_ENV !== 'production' ||
    (Boolean(cronSecret) && authHeader === `Bearer ${cronSecret}`);

  if (probe === 'address') {
    if (!detailedAllowed) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const addressProbe = await probeAddressAutocomplete();
    return NextResponse.json({
      ok: addressProbe.combinedCount > 0,
      service: 'estimateace',
      timestamp: new Date().toISOString(),
      addressProbe,
    });
  }

  if (!detailedAllowed) {
    return NextResponse.json({
      ok: true,
      service: 'estimateace',
      timestamp: new Date().toISOString(),
    });
  }

  return NextResponse.json({
    ok: true,
    service: 'estimateace',
    timestamp: new Date().toISOString(),
    runtime: {
      node: process.version,
    },
    addressAutocomplete: {
      googlePlacesConfigured: isGooglePlacesConfigured(),
      fallbackProviders: ['nominatim', 'census', 'photon'],
    },
  });
}
