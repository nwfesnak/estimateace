/**
 * Sanity check for lib/local-date.ts.
 * Run: TZ=America/New_York npx tsx scripts/check-local-date.ts
 */
import assert from 'node:assert/strict';
import { dateKeyInTimeZone, toLocalDateKey, parseDateOnly, todayDateKey } from '../lib/local-date';

// 9:30 PM Eastern on Nov 18, 2026 is already 02:30 UTC on Nov 19.
const evening = new Date('2026-11-18T21:30:00-05:00');
assert.equal(evening.toISOString().slice(0, 10), '2026-11-19', 'old UTC derivation is a day ahead');
assert.equal(dateKeyInTimeZone(evening, 'America/New_York'), '2026-11-18');
assert.equal(dateKeyInTimeZone(evening), '2026-11-18', 'default zone is America/New_York');
assert.equal(dateKeyInTimeZone(evening, 'America/Los_Angeles'), '2026-11-18');
assert.equal(dateKeyInTimeZone(evening, 'Not/AZone'), '2026-11-18', 'bad zone falls back to Eastern');
// 11:59 PM ET last day of year, and summer (EDT) evening
assert.equal(dateKeyInTimeZone(new Date('2026-12-31T23:59:00-05:00')), '2026-12-31');
assert.equal(dateKeyInTimeZone(new Date('2026-07-04T22:00:00-04:00')), '2026-07-04');

if (process.env.TZ === 'America/New_York') {
  assert.equal(toLocalDateKey(evening), '2026-11-18');
}

// Stored date-only strings must not shift a day when read back.
const jan1 = parseDateOnly('2026-01-01')!;
assert.equal(jan1.getFullYear(), 2026);
assert.equal(jan1.getMonth(), 0);
assert.equal(jan1.getDate(), 1);
assert.equal(toLocalDateKey(jan1), '2026-01-01');
assert.equal(parseDateOnly(''), null);
assert.equal(parseDateOnly('garbage'), null);

// Server path (no window): uses America/New_York
assert.match(todayDateKey(), /^\d{4}-\d{2}-\d{2}$/);

console.log('local-date checks passed');
