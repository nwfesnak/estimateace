import { NextRequest, NextResponse } from 'next/server';

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;

// Simple rate limit
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 30;
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

async function fetchGoogleAutocomplete(q: string) {
  if (!GOOGLE_KEY) {
    throw new Error('Google Places API key not configured');
  }

  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(q)}&types=address&key=${GOOGLE_KEY}`;
  
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google autocomplete error: ${res.status}`);
  
  const data = await res.json();
  
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(data.error_message || data.status);
  }

  return (data.predictions || []).slice(0, 8).map((p: any) => ({
    address: p.structured_formatting?.main_text || p.description.split(',')[0],
    display: p.description,
    place_id: p.place_id,
  }));
}

async function fetchGooglePlaceDetails(placeId: string) {
  if (!GOOGLE_KEY) {
    throw new Error('Google Places API key not configured');
  }

  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=address_components,formatted_address&key=${GOOGLE_KEY}`;
  
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google details error: ${res.status}`);
  
  const data = await res.json();
  
  if (data.status !== 'OK') {
    throw new Error(data.error_message || data.status);
  }

  const components = data.result?.address_components || [];
  
  const getComponent = (type: string) => 
    components.find((c: any) => c.types.includes(type))?.long_name || '';

  const streetNumber = getComponent('street_number');
  const route = getComponent('route');
  const address = [streetNumber, route].filter(Boolean).join(' ').trim();

  const city = getComponent('locality') || 
               getComponent('sublocality') || 
               getComponent('administrative_area_level_2') || '';

  const state = getComponent('administrative_area_level_1') || '';
  const zipCode = getComponent('postal_code') || '';

  return {
    address: address || data.result?.formatted_address?.split(',')[0] || '',
    city: city,
    state: state,
    zipCode: zipCode,
    display: data.result?.formatted_address || '',
  };
}

// Fallback to free services if no Google key
async function fetchPhoton(q: string) {
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=en`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'EstimateAce/1.0' },
    next: { revalidate: 30 },
  });
  if (!res.ok) return [];
  const json = await res.json();
  const features = json.features || [];
  return features.map((f: any) => {
    const p = f.properties || {};
    let street = p.housenumber && p.street ? `${p.housenumber} ${p.street}`.trim() : (p.street || p.name || '');
    const city = (p.city || p.town || p.village || '').trim();
    const state = (p.state || '').trim();
    const zipCode = (p.postcode || '').trim();
    return { 
      address: street || (p.name || ''), 
      city, 
      state, 
      zipCode, 
      display: [street, city, state, zipCode].filter(Boolean).join(', ') 
    };
  }).filter((s: any) => s.address).slice(0, 8);
}

/**
 * Address Auto-suggest using Google Places API (primary)
 * Falls back to Photon (free OSM) if no Google key or error.
 * 
 * Requires GOOGLE_PLACES_API_KEY in environment (server-side only).
 * Enable "Places API" in Google Cloud Console + billing (free tier available).
 * 
 * Supports:
 * - ?q=query for autocomplete suggestions (returns place_id)
 * - ?place_id=xxx for structured details (address, city, state, zip)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q')?.trim() || '';
  const placeId = searchParams.get('place_id');

  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  const rate = checkRateLimit(ip);
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  try {
    if (placeId) {
      // Fetch structured details for a selected place
      if (GOOGLE_KEY) {
        const details = await fetchGooglePlaceDetails(placeId);
        return NextResponse.json(details);
      } else {
        return NextResponse.json({ address: '', city: '', state: '', zipCode: '' });
      }
    }

    if (!q || q.length < 2) return NextResponse.json([]);

    let suggestions: any[] = [];

    if (GOOGLE_KEY) {
      suggestions = await fetchGoogleAutocomplete(q);
    } else {
      // Fallback
      suggestions = await fetchPhoton(q);
    }

    return NextResponse.json(suggestions);
  } catch (error: any) {
    console.error('Address autocomplete error:', error);
    
    // Try free fallback on error
    if (GOOGLE_KEY && q) {
      try {
        const fallback = await fetchPhoton(q);
        return NextResponse.json(fallback);
      } catch {}
    }
    
    return NextResponse.json([]);
  }
}
