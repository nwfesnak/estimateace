// Run: npm run test:promo-membership — free promo covers membership only, not add-ons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const billing = await jiti.import(path.join(root, 'lib/billing.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

const REQUIRED =
  'Free promo covers the EstimateAce membership only. AI Receptionist and additional crew seats are billed separately at regular price.';

test('shared copy matches the required membership-only sentence', () => {
  assert.equal(billing.PROMO_COVERS_MEMBERSHIP_ONLY, REQUIRED);
});

test('trial signup notice, checkbox, and terms (2 and 2B) use the sentence', () => {
  const trial = src('app/trial/page.tsx');
  assert.match(trial, /PROMO_COVERS_MEMBERSHIP_ONLY/);
  assert.match(trial, /const billingNote = useMemo/);
  assert.match(trial, /\$\{PROMO_COVERS_MEMBERSHIP_ONLY\}/);
  assert.ok(
    trial.includes('{PROMO_COVERS_MEMBERSHIP_ONLY}'),
    'trial page should render the notice in the intro or checkbox',
  );

  const terms = src('app/terms/page.tsx');
  assert.match(terms, /PROMO_COVERS_MEMBERSHIP_ONLY/);
  assert.match(terms, /id="trial-inactivity"/);
  const section2B = terms.slice(terms.indexOf('id="trial-inactivity"'));
  assert.match(section2B, /PROMO_COVERS_MEMBERSHIP_ONLY/);
  assert.match(section2B, /AI Receptionist or additional crew seats/);
});

test('marketing knowledge and website promo/pricing pages use the sentence', () => {
  assert.match(src('lib/marketing-knowledge.ts'), new RegExp(REQUIRED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const file of [
    'website/6-months-free.html',
    'website/2-months-free.html',
    'website/pricing.php',
    'website/index.html',
    'website/index.php',
    'website/marketing-landing.html',
  ]) {
    const text = src(file);
    assert.ok(text.includes(REQUIRED), `${file} should include the membership-only sentence`);
  }
  assert.match(src('website/6-months-free.html'), /full EstimateAce membership access/);
  assert.match(src('website/2-months-free.html'), /full EstimateAce membership access/);
  assert.doesNotMatch(src('website/6-months-free.html'), /full product access/);
  assert.doesNotMatch(src('website/2-months-free.html'), /full product access/);
});

function assertPaidAddonCheckout(label, file) {
  const route = src(file);
  assert.match(route, /allow_promotion_codes:\s*false/);
  assert.doesNotMatch(route, /allow_promotion_codes:\s*true/);
  assert.doesNotMatch(route, /trial_period_days/);
  assert.doesNotMatch(route, /trial_end/);
  assert.doesNotMatch(route, /discounts\s*:/);
  assert.doesNotMatch(route, /coupon\s*:/);
  assert.match(route, /mode:\s*'subscription'/);
}

test('AI Receptionist and crew-seat Checkout charge immediately — no trial, no promo codes', () => {
  assertPaidAddonCheckout('receptionist', 'app/api/receptionist/checkout/route.ts');
  assertPaidAddonCheckout('crew seats', 'app/api/crew/seat-checkout/route.ts');
});

test('membership Checkout may apply a trial to the plan, but not by attaching a coupon to add-ons', () => {
  const membership = src('app/api/billing/checkout/route.ts');
  assert.match(membership, /trial_period_days|cardTrialDaysForPromo/);
  // Membership checkout can still accept promotion codes (scoped in Stripe to the membership product).
  assert.doesNotMatch(src('app/api/billing/start-trial/route.ts'), /getReceptionistAddonPriceId|CREW_SEAT_PURPOSE|RECEPTIONIST_ADDON_PURPOSE/);
});

test('trial inactivity cleanup still excludes paid add-on buyers', () => {
  const sql = src('supabase/trial-inactivity-2026-11.sql');
  assert.match(sql, /crew_seat_subscriptions cs/);
  assert.match(sql, /receptionist_accounts ra/);
});

test('promo/trial users are not blocked from buying add-ons', () => {
  // enforceAppAccess lets trialing owners through; add-on routes use it (no extra trial block).
  const receptionist = src('app/api/receptionist/checkout/route.ts');
  const seats = src('app/api/crew/seat-checkout/route.ts');
  assert.match(receptionist, /enforceAppAccess/);
  assert.match(seats, /enforceAppAccess/);
  assert.doesNotMatch(receptionist, /status === 'trialing'/);
  assert.doesNotMatch(seats, /status === 'trialing'/);
  const billingSrc = src('lib/billing.ts');
  assert.match(billingSrc, /export function hasAppAccess/);
  assert.match(billingSrc, /if \(status === 'trialing'\)/);
});
