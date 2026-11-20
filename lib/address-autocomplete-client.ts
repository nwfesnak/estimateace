/** Client-only helpers for address autocomplete (safe to import in the browser). */

export const ADDRESS_AUTOCOMPLETE_DEBOUNCE_MS = 200;
export const ADDRESS_AUTOCOMPLETE_MIN_CHARS = 2;
export const ADDRESS_AUTOCOMPLETE_CACHE_TTL_MS = 2 * 60 * 1000;
export const ADDRESS_AUTOCOMPLETE_CACHE_MAX = 40;
/** Default bias radius around the owner's business or browser location (~31 miles). */
export const ADDRESS_BIAS_RADIUS_METERS = 50_000;

export function newPlacesSessionToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function moveActiveSuggestionIndex(
  current: number,
  direction: 1 | -1,
  length: number
): number {
  if (length <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : length - 1;
  return (current + direction + length) % length;
}

export function suggestionCacheKey(q: string, bias?: {
  lat?: number | null;
  lng?: number | null;
  city?: string;
  state?: string;
  zip?: string;
}): string {
  const n = String(q || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const lat = bias?.lat != null && Number.isFinite(bias.lat) ? bias.lat.toFixed(3) : '';
  const lng = bias?.lng != null && Number.isFinite(bias.lng) ? bias.lng.toFixed(3) : '';
  const city = String(bias?.city || '').trim().toLowerCase();
  const state = String(bias?.state || '').trim().toLowerCase();
  const zip = String(bias?.zip || '').trim();
  return [n, lat, lng, city, state, zip].join('|');
}

export type ClientSuggestCacheEntry<T> = { results: T[]; expires: number };

export function createSuggestionCache<T>(ttlMs = ADDRESS_AUTOCOMPLETE_CACHE_TTL_MS, max = ADDRESS_AUTOCOMPLETE_CACHE_MAX) {
  const map = new Map<string, ClientSuggestCacheEntry<T>>();
  return {
    get(key: string): T[] | null {
      const entry = map.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expires) {
        map.delete(key);
        return null;
      }
      return entry.results;
    },
    set(key: string, results: T[]) {
      map.set(key, { results, expires: Date.now() + ttlMs });
      while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest == null) break;
        map.delete(oldest);
      }
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

export function buildSuggestQueryParams(input: {
  q: string;
  sessionToken?: string;
  lat?: number | null;
  lng?: number | null;
  biasCity?: string;
  biasState?: string;
  biasZip?: string;
}): URLSearchParams {
  const params = new URLSearchParams({ q: String(input.q || '').trim() });
  if (input.sessionToken) params.set('session_token', input.sessionToken);
  if (input.lat != null && Number.isFinite(input.lat)) params.set('lat', String(input.lat));
  if (input.lng != null && Number.isFinite(input.lng)) params.set('lng', String(input.lng));
  if (input.biasCity?.trim()) params.set('bias_city', input.biasCity.trim());
  if (input.biasState?.trim()) params.set('bias_state', input.biasState.trim());
  if (input.biasZip?.trim()) params.set('bias_zip', input.biasZip.trim());
  return params;
}

export function buildDetailsQueryParams(placeId: string, sessionToken?: string): URLSearchParams {
  const params = new URLSearchParams({ place_id: String(placeId || '').trim() });
  if (sessionToken) params.set('session_token', sessionToken);
  return params;
}

/** One-shot browser location; never throws. Cached after the first success. */
let cachedBrowserLocation: { lat: number; lng: number } | null | undefined;

export function getCachedBrowserLocation(): { lat: number; lng: number } | null {
  return cachedBrowserLocation ?? null;
}

export function requestBrowserLocation(timeoutMs = 3000): Promise<{ lat: number; lng: number } | null> {
  if (cachedBrowserLocation !== undefined) return Promise.resolve(cachedBrowserLocation);
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    cachedBrowserLocation = null;
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const done = (value: { lat: number; lng: number } | null) => {
      cachedBrowserLocation = value;
      resolve(value);
    };
    navigator.geolocation.getCurrentPosition(
      (pos) => done({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => done(null),
      { enableHighAccuracy: false, maximumAge: 30 * 60 * 1000, timeout: timeoutMs }
    );
  });
}

/** For tests only. */
export function resetBrowserLocationCacheForTests() {
  cachedBrowserLocation = undefined;
}
