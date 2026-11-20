'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  rankAddressSuggestions,
  type AddressSuggestion,
} from '@/lib/address-autocomplete';
import {
  ADDRESS_AUTOCOMPLETE_DEBOUNCE_MS,
  ADDRESS_AUTOCOMPLETE_MIN_CHARS,
  buildDetailsQueryParams,
  buildSuggestQueryParams,
  createSuggestionCache,
  getCachedBrowserLocation,
  moveActiveSuggestionIndex,
  newPlacesSessionToken,
  requestBrowserLocation,
} from '@/lib/address-autocomplete-client';

export type AddressBias = {
  lat?: number | null;
  lng?: number | null;
  city?: string;
  state?: string;
  zip?: string;
};

const suggestCache = createSuggestionCache<AddressSuggestion>();

export function useAddressAutocomplete(opts: {
  query: string;
  enabled?: boolean;
  bias?: AddressBias;
  extras?: AddressSuggestion[];
}) {
  const { query, enabled = true, bias, extras = [] } = opts;
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(() => getCachedBrowserLocation());

  const abortRef = useRef<AbortController | null>(null);
  const sessionTokenRef = useRef(newPlacesSessionToken());
  const requestIdRef = useRef(0);
  const extrasRef = useRef(extras);
  extrasRef.current = extras;

  const effectiveBias = useMemo<AddressBias>(
    () => ({
      lat: geo?.lat ?? bias?.lat ?? null,
      lng: geo?.lng ?? bias?.lng ?? null,
      city: bias?.city || '',
      state: bias?.state || '',
      zip: bias?.zip || '',
    }),
    [geo, bias?.lat, bias?.lng, bias?.city, bias?.state, bias?.zip]
  );

  const mergeWithExtras = useCallback(
    (q: string, live: AddressSuggestion[]) => {
      const combined = rankAddressSuggestions(
        [...live, ...(extrasRef.current || [])],
        q,
        effectiveBias.city,
        effectiveBias.state
      );
      return combined.slice(0, 8);
    },
    [effectiveBias.city, effectiveBias.state]
  );

  useEffect(() => {
    if (!enabled) return;
    const q = query.trim();
    if (!q || q.length < ADDRESS_AUTOCOMPLETE_MIN_CHARS) {
      setSuggestions(mergeWithExtras(q, []).slice(0, 8));
      setLoading(false);
      setActiveIndex(-1);
      return;
    }

    const cacheKey = `${q.toLowerCase()}|${effectiveBias.lat ?? ''}|${effectiveBias.lng ?? ''}|${effectiveBias.city}|${effectiveBias.state}|${effectiveBias.zip}`;
    const cached = suggestCache.get(cacheKey);
    if (cached) {
      setSuggestions(mergeWithExtras(q, cached));
      setLoading(false);
      setActiveIndex(-1);
      return;
    }

    const requestId = ++requestIdRef.current;
    const timer = window.setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      try {
        const params = buildSuggestQueryParams({
          q,
          sessionToken: sessionTokenRef.current,
          lat: effectiveBias.lat,
          lng: effectiveBias.lng,
          biasCity: effectiveBias.city,
          biasState: effectiveBias.state,
          biasZip: effectiveBias.zip,
        });
        const res = await fetch(`/api/address-autocomplete?${params.toString()}`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        let live: AddressSuggestion[] = [];
        if (res.ok) {
          const data = await res.json();
          live = Array.isArray(data) ? data : [];
        }
        if (requestId !== requestIdRef.current || controller.signal.aborted) return;
        suggestCache.set(cacheKey, live);
        setSuggestions(mergeWithExtras(q, live));
        setActiveIndex(-1);
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        if (requestId !== requestIdRef.current) return;
        setSuggestions(mergeWithExtras(q, []));
      } finally {
        if (requestId === requestIdRef.current && !controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, ADDRESS_AUTOCOMPLETE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [
    query,
    enabled,
    effectiveBias.lat,
    effectiveBias.lng,
    effectiveBias.city,
    effectiveBias.state,
    effectiveBias.zip,
    mergeWithExtras,
  ]);

  const selectSuggestion = useCallback(async (sugg: AddressSuggestion) => {
    setActiveIndex(-1);
    if (sugg.place_id) {
      try {
        const params = buildDetailsQueryParams(sugg.place_id, sessionTokenRef.current);
        const res = await fetch(`/api/address-autocomplete?${params.toString()}`, {
          cache: 'no-store',
        });
        // End the Places session after details (billed as one session).
        sessionTokenRef.current = newPlacesSessionToken();
        if (res.ok) {
          const details = await res.json();
          return {
            address: details.address || sugg.address || sugg.display || '',
            city: details.city || sugg.city || '',
            state: details.state || sugg.state || '',
            zipCode: details.zipCode || sugg.zipCode || '',
            display: details.display || sugg.display || '',
          };
        }
      } catch (err) {
        sessionTokenRef.current = newPlacesSessionToken();
        console.error('Failed to fetch place details:', err);
      }
    }
    return {
      address: sugg.address || sugg.display || '',
      city: sugg.city || '',
      state: sugg.state || '',
      zipCode: sugg.zipCode || '',
      display: sugg.display || sugg.address || '',
    };
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>, onPick?: (sugg: AddressSuggestion) => void) => {
      if (!enabled) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => moveActiveSuggestionIndex(i, 1, suggestions.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => moveActiveSuggestionIndex(i, -1, suggestions.length));
      } else if (e.key === 'Enter') {
        if (activeIndex >= 0 && suggestions[activeIndex]) {
          e.preventDefault();
          onPick?.(suggestions[activeIndex]);
        }
      } else if (e.key === 'Escape') {
        setActiveIndex(-1);
      }
    },
    [activeIndex, enabled, suggestions]
  );

  const ensureBrowserLocation = useCallback(() => {
    if (getCachedBrowserLocation() || geo) return;
    void requestBrowserLocation().then((loc) => {
      if (loc) setGeo(loc);
    });
  }, [geo]);

  return {
    suggestions,
    loading,
    activeIndex,
    setActiveIndex,
    onKeyDown,
    selectSuggestion,
    ensureBrowserLocation,
    minChars: ADDRESS_AUTOCOMPLETE_MIN_CHARS,
  };
}

export { ADDRESS_AUTOCOMPLETE_DEBOUNCE_MS, ADDRESS_AUTOCOMPLETE_MIN_CHARS };
