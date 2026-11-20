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

export type GoogleAddressComponent = {
  types?: string[];
  long_name?: string;
  short_name?: string;
  longText?: string;
  shortText?: string;
};

/** Build "123 Main St #4" including unit/subpremise when present. */
export function formatStreetAddress(parts: {
  streetNumber?: string;
  route?: string;
  subpremise?: string;
}): string {
  const street = [parts.streetNumber, parts.route].filter(Boolean).join(' ').trim();
  const unit = String(parts.subpremise || '').trim();
  if (!unit) return street;
  if (/^(apt\.?|apartment|unit|ste\.?|suite|#)/i.test(unit)) {
    return `${street} ${unit}`.trim();
  }
  return `${street} #${unit}`.trim();
}

export function componentText(
  components: GoogleAddressComponent[],
  type: string,
  short = false
): string {
  const c = (components || []).find((item) => (item.types || []).includes(type));
  if (!c) return '';
  if (short) return String(c.shortText || c.short_name || c.longText || c.long_name || '').trim();
  return String(c.longText || c.long_name || c.shortText || c.short_name || '').trim();
}

export function structuredAddressFromComponents(
  components: GoogleAddressComponent[],
  formattedAddress = ''
): { address: string; city: string; state: string; zipCode: string; display: string } {
  const streetNumber = componentText(components, 'street_number');
  const route = componentText(components, 'route');
  const subpremise = componentText(components, 'subpremise');
  const address =
    formatStreetAddress({ streetNumber, route, subpremise }) ||
    formattedAddress.split(',')[0]?.trim() ||
    '';
  const city =
    componentText(components, 'locality') ||
    componentText(components, 'sublocality_level_1') ||
    componentText(components, 'sublocality') ||
    componentText(components, 'postal_town') ||
    componentText(components, 'administrative_area_level_3') ||
    componentText(components, 'administrative_area_level_2');
  const state = normalizeState(componentText(components, 'administrative_area_level_1', true));
  const zip = componentText(components, 'postal_code');
  const plus4 = componentText(components, 'postal_code_suffix');
  const zipCode = zip && plus4 && !zip.includes('-') ? `${zip}-${plus4}` : zip;
  return {
    address,
    city,
    state,
    zipCode,
    display: formattedAddress || formatDisplay(address, city, state, zipCode),
  };
}

export type AddressSuggestInput = {
  q: string;
  sessionToken?: string;
  lat?: number;
  lng?: number;
  biasCity?: string;
  biasState?: string;
  biasZip?: string;
  /** @deprecated leftover job fields — used only as ranking hints, not appended to Google input */
  city?: string;
  state?: string;
  zip?: string;
};

export function suggestCacheKey(input: AddressSuggestInput): string {
  const q = input.q.trim().toLowerCase().replace(/\s+/g, ' ');
  const lat = input.lat != null && Number.isFinite(input.lat) ? input.lat.toFixed(3) : '';
  const lng = input.lng != null && Number.isFinite(input.lng) ? input.lng.toFixed(3) : '';
  const city = String(input.biasCity || '').trim().toLowerCase();
  const state = String(input.biasState || '').trim().toLowerCase();
  const zip = String(input.biasZip || '').trim();
  return [q, lat, lng, city, state, zip].join('|');
}

/** When Google already returned matches, skip slower public geocoders. */
export function shouldSkipPublicGeocoders(
  googleConfigured: boolean,
  googleCount: number
): boolean {
  return googleConfigured && googleCount > 0;
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

const PLACES_NEW_AUTOCOMPLETE = 'https://places.googleapis.com/v1/places:autocomplete';
const PLACES_NEW_DETAILS = 'https://places.googleapis.com/v1/places';
const BIAS_RADIUS_METERS = 50_000;
const GOOGLE_TIMEOUT_MS = 2500;

/** null = not probed yet; true/false remembered for this process so a disabled New API is not retried every keystroke. */
let placesNewAvailable: boolean | null = null;

export function getPlacesAutocompleteApiMode(): 'new' | 'legacy' | 'unknown' | 'unset' {
  if (!GOOGLE_KEY) return 'unset';
  if (placesNewAvailable === true) return 'new';
  if (placesNewAvailable === false) return 'legacy';
  return 'unknown';
}

export function resetPlacesApiModeForTests() {
  placesNewAvailable = null;
}

function isFiniteCoord(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

function looksLikeNewApiDisabled(status: number, body: any): boolean {
  const text = JSON.stringify(body || {});
  if (status === 404 || status === 403 || status === 400) {
    if (/SERVICE_DISABLED|PERMISSION_DENIED|API_KEY_INVALID|Places API \(New\)|PLACE_AUTOCOMPLETE|METHOD_NOT_FOUND|not been used|disabled/i.test(text)) {
      return true;
    }
  }
  const statusText = String(body?.error?.status || body?.status || '');
  return /PERMISSION_DENIED|SERVICE_DISABLED|REQUEST_DENIED/i.test(statusText) &&
    /places\.googleapis|Places API|API key/i.test(text);
}

function locationBiasFromInput(input: AddressSuggestInput): { latitude: number; longitude: number } | null {
  if (isFiniteCoord(input.lat) && isFiniteCoord(input.lng)) {
    return { latitude: input.lat, longitude: input.lng };
  }
  return null;
}

async function fetchGoogleAutocompleteNew(input: AddressSuggestInput): Promise<ProviderResult | 'disabled'> {
  if (!GOOGLE_KEY) return { suggestions: [], error: 'GOOGLE_PLACES_API_KEY not set on server' };
  if (placesNewAvailable === false) return 'disabled';

  const body: Record<string, unknown> = {
    input: input.q,
    includedRegionCodes: ['us'],
    languageCode: 'en',
    includeQueryPredictions: false,
  };
  if (input.sessionToken) body.sessionToken = input.sessionToken;
  const bias = locationBiasFromInput(input);
  if (bias) {
    body.locationBias = {
      circle: { center: bias, radius: BIAS_RADIUS_METERS },
    };
  }
  // Prefer street-level results including units, without being so strict that valid homes are dropped.
  body.includedPrimaryTypes = ['street_address', 'subpremise', 'premise', 'route'];

  const headers = {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': GOOGLE_KEY,
    'X-Goog-FieldMask':
      'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
  };
  let res = await fetch(PLACES_NEW_AUTOCOMPLETE, {
    method: 'POST',
    ...FETCH_OPTIONS,
    signal: withTimeout(GOOGLE_TIMEOUT_MS),
    headers,
    body: JSON.stringify(body),
  });
  let data = await res.json().catch(() => ({}));
  // Some keys reject includedPrimaryTypes combinations; retry once without type filter.
  if (!res.ok && res.status === 400 && body.includedPrimaryTypes) {
    delete body.includedPrimaryTypes;
    res = await fetch(PLACES_NEW_AUTOCOMPLETE, {
      method: 'POST',
      ...FETCH_OPTIONS,
      signal: withTimeout(GOOGLE_TIMEOUT_MS),
      headers,
      body: JSON.stringify(body),
    });
    data = await res.json().catch(() => ({}));
  }
  if (!res.ok) {
    if (looksLikeNewApiDisabled(res.status, data)) {
      placesNewAvailable = false;
      return 'disabled';
    }
    const message = String(data?.error?.message || data?.error_message || `Google New HTTP ${res.status}`);
    console.error('Places API (New) autocomplete:', message);
    return { suggestions: [], error: message };
  }

  placesNewAvailable = true;
  const suggestions = (data.suggestions || [])
    .map((row: any) => {
      const pred = row?.placePrediction;
      if (!pred) return null;
      const text = String(pred.text?.text || pred.text || '').trim();
      const main = String(
        pred.structuredFormat?.mainText?.text ||
          pred.structuredFormat?.mainText ||
          text.split(',')[0] ||
          ''
      ).trim();
      const placeId = String(pred.placeId || pred.place || '').replace(/^places\//, '');
      return normalizeSuggestion({
        address: main || text,
        city: '',
        state: '',
        zipCode: '',
        display: text || main,
        place_id: placeId || undefined,
        source: 'google',
      });
    })
    .filter((item: AddressSuggestion | null): item is AddressSuggestion => !!item)
    .slice(0, 8);

  return { suggestions };
}

async function fetchGoogleAutocompleteLegacy(input: AddressSuggestInput): Promise<ProviderResult> {
  if (!GOOGLE_KEY) {
    return { suggestions: [], error: 'GOOGLE_PLACES_API_KEY not set on server' };
  }

  const params = new URLSearchParams({
    input: input.q,
    types: 'address',
    components: 'country:us',
    key: GOOGLE_KEY,
  });
  if (input.sessionToken) params.set('sessiontoken', input.sessionToken);
  const bias = locationBiasFromInput(input);
  if (bias) {
    params.set('location', `${bias.latitude},${bias.longitude}`);
    params.set('radius', String(BIAS_RADIUS_METERS));
    params.set('origin', `${bias.latitude},${bias.longitude}`);
  }

  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params.toString()}`;
  const res = await fetch(url, { ...FETCH_OPTIONS, signal: withTimeout(GOOGLE_TIMEOUT_MS) });
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

async function fetchGoogleAutocomplete(input: AddressSuggestInput | string): Promise<ProviderResult> {
  const q = typeof input === 'string' ? { q: input } : input;
  if (!GOOGLE_KEY) {
    return { suggestions: [], error: 'GOOGLE_PLACES_API_KEY not set on server' };
  }
  if (!q.q?.trim()) return { suggestions: [] };

  if (placesNewAvailable !== false) {
    try {
      const neu = await fetchGoogleAutocompleteNew(q);
      if (neu !== 'disabled') return neu;
    } catch (err) {
      console.error('Places API (New) autocomplete failed, falling back to legacy:', err);
      placesNewAvailable = false;
    }
  }

  return fetchGoogleAutocompleteLegacy(q);
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

export async function fetchGooglePlaceDetails(placeId: string, sessionToken?: string) {
  if (!GOOGLE_KEY) {
    throw new Error('Google Places API key not configured');
  }
  const id = String(placeId || '').trim().replace(/^places\//, '');
  if (!id) throw new Error('Missing place id');

  if (placesNewAvailable !== false) {
    try {
      const params = new URLSearchParams();
      if (sessionToken) params.set('sessionToken', sessionToken);
      const qs = params.toString();
      const url = `${PLACES_NEW_DETAILS}/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`;
      const res = await fetch(url, {
        ...FETCH_OPTIONS,
        signal: withTimeout(GOOGLE_TIMEOUT_MS),
        headers: {
          'X-Goog-Api-Key': GOOGLE_KEY,
          'X-Goog-FieldMask': 'formattedAddress,addressComponents',
        },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && (data.addressComponents || data.formattedAddress)) {
        placesNewAvailable = true;
        return structuredAddressFromComponents(
          data.addressComponents || [],
          String(data.formattedAddress || '')
        );
      }
      if (looksLikeNewApiDisabled(res.status, data)) {
        placesNewAvailable = false;
      } else if (!res.ok) {
        // Fall through to legacy unless New is clearly disabled.
        console.error('Places API (New) details:', data?.error?.message || res.status);
      }
    } catch (err) {
      console.error('Places API (New) details failed, falling back to legacy:', err);
    }
  }

  const params = new URLSearchParams({
    place_id: id,
    fields: 'address_components,formatted_address',
    key: GOOGLE_KEY,
  });
  if (sessionToken) params.set('sessiontoken', sessionToken);
  const url = `https://maps.googleapis.com/maps/api/place/details/json?${params.toString()}`;
  const res = await fetch(url, { ...FETCH_OPTIONS, signal: withTimeout(GOOGLE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Google details error: ${res.status}`);

  const data = await res.json();
  if (data.status !== 'OK') {
    throw new Error(data.error_message || data.status);
  }

  return structuredAddressFromComponents(
    data.result?.address_components || [],
    String(data.result?.formatted_address || '')
  );
}

export type AddressSuggestProviders = {
  google?: (input: AddressSuggestInput) => Promise<ProviderResult>;
  nominatim?: (q: string) => Promise<AddressSuggestion[]>;
  census?: (q: string) => Promise<AddressSuggestion[]>;
  photon?: (q: string) => Promise<AddressSuggestion[]>;
};

export async function fetchAddressSuggestions(
  input: AddressSuggestInput,
  providers?: AddressSuggestProviders
): Promise<AddressSuggestion[]> {
  const q = String(input.q || '').trim();
  if (!q || q.length < 2) return [];

  const cacheKey = suggestCacheKey(input);
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const googleFn = providers?.google || fetchGoogleAutocomplete;
  const nominatimFn = providers?.nominatim || fetchNominatim;
  const censusFn = providers?.census || fetchCensusGeocoder;
  const photonFn = providers?.photon || fetchPhoton;

  const rankWith = (list: AddressSuggestion[]) => {
    const biasCity = input.biasCity || input.city;
    const biasState = input.biasState || input.state;
    let ranked = rankAddressSuggestions(list, q, biasCity, biasState).slice(0, 8);
    if (!ranked.length && list.length) ranked = list.slice(0, 8);
    return ranked;
  };

  // Fast path: Google Places only. Do not wait on Nominatim / Census / Photon
  // (those were adding 500–800ms to every first keystroke in production).
  if (isGooglePlacesConfigured() || providers?.google) {
    const googleResult = await googleFn(input).catch((err: unknown) => {
      console.error('Google autocomplete failed:', err);
      return { suggestions: [] as AddressSuggestion[], error: 'Google failed' };
    });
    if (shouldSkipPublicGeocoders(isGooglePlacesConfigured() || !!providers?.google, googleResult.suggestions.length)) {
      const ranked = rankWith(googleResult.suggestions);
      setCached(cacheKey, ranked);
      return ranked;
    }
  }

  // Fallback when Google is unset, errors, or returns nothing.
  // Public geocoders can use a composed query with the *bias* locality (company area),
  // never leftover job city/state fields.
  const fallbackQuery = buildGeocodeQuery(q, input.biasCity, input.biasState, input.biasZip);
  const [nominatim, census, photon] = await Promise.all([
    nominatimFn(fallbackQuery).catch(() => [] as AddressSuggestion[]),
    censusFn(fallbackQuery).catch(() => [] as AddressSuggestion[]),
    photonFn(fallbackQuery).catch(() => [] as AddressSuggestion[]),
  ]);

  let combined: AddressSuggestion[] = [...nominatim, ...census, ...photon];
  const queryHasStreetNumber = /^\d+/.test(q);
  if (queryHasStreetNumber) {
    combined = combined.filter(
      suggestion =>
        suggestion.source !== 'photon' || /^\d+/.test(suggestion.address)
    );
  }

  const ranked = rankWith(combined);
  setCached(cacheKey, ranked);
  return ranked;
}

/** Live provider check for /api/health?probe=address (use on Vercel after deploy). */
export async function probeAddressAutocomplete() {
  const testQuery = '2334 Senior Drive Charlotte NC';
  const [google, nominatim, census] = await Promise.all([
    fetchGoogleAutocomplete({ q: testQuery }),
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
    googleApi: getPlacesAutocompleteApiMode(),
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