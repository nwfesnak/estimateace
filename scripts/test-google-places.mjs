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
  process.exit(1);
}

console.log(`✓ Key found (${key.length} chars, starts with ${key.slice(0, 4)}...)`);

const url =
  'https://maps.googleapis.com/maps/api/place/autocomplete/json' +
  `?input=${encodeURIComponent(TEST_QUERY)}` +
  '&types=address' +
  '&components=country:us' +
  `&key=${encodeURIComponent(key)}`;

const res = await fetch(url);
const data = await res.json();

if (data.status === 'OK' && Array.isArray(data.predictions) && data.predictions.length > 0) {
  console.log(`✓ Autocomplete OK — ${data.predictions.length} result(s) for "${TEST_QUERY}"`);
  console.log(`  Top match: ${data.predictions[0].description}`);
  const placeId = data.predictions[0].place_id;
  if (placeId) {
    const detailsUrl =
      'https://maps.googleapis.com/maps/api/place/details/json' +
      `?place_id=${encodeURIComponent(placeId)}` +
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
  console.log('\nGoogle Places is configured correctly for EstimateAce.');
  process.exit(0);
}

console.error(`❌ Google Places test failed: ${data.status || res.status}`);
if (data.error_message) {
  console.error(`   ${data.error_message}`);
}
console.error('\nCommon fixes:');
console.error('  1. Enable "Places API" in Google Cloud → APIs & Services → Library');
console.error('  2. Link billing on the Google Cloud project');
console.error('  3. If the key is restricted, allow Places API and your app URL (or no restrictions while testing)');
process.exit(1);