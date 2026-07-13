export type AddressSuggestion = {
  address: string;
  city: string;
  state: string;
  zipCode: string;
  display: string;
  place_id?: string;
  source?: string;
};

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;
const FETCH_OPTIONS = { cache: 'no-store' as const };

const queryCache = new Map<string, { results: AddressSuggestion[]; expires: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

const STATE_ABBREV: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};

function normalizeState(state: string): string {
  const trimmed = state.trim();
  if (!trimmed) return '';
  if (trimmed.length === 2) return trimmed.toUpperCase();
  return STATE_ABBREV[trimmed.toLowerCase()] || trimmed.slice(0, 2).toUpperCase();
}

function formatDisplay(address: string, city: string, state: string, zipCode: string): string {
  return [address, city, state, zipCode].filter(Boolean).join(', ');
}

function normalizeSuggestion(raw: Partial<AddressSuggestion>): AddressSuggestion | null {
  const address = String(raw.address || '').trim();
  if (!address) return null;

  const city = String(raw.city || '').trim();
  const state = normalizeState(String(raw.state || ''));
  const zipCode = String(raw.zipCode || '').trim();
  const display =
    String(raw.display || '').trim() ||
    formatDisplay(address, city, state, zipCode);

  return {
    address,
    city,
    state,
    zipCode,
    display,
    place_id: raw.place_id,
    source: raw.source,
  };
}

function dedupeKey(s: AddressSuggestion): string {
  return [s.address, s.city, s.state, s.zipCode]
    .map(part => part.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .join('|');
}

export function buildGeocodeQuery(
  q: string,
  city?: string,
  state?: string,
  zip?: string
): string {
  const base = q.trim();
  const parts = [base];
  const lower = base.toLowerCase();

  if (city?.trim() && !lower.includes(city.trim().toLowerCase())) {
    parts.push(city.trim());
  }
  if (state?.trim() && !lower.includes(state.trim().toLowerCase())) {
    parts.push(state.trim());
  }
  if (zip?.trim() && !base.includes(zip.trim())) {
    parts.push(zip.trim());
  }

  return parts.filter(Boolean).join(', ');
}

export function scoreAddressSuggestion(
  suggestion: AddressSuggestion,
  query: string,
  city?: string,
  state?: string
): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  const street = (suggestion.address || '').toLowerCase();
  const display = (suggestion.display || '').toLowerCase();
  let score = 0;

  if (street.startsWith(q) || display.startsWith(q)) score += 120;
  if (display.includes(q) || street.includes(q)) score += 60;

  const tokens = q.split(/[\s,]+/).filter(token => token.length > 1);
  const matchedTokens = tokens.filter(
    token => street.includes(token) || display.includes(token)
  ).length;
  score += matchedTokens * 15;
  if (tokens.length > 0 && matchedTokens === tokens.length) score += 40;

  const qHasNumber = /^\d+/.test(q);
  const streetHasNumber = /^\d+/.test(street);
  if (qHasNumber && streetHasNumber) score += 25;

  if (city?.trim() && suggestion.city?.toLowerCase().includes(city.trim().toLowerCase())) {
    score += 30;
  }
  if (state?.trim()) {
    const want = normalizeState(state);
    if (suggestion.state?.toUpperCase() === want) score += 25;
  }

  if (suggestion.source === 'google') score += 8;
  if (suggestion.source === 'nominatim') score += 6;
  if (suggestion.source === 'census') score += 4;
  if (suggestion.source === 'history') score += 12;
  if (suggestion.source === 'profile') score += 10;

  return score;
}

