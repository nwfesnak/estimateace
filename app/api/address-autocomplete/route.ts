import { NextRequest, NextResponse } from 'next/server';
import {
  fetchAddressSuggestions,
  fetchGooglePlaceDetails,
} from '@/lib/address-autocomplete';
import { clientIp, rateLimit, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/** Shared (all instances) limits: this proxies paid Google Places + public geocoders. */
const PER_IP_PER_MINUTE = 30;
const PER_IP_PER_DAY = 1000;
const GLOBAL_PER_DAY = () =>
  Number.parseInt(String(process.env.ADDRESS_AUTOCOMPLETE_DAILY_LIMIT_GLOBAL || ''), 10) || 20000;

function parseCoord(raw: string | null, min: number, max: number): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return n;
}

/**
 * Address auto-suggest powered by Google Places (Places API (New) with legacy
 * Autocomplete fallback), plus public geocoders only when Google has no results.
 *
 * - ?q=&session_token=&lat=&lng=&bias_city=&bias_state=&bias_zip= for suggestions
 * - ?place_id=&session_token= for structured details (street, city, state, zip, unit)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q')?.trim() || '';
  const sessionToken = searchParams.get('session_token')?.trim() || '';
  const biasCity = searchParams.get('bias_city')?.trim() || '';
  const biasState = searchParams.get('bias_state')?.trim() || '';
  const biasZip = searchParams.get('bias_zip')?.trim() || '';
  const lat = parseCoord(searchParams.get('lat'), -90, 90);
  const lng = parseCoord(searchParams.get('lng'), -180, 180);
  const placeId = searchParams.get('place_id');

  if (
    q.length > 200 ||
    biasCity.length > 100 ||
    biasState.length > 50 ||
    biasZip.length > 20 ||
    sessionToken.length > 80 ||
    String(placeId || '').length > 300
  ) {
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
      const details = await fetchGooglePlaceDetails(String(placeId), sessionToken || undefined);
      return NextResponse.json(details);
    }

    const suggestions = await fetchAddressSuggestions({
      q,
      sessionToken: sessionToken || undefined,
      lat,
      lng,
      biasCity: biasCity || undefined,
      biasState: biasState || undefined,
      biasZip: biasZip || undefined,
    });
    return NextResponse.json(suggestions);
  } catch (error: unknown) {
    console.error('Address autocomplete error:', error);
    return NextResponse.json([]);
  }
}
