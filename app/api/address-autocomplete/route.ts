import { NextRequest, NextResponse } from 'next/server';
import {
  fetchAddressSuggestions,
  fetchGooglePlaceDetails,
  isGooglePlacesConfigured,
} from '@/lib/address-autocomplete';

export const dynamic = 'force-dynamic';

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 40;
const WINDOW_MS = 60 * 1000;

function checkRateLimit(identifier: string) {
  const now = Date.now();
  const entry = rateLimitMap.get(identifier);
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(identifier, { count: 1, resetTime: now + WINDOW_MS });
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetTime - now) / 1000) };
  }
  entry.count++;
  return { allowed: true };
}

/**
 * Address auto-suggest powered by Google Places (optional), OpenStreetMap Nominatim,
 * US Census geocoder, and Photon — ranked for best match.
 *
 * - ?q=query&city=&state=&zip= for autocomplete suggestions
 * - ?place_id=xxx for Google structured details (when GOOGLE_PLACES_API_KEY is set)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q')?.trim() || '';
  const city = searchParams.get('city')?.trim() || '';
  const state = searchParams.get('state')?.trim() || '';
  const zip = searchParams.get('zip')?.trim() || '';
  const placeId = searchParams.get('place_id');

  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  const rate = checkRateLimit(ip);
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  try {
    if (placeId) {
      const details = await fetchGooglePlaceDetails(placeId);
      return NextResponse.json(details);
    }

    if (!q || q.length < 2) return NextResponse.json([]);

    const suggestions = await fetchAddressSuggestions({ q, city, state, zip });
    return NextResponse.json(suggestions);
  } catch (error: unknown) {
    console.error('Address autocomplete error:', error);
    return NextResponse.json([]);
  }
}