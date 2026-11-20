import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env.local');
const TEST_QUERY = '2334 Senior Drive Charlotte NC';

function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

const env = loadEnv(envPath);
const key = env.GOOGLE_PLACES_API_KEY;

console.log('EstimateAce — Google Places API check\n');

if (!key) {
  console.error('❌ GOOGLE_PLACES_API_KEY is not set in .env.local');
  console.error('\nAdd this line to .env.local, then restart `npm run dev`:');
  console.error('GOOGLE_PLACES_API_KEY=AIza...your_key_here');
  console.error('\nFor production, also add the same variable in Vercel → Settings → Environment Variables, then redeploy.');
  console.error('\nFor the faster Places API (New) path, enable "Places API (New)" in Google Cloud');
  console.error('and allow it on the key if the key is API-restricted. The app falls back to legacy Autocomplete.');
  process.exit(1);
}

console.log(`✓ Key found (${key.length} chars, starts with ${key.slice(0, 4)}...)`);

async function tryPlacesNew() {
  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask':
        'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
    },
    body: JSON.stringify({
      input: TEST_QUERY,
      includedRegionCodes: ['us'],
      languageCode: 'en',
    }),
  });
  const data = await res.json().catch(() => ({}));
  const text = String(data?.suggestions?.[0]?.placePrediction?.text?.text || '').trim();
  return { ok: res.ok && !!text, status: res.status, text, error: data?.error?.message || data?.error_message };
}

async function tryLegacy() {
  const url =
    'https://maps.googleapis.com/maps/api/place/autocomplete/json' +
    `?input=${encodeURIComponent(TEST_QUERY)}` +
    '&types=address' +
    '&components=country:us' +
    `&key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const data = await res.json();
  const ok = data.status === 'OK' && Array.isArray(data.predictions) && data.predictions.length > 0;
  return {
    ok,
    status: data.status || res.status,
    text: data.predictions?.[0]?.description,
    error: data.error_message,
    placeId: data.predictions?.[0]?.place_id,
  };
}

const neu = await tryPlacesNew();
if (neu.ok) {
  console.log(`✓ Places API (New) autocomplete OK — top match: ${neu.text}`);
} else {
  console.warn(`⚠ Places API (New) not available (${neu.status}${neu.error ? `: ${neu.error}` : ''}).`);
  console.warn('  Enable "Places API (New)" in Google Cloud → APIs & Services → Library.');
  console.warn('  If the key is restricted, add "Places API (New)" to the API list.');
  console.warn('  EstimateAce will fall back to the legacy Autocomplete API.');
}

const legacy = await tryLegacy();
if (legacy.ok) {
  console.log(`✓ Legacy Autocomplete OK — top match: ${legacy.text}`);
  if (legacy.placeId) {
    const detailsUrl =
      'https://maps.googleapis.com/maps/api/place/details/json' +
      `?place_id=${encodeURIComponent(legacy.placeId)}` +
      '&fields=address_components,formatted_address' +
      `&key=${encodeURIComponent(key)}`;
    const detailsRes = await fetch(detailsUrl);
    const details = await detailsRes.json();
    if (details.status === 'OK') {
      console.log(`✓ Place details OK — ${details.result?.formatted_address || 'formatted address returned'}`);
    } else {
      console.warn(`⚠ Place details returned: ${details.status}`);
      if (details.error_message) console.warn(`  ${details.error_message}`);
    }
  }
}

if (neu.ok || legacy.ok) {
  console.log('\nGoogle Places is configured correctly for EstimateAce.');
  if (!neu.ok) {
    console.log('Optional: enable Places API (New) for faster, session-based autocomplete.');
  }
  process.exit(0);
}

console.error(`❌ Google Places test failed: ${legacy.status}`);
if (legacy.error) console.error(`   ${legacy.error}`);
console.error('\nCommon fixes:');
console.error('  1. Enable "Places API" and/or "Places API (New)" in Google Cloud → APIs & Services → Library');
console.error('  2. Link billing on the Google Cloud project');
console.error('  3. If the key is restricted, allow those APIs. For Vercel server calls, Application restrictions should be None (not HTTP referrer).');
process.exit(1);
