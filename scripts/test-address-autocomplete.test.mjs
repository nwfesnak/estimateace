// Run: npm run test:address-autocomplete
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const S = await jiti.import(path.join(root, 'lib/address-autocomplete.ts'));
const C = await jiti.import(path.join(root, 'lib/address-autocomplete-client.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

test('formatStreetAddress includes subpremise/unit', () => {
  assert.equal(
    S.formatStreetAddress({ streetNumber: '2334', route: 'Senior Drive', subpremise: '2B' }),
    '2334 Senior Drive #2B'
  );
  assert.equal(
    S.formatStreetAddress({ streetNumber: '10', route: 'Main St', subpremise: 'Apt 4' }),
    '10 Main St Apt 4'
  );
  assert.equal(S.formatStreetAddress({ streetNumber: '10', route: 'Main St' }), '10 Main St');
});

test('structuredAddressFromComponents fills street, city, state, zip, and unit (legacy + New shapes)', () => {
  const legacy = S.structuredAddressFromComponents(
    [
      { types: ['street_number'], long_name: '2334' },
      { types: ['route'], long_name: 'Senior Drive' },
      { types: ['subpremise'], long_name: '104' },
      { types: ['locality'], long_name: 'Charlotte' },
      { types: ['administrative_area_level_1'], short_name: 'NC' },
      { types: ['postal_code'], long_name: '28213' },
      { types: ['postal_code_suffix'], long_name: '1234' },
    ],
    '2334 Senior Drive #104, Charlotte, NC 28213, USA'
  );
  assert.equal(legacy.address, '2334 Senior Drive #104');
  assert.equal(legacy.city, 'Charlotte');
  assert.equal(legacy.state, 'NC');
  assert.equal(legacy.zipCode, '28213-1234');

  const neu = S.structuredAddressFromComponents(
    [
      { types: ['street_number'], longText: '100' },
      { types: ['route'], longText: 'N Tryon St' },
      { types: ['locality'], longText: 'Charlotte' },
      { types: ['administrative_area_level_1'], shortText: 'NC' },
      { types: ['postal_code'], longText: '28202' },
    ],
    '100 N Tryon St, Charlotte, NC 28202, USA'
  );
  assert.equal(neu.address, '100 N Tryon St');
  assert.equal(neu.zipCode, '28202');
});

test('shouldSkipPublicGeocoders only when Google already has matches', () => {
  assert.equal(S.shouldSkipPublicGeocoders(true, 3), true);
  assert.equal(S.shouldSkipPublicGeocoders(true, 0), false);
  assert.equal(S.shouldSkipPublicGeocoders(false, 3), false);
});

test('Google-first path does not wait for slow public geocoders', async () => {
  S.resetPlacesApiModeForTests?.();
  const delays = [];
  const sleep = (ms, value) =>
    new Promise((resolve) => {
      delays.push(ms);
      setTimeout(() => resolve(value), ms);
    });

  const start = Date.now();
  const results = await S.fetchAddressSuggestions(
    { q: '2334 Senior Dr' },
    {
      google: async () =>
        sleep(40, {
          suggestions: [
            {
              address: '2334 Senior Drive',
              city: '',
              state: '',
              zipCode: '',
              display: '2334 Senior Drive, Charlotte, NC, USA',
              place_id: 'abc',
              source: 'google',
            },
          ],
        }),
      nominatim: async () => sleep(600, []),
      census: async () => sleep(600, []),
      photon: async () => sleep(600, []),
    }
  );
  const elapsed = Date.now() - start;
  assert.ok(results.length >= 1, 'expected google suggestion');
  assert.equal(results[0].source, 'google');
  assert.ok(elapsed < 250, `expected google-first <250ms, got ${elapsed}ms`);
  assert.ok(!delays.includes(600), 'must not start slow public geocoders when Google hits');
});

test('public geocoders still run when Google returns nothing, and leftover job city is not required', async () => {
  const results = await S.fetchAddressSuggestions(
    { q: '2334 Senior Dr', biasCity: 'Charlotte', biasState: 'NC' },
    {
      google: async () => ({ suggestions: [] }),
      nominatim: async (q) => {
        assert.match(q, /Charlotte/i);
        return [
          {
            address: '2334 Senior Drive',
            city: 'Charlotte',
            state: 'NC',
            zipCode: '28213',
            display: '2334 Senior Drive, Charlotte, NC 28213',
            source: 'nominatim',
          },
        ];
      },
      census: async () => [],
      photon: async () => [],
    }
  );
  assert.equal(results[0].city, 'Charlotte');
  assert.equal(results[0].source, 'nominatim');
});

test('client helpers: 200ms debounce, session tokens, cache, keyboard, query params', () => {
  assert.equal(C.ADDRESS_AUTOCOMPLETE_DEBOUNCE_MS, 200);
  assert.equal(C.ADDRESS_AUTOCOMPLETE_MIN_CHARS, 2);
  const a = C.newPlacesSessionToken();
  const b = C.newPlacesSessionToken();
  assert.match(a, /^[0-9a-f-]{36}$/i);
  assert.notEqual(a, b);

  assert.equal(C.moveActiveSuggestionIndex(-1, 1, 3), 0);
  assert.equal(C.moveActiveSuggestionIndex(0, 1, 3), 1);
  assert.equal(C.moveActiveSuggestionIndex(2, 1, 3), 0);
  assert.equal(C.moveActiveSuggestionIndex(0, -1, 3), 2);

  const cache = C.createSuggestionCache();
  cache.set('k', [{ address: '1' }]);
  assert.equal(cache.get('k')[0].address, '1');
  cache.clear();
  assert.equal(cache.get('k'), null);

  const params = C.buildSuggestQueryParams({
    q: '2334 Senior',
    sessionToken: 'tok-1',
    lat: 35.227,
    lng: -80.843,
    biasCity: 'Charlotte',
    biasState: 'NC',
    biasZip: '28213',
  });
  assert.equal(params.get('q'), '2334 Senior');
  assert.equal(params.get('session_token'), 'tok-1');
  assert.equal(params.get('lat'), '35.227');
  assert.equal(params.get('bias_city'), 'Charlotte');
  assert.equal(params.has('city'), false, 'must not send leftover job city as city=');

  const details = C.buildDetailsQueryParams('ChIJabc', 'tok-1');
  assert.equal(details.get('place_id'), 'ChIJabc');
  assert.equal(details.get('session_token'), 'tok-1');
});

test('page and recurring panel use the shared hook, 200ms debounce, keyboard nav, and session tokens', () => {
  const hook = src('hooks/useAddressAutocomplete.ts');
  assert.match(hook, /ADDRESS_AUTOCOMPLETE_DEBOUNCE_MS/);
  assert.match(hook, /newPlacesSessionToken/);
  assert.match(hook, /buildDetailsQueryParams/);
  assert.match(hook, /requestId !== requestIdRef/);
  assert.match(hook, /ArrowDown/);
  assert.match(hook, /ensureBrowserLocation/);

  const page = src('app/page.tsx');
  assert.match(page, /useAddressAutocomplete/);
  assert.match(page, /ensureBrowserLocation/);
  assert.match(page, /onAddressSuggestKeyDown/);
  assert.match(page, /role="combobox"/);
  assert.match(page, /bias: \{\s*city: profile\.city/s);
  assert.doesNotMatch(page, /params\.set\('city'/);

  const recurring = src('components/RecurringServicesPanel.tsx');
  assert.match(recurring, /useAddressAutocomplete/);
  assert.match(recurring, /addressBias/);
  assert.match(recurring, /role="combobox"/);

  const route = src('app/api/address-autocomplete/route.ts');
  assert.match(route, /session_token/);
  assert.match(route, /bias_city/);
  assert.match(route, /fetchGooglePlaceDetails\(String\(placeId\), sessionToken/);

  const lib = src('lib/address-autocomplete.ts');
  assert.match(lib, /places\.googleapis\.com\/v1\/places:autocomplete/);
  assert.match(lib, /includedRegionCodes: \['us'\]/);
  assert.match(lib, /sessionToken/);
  assert.match(lib, /locationBias/);
  assert.match(lib, /maps\.googleapis\.com\/maps\/api\/place\/autocomplete\/json/);
  assert.match(lib, /subpremise/);
});

test('legacy test script documents Places API (New) and does not print the key', () => {
  const script = src('scripts/test-google-places.mjs');
  assert.match(script, /Places API \(New\)/);
  assert.match(script, /places\.googleapis\.com/);
  assert.match(script, /key\.length/);
  assert.match(script, /key\.slice\(0, 4\)/);
});
