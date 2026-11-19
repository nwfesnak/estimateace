import { NextRequest, NextResponse } from 'next/server';
import {
  fetchAddressSuggestions,
  fetchGooglePlaceDetails,
  isGooglePlacesConfigured,
} from '@/lib/address-autocomplete';
import { clientIp, rateLimit, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/** Shared (all instances) limits: this proxies paid Google Places + public geocoders. */
const PER_IP_PER_MINUTE = 30;
const PER_IP_PER_DAY = 1000;
const GLOBAL_PER_DAY = () =>
  Number.parseInt(String(process.env.ADDRESS_AUTOCOMPLETE_DAILY_LIMIT_GLOBAL || ''), 10) || 20000;

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

  if (q.length > 200 || city.length > 100 || state.length > 50 || zip.length > 20 || String(placeId || '').length > 300) {
    return NextResponse.json({ error: 'Query too long' }, { status: 400 });
  }
  if (!placeId && (!q || q.length < 2)) return NextResponse.json([]);

  const ip = clientIp(request);
  const perMinute = await rateLimit(`addr:min:${ip}`, 60, PER_IP_PER_MINUTE);
  if (!perMinute.allowed) return tooManyRequests(perMinute, 'Rate limit exceeded');
  const perDay = await rateLimit(`addr:day:${ip}`, 24 * 60 * 60, PER_IP_PER_DAY);
  if (!perDay.allowed) return tooManyRequests(perDay, 'Daily address lookup limit reached');
  const global = await rateLimit('addr:global', 24 * 60 * 60, GLOBAL_PER_DAY());
  if (!global.allowed) return tooManyRequests(global, 'Address lookup is busy. Try again later.');

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