export function rankAddressSuggestions(
  suggestions: AddressSuggestion[],
  query: string,
  city?: string,
  state?: string
): AddressSuggestion[] {
  const seen = new Set<string>();
  return suggestions
    .map(s => ({ s, score: scoreAddressSuggestion(s, query, city, state) }))
    .filter(({ s, score }) => {
      if (score <= 0) return false;
      const key = dedupeKey(s);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .map(({ s }) => s);
}

function getCached(query: string): AddressSuggestion[] | null {
  const entry = queryCache.get(query);
  if (!entry || Date.now() > entry.expires) return null;
  return entry.results;
}

function setCached(query: string, results: AddressSuggestion[]) {
  queryCache.set(query, { results, expires: Date.now() + CACHE_TTL_MS });
  if (queryCache.size > 200) {
    const oldest = queryCache.keys().next().value;
    if (oldest) queryCache.delete(oldest);
  }
}

type ProviderResult = {
  suggestions: AddressSuggestion[];
  error?: string;
};

export function isGooglePlacesConfigured(): boolean {
  return !!GOOGLE_KEY;
}

async function fetchGoogleAutocomplete(q: string): Promise<ProviderResult> {
  if (!GOOGLE_KEY) {
    return { suggestions: [], error: 'GOOGLE_PLACES_API_KEY not set on server' };
  }

  const url =
    `https://maps.googleapis.com/maps/api/place/autocomplete/json` +
    `?input=${encodeURIComponent(q)}` +
    `&types=address` +
    `&components=country:us` +
    `&key=${GOOGLE_KEY}`;

  const res = await fetch(url, FETCH_OPTIONS);
  if (!res.ok) {
    return { suggestions: [], error: `Google HTTP ${res.status}` };
  }

  const data = await res.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    const message = String(data.error_message || data.status || 'Google request failed');
    console.error('Google Places autocomplete:', message);
    return {
      suggestions: [],
      error: message.includes('referer') || message.includes('Referer')
        ? `${message} — use Application restrictions: None (server-side key on Vercel)`
        : message,
    };
  }

  const suggestions = (data.predictions || []).slice(0, 8).map(
    (p: { structured_formatting?: { main_text?: string }; description: string; place_id: string }) =>
      normalizeSuggestion({
        address: p.structured_formatting?.main_text || p.description.split(',')[0],
        city: '',
        state: '',
        zipCode: '',
        display: p.description,
        place_id: p.place_id,
        source: 'google',
      })
  ).filter((item: AddressSuggestion | null): item is AddressSuggestion => !!item);

  return { suggestions };
}

async function fetchNominatim(q: string): Promise<AddressSuggestion[]> {
  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?q=${encodeURIComponent(q)}` +
    `&format=json&addressdetails=1&limit=8&countrycodes=us`;

  const res = await fetch(url, {
    ...FETCH_OPTIONS,
    headers: { 'User-Agent': 'EstimateAce/1.0 (contractor estimates app)' },
  });
  if (!res.ok) return [];

  const results = await res.json();
  if (!Array.isArray(results)) return [];

  return results
    .map((item: {
      display_name?: string;
      addresstype?: string;
      class?: string;
      type?: string;
      address?: Record<string, string>;
    }) => {
      const addr = item.address || {};
      const houseNumber = addr.house_number || '';
      const road = addr.road || addr.pedestrian || addr.footway || '';
      const street = [houseNumber, road].filter(Boolean).join(' ').trim();
      const isAddressLike =
        !!street ||
        ['house', 'building', 'residential', 'place'].includes(item.type || '') ||
        ['place', 'building'].includes(item.class || '');

      if (!isAddressLike && !street) return null;

      const city =
        addr.city ||
        addr.town ||
        addr.village ||
        addr.hamlet ||
        addr.suburb ||
        '';
      const state =
        addr['ISO3166-2-lvl4']?.replace(/^US-/, '') ||
        normalizeState(addr.state || '');
      const zipCode = addr.postcode || '';
      const address = street || (item.display_name || '').split(',')[0].trim();

      return normalizeSuggestion({
        address,
        city,
        state,
        zipCode,
        display: item.display_name || formatDisplay(address, city, state, zipCode),
        source: 'nominatim',
      });
    })
    .filter((item: AddressSuggestion | null): item is AddressSuggestion => !!item);
}

async function fetchCensusGeocoder(q: string): Promise<AddressSuggestion[]> {
  if (!/\d/.test(q)) return [];

  const url =
    `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress` +
    `?address=${encodeURIComponent(q)}` +
    `&benchmark=Public_AR_Current&format=json`;

  const res = await fetch(url, FETCH_OPTIONS);
  if (!res.ok) return [];

  const data = await res.json();
  const matches = data?.result?.addressMatches || [];
  if (!Array.isArray(matches)) return [];

  return matches
    .map((match: {
      matchedAddress?: string;
      addressComponents?: {
        fromAddress?: string;
        toAddress?: string;
        preQualifier?: string;
        preDirection?: string;
        preType?: string;
        streetName?: string;
        suffixType?: string;
        suffixDirection?: string;
        city?: string;
        state?: string;
        zip?: string;
      };
    }) => {
      const matched = String(match.matchedAddress || '').trim();
      const address = matched.split(',')[0]?.trim() || '';
      const parts = match.addressComponents || {};
      const city = String(parts.city || '').trim();
      const state = normalizeState(String(parts.state || ''));
      const zipCode = String(parts.zip || '').trim();

      return normalizeSuggestion({
        address,
        city,
        state,
        zipCode,
        display: match.matchedAddress || formatDisplay(address, city, state, zipCode),
        source: 'census',
      });
    })
    .filter((item: AddressSuggestion | null): item is AddressSuggestion => !!item);
}

async function fetchPhoton(q: string): Promise<AddressSuggestion[]> {
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=en`;
  const res = await fetch(url, {
    ...FETCH_OPTIONS,
    headers: { 'User-Agent': 'EstimateAce/1.0' },
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
      const state = normalizeState(p.state || '');
      const zipCode = (p.postcode || '').trim();

      return normalizeSuggestion({
        address: street,
        city,
        state,
        zipCode,
        display: formatDisplay(street, city, state, zipCode),
        source: 'photon',
      });
    })
    .filter((item: AddressSuggestion | null): item is AddressSuggestion => !!item?.address);
}

export async function fetchGooglePlaceDetails(placeId: string) {
  if (!GOOGLE_KEY) {
    throw new Error('Google Places API key not configured');
  }

  const url =
    `https://maps.googleapis.com/maps/api/place/details/json` +
    `?place_id=${placeId}` +
    `&fields=address_components,formatted_address` +
    `&key=${GOOGLE_KEY}`;

  const res = await fetch(url, FETCH_OPTIONS);
  if (!res.ok) throw new Error(`Google details error: ${res.status}`);

  const data = await res.json();
  if (data.status !== 'OK') {
    throw new Error(data.error_message || data.status);
  }

  const components = data.result?.address_components || [];
  const getComponent = (type: string) =>
    components.find((c: { types: string[]; short_name?: string; long_name?: string }) =>
      c.types.includes(type)
    );

  const streetNumber = getComponent('street_number')?.long_name || '';
  const route = getComponent('route')?.long_name || '';
  const address = [streetNumber, route].filter(Boolean).join(' ').trim();

  const city =
    getComponent('locality')?.long_name ||
    getComponent('sublocality')?.long_name ||
    getComponent('administrative_area_level_2')?.long_name ||
    '';

  const state = getComponent('administrative_area_level_1')?.short_name || '';
  const zipCode = getComponent('postal_code')?.long_name || '';

  return {
    address: address || data.result?.formatted_address?.split(',')[0] || '',
    city,
    state,
    zipCode,
    display: data.result?.formatted_address || '',
  };
}

export async function fetchAddressSuggestions(input: {
  q: string;
  city?: string;
  state?: string;
  zip?: string;
}): Promise<AddressSuggestion[]> {
  const geocodeQuery = buildGeocodeQuery(input.q, input.city, input.state, input.zip);
  if (!geocodeQuery || geocodeQuery.length < 2) return [];

  const cached = getCached(geocodeQuery);
  if (cached) return cached;

  const [googleResult, nominatim, census, photon] = await Promise.all([
    fetchGoogleAutocomplete(geocodeQuery),
    fetchNominatim(geocodeQuery).catch(() => [] as AddressSuggestion[]),
    fetchCensusGeocoder(geocodeQuery).catch(() => [] as AddressSuggestion[]),
    fetchPhoton(geocodeQuery).catch(() => [] as AddressSuggestion[]),
  ]);

  let combined: AddressSuggestion[] = [
    ...googleResult.suggestions,
    ...nominatim,
    ...census,
    ...photon,
  ];

  const queryHasStreetNumber = /^\d+/.test(input.q.trim());
  if (queryHasStreetNumber) {
    combined = combined.filter(
      suggestion =>
        suggestion.source !== 'photon' || /^\d+/.test(suggestion.address)
    );
  }

  let ranked = rankAddressSuggestions(combined, input.q, input.city, input.state).slice(0, 8);
  if (!ranked.length && combined.length) {
    ranked = combined.slice(0, 8);
  }

  setCached(geocodeQuery, ranked);
  return ranked;
}

/** Live provider check for /api/health?probe=address (use on Vercel after deploy). */
export async function probeAddressAutocomplete() {
  const testQuery = '2334 Senior Drive Charlotte NC';
  const [google, nominatim, census] = await Promise.all([
    fetchGoogleAutocomplete(testQuery),
    fetchNominatim(testQuery).catch((err: unknown) => {
      console.error('Nominatim probe failed:', err);
      return [] as AddressSuggestion[];
    }),
    fetchCensusGeocoder(testQuery).catch((err: unknown) => {
      console.error('Census probe failed:', err);
      return [] as AddressSuggestion[];
    }),
  ]);
  const combined = await fetchAddressSuggestions({ q: '2334 senior dr charlotte nc' });

  return {
    googlePlacesConfigured: isGooglePlacesConfigured(),
    providers: {
      google: {
        count: google.suggestions.length,
        error: google.error || null,
        sample: google.suggestions[0]?.display || null,
      },
      nominatim: {
        count: nominatim.length,
        sample: nominatim[0]?.display || null,
      },
      census: {
        count: census.length,
        sample: census[0]?.display || null,
      },
    },
    combinedCount: combined.length,
    combinedSources: [...new Set(combined.map(item => item.source).filter(Boolean))],
    topCombined: combined[0]?.display || null,
    keyRestrictionHint:
      google.error && /referer|referrer|ip/i.test(google.error)
        ? 'Set Google key Application restrictions to None — Vercel calls Places from the server, not the browser.'
        : null,
  };
}