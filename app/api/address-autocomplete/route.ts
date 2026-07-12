import { NextRequest, NextResponse } from 'next/server';

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;
const GROK_KEY = process.env.GROK_API_KEY;

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 25;
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

type AddressSuggestion = {
  address: string;
  city: string;
  state: string;
  zipCode: string;
  display: string;
  place_id?: string;
};

function normalizeSuggestion(raw: Record<string, unknown>): AddressSuggestion | null {
  const address = String(raw.address || '').trim();
  if (!address) return null;

  const city = String(raw.city || '').trim();
  const state = String(raw.state || '').trim().slice(0, 2).toUpperCase();
  const zipCode = String(raw.zipCode || raw.zip || '').trim();
  const display =
    String(raw.display || '').trim() ||
    [address, city, state, zipCode].filter(Boolean).join(', ');

  return { address, city, state, zipCode, display };
}

function parseGrokSuggestions(aiText: string): AddressSuggestion[] {
  const arrayMatch = aiText.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];

  const parsed = JSON.parse(arrayMatch[0]);
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map(item => (item && typeof item === 'object' ? normalizeSuggestion(item as Record<string, unknown>) : null))
    .filter((item): item is AddressSuggestion => !!item)
    .slice(0, 8);
}

async function fetchGrokAutocomplete(q: string): Promise<AddressSuggestion[]> {
  if (!GROK_KEY) {
    throw new Error('GROK_API_KEY not configured');
  }

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROK_KEY}`,
    },
    body: JSON.stringify({
      model: 'grok-3',
      messages: [
        {
          role: 'system',
          content:
            'You complete partial US street addresses for contractors. Return ONLY valid JSON: an array of up to 6 objects. Each object must include address (street line only), city, state (2-letter US code), zipCode, and display (full single-line formatted address). Suggest realistic completions based on the partial query. Prefer matches in the United States. No markdown or commentary.',
        },
        {
          role: 'user',
          content: q,
        },
      ],
      temperature: 0.2,
      max_tokens: 700,
    }),
  });

  if (!response.ok) {
    throw new Error(`Grok autocomplete error: ${response.status}`);
  }

  const data = await response.json();
  const aiText = data.choices?.[0]?.message?.content || '';
  return parseGrokSuggestions(aiText);
}

async function fetchGoogleAutocomplete(q: string): Promise<AddressSuggestion[]> {
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

  return (data.predictions || []).slice(0, 8).map((p: { structured_formatting?: { main_text?: string }; description: string; place_id: string }) => ({
    address: p.structured_formatting?.main_text || p.description.split(',')[0],
    city: '',
    state: '',
    zipCode: '',
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
    components.find((c: { types: string[]; long_name: string }) => c.types.includes(type))?.long_name || '';

  const streetNumber = getComponent('street_number');
  const route = getComponent('route');
  const address = [streetNumber, route].filter(Boolean).join(' ').trim();

  const city =
    getComponent('locality') ||
    getComponent('sublocality') ||
    getComponent('administrative_area_level_2') ||
    '';

  const state = getComponent('administrative_area_level_1') || '';
  const zipCode = getComponent('postal_code') || '';

  return {
    address: address || data.result?.formatted_address?.split(',')[0] || '',
    city,
    state,
    zipCode,
    display: data.result?.formatted_address || '',
  };
}

async function fetchPhoton(q: string): Promise<AddressSuggestion[]> {
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=en`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'EstimateAce/1.0' },
    next: { revalidate: 30 },
  });
  if (!res.ok) return [];
  const json = await res.json();
  const features = json.features || [];
  return features
    .map((f: { properties?: Record<string, string> }) => {
      const p = f.properties || {};
      const street =
        p.housenumber && p.street
          ? `${p.housenumber} ${p.street}`.trim()
          : (p.street || p.name || '');
      const city = (p.city || p.town || p.village || '').trim();
      const state = (p.state || '').trim();
      const zipCode = (p.postcode || '').trim();
      return {
        address: street || (p.name || ''),
        city,
        state,
        zipCode,
        display: [street, city, state, zipCode].filter(Boolean).join(', '),
      };
    })
    .filter((s: AddressSuggestion) => s.address)
    .slice(0, 8);
}

async function fetchAutocompleteSuggestions(q: string): Promise<AddressSuggestion[]> {
  if (GROK_KEY) {
    try {
      const grokResults = await fetchGrokAutocomplete(q);
      if (grokResults.length > 0) return grokResults;
    } catch (err) {
      console.error('Grok address autocomplete failed:', err);
    }
  }

  if (GOOGLE_KEY) {
    try {
      return await fetchGoogleAutocomplete(q);
    } catch (err) {
      console.error('Google address autocomplete failed:', err);
    }
  }

  return fetchPhoton(q);
}

/**
 * Address auto-suggest powered by Grok AI (primary), with Photon/OSM and optional Google fallback.
 *
 * - ?q=query for autocomplete suggestions
 * - ?place_id=xxx for Google structured details (only when GOOGLE_PLACES_API_KEY is set)
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
      if (GOOGLE_KEY) {
        const details = await fetchGooglePlaceDetails(placeId);
        return NextResponse.json(details);
      }
      return NextResponse.json({ address: '', city: '', state: '', zipCode: '' });
    }

    if (!q || q.length < 2) return NextResponse.json([]);

    const suggestions = await fetchAutocompleteSuggestions(q);
    return NextResponse.json(suggestions);
  } catch (error: unknown) {
    console.error('Address autocomplete error:', error);

    if (q) {
      try {
        const fallback = await fetchPhoton(q);
        return NextResponse.json(fallback);
      } catch {
        // ignore secondary failure
      }
    }

    return NextResponse.json([]);
  }
}