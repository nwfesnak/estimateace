// Run: npm run test:crew  (fifth security scan: website-facts paywall, +1 forward numbers,
// Connect webhook account check)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const P = await jiti.import(path.join(root, 'lib/phone-forward.ts'));
const G = await jiti.import(path.join(root, 'lib/connect-account-guard.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

// ---- 1. Receptionist website-facts paywall ----
test('website-facts route checks the paywall before reserving AI quota', () => {
  const s = src('app/api/receptionist/website-facts/route.ts');
  const paywall = s.indexOf('enforceAppAccess(user.id)');
  const quota = s.indexOf('reserveAiQuota(');
  const fetchSite = s.indexOf('buildWebsiteBusinessFacts(', s.indexOf('export async function POST'));
  assert.ok(paywall > 0, 'enforceAppAccess call present');
  assert.ok(paywall < quota, 'paywall before quota');
  assert.ok(quota < fetchSite, 'quota before website fetch / AI');
  assert.match(s, /if \(paywall\) return paywall;/);
});

// ---- 2. +1 (US/Canada) call-forward numbers ----
test('forwardDialNumber accepts US and Canada numbers in common formats', () => {
  assert.equal(P.forwardDialNumber('(415) 555-2671'), '+14155552671');
  assert.equal(P.forwardDialNumber('415.555.2671'), '+14155552671');
  assert.equal(P.forwardDialNumber('1-415-555-2671'), '+14155552671');
  assert.equal(P.forwardDialNumber('+1 415 555 2671'), '+14155552671');
  assert.equal(P.forwardDialNumber('+14165552671'), '+14165552671'); // Toronto
  assert.equal(P.forwardDialNumber('604-555-2671'), '+16045552671'); // Vancouver
});

test('forwardDialNumber refuses international, Caribbean, premium and junk numbers', () => {
  for (const bad of [
    '+44 20 7946 0958', // UK
    '+52 55 1234 5678', // Mexico
    '+234 803 123 4567', // Nigeria
    '0044 20 7946 0958', // 00 prefix
    '011 44 20 7946 0958', // US intl prefix → too many digits
    '+1 876 555 1234', // Jamaica
    '809-555-1234', // Dominican Republic
    '+1 284 555 1234', // BVI
    '900-555-1234', // premium
    '976-555-1234', // premium
    '+1 115 555 1234', // invalid area code
    '415 055 1234', // invalid exchange
    '555-1234', // too short
    '+14155552671999', // too long
    '',
    null,
    undefined,
  ]) {
    assert.equal(P.forwardDialNumber(bad), null, `should refuse ${bad}`);
  }
});

test('normalizeForwardNumberInput: empty clears, valid stores +1 E.164, invalid errors', () => {
  assert.deepEqual(P.normalizeForwardNumberInput(''), { ok: true, value: '' });
  assert.deepEqual(P.normalizeForwardNumberInput('   '), { ok: true, value: '' });
  assert.deepEqual(P.normalizeForwardNumberInput('(415) 555-2671'), { ok: true, value: '+14155552671' });
  const bad = P.normalizeForwardNumberInput('+44 20 7946 0958');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /US or Canada/);
});

test('receptionist PATCH validates transferNumber server-side before saving', () => {
  const s = src('app/api/receptionist/route.ts');
  const patch = s.slice(s.indexOf('export async function PATCH'));
  assert.match(patch, /normalizeForwardNumberInput\(body\.transferNumber\)/);
  assert.match(patch, /invalid_forward_number/);
  assert.ok(!/String\(body\.transferNumber\)/.test(patch), 'raw transferNumber no longer stored');
  assert.ok(
    patch.indexOf('normalizeForwardNumberInput') < patch.indexOf('saveReceptionistConfig('),
    'validated before save'
  );
});

test('Twilio voice webhooks only dial US/Canada numbers', () => {
  const voice = src('app/api/webhooks/twilio/voice/route.ts');
  assert.match(voice, /return forwardDialNumber\(phone\);/);
  assert.ok(!/formatPhoneE164/.test(voice));
  assert.ok(!/transferForAi \|\| tenant\.config\.transferNumber/.test(voice), 'no raw fallback');
  const think = src('app/api/webhooks/twilio/voice/think/route.ts');
  assert.equal((think.match(/forwardDialNumber\(session\.transferNumber\)/g) || []).length, 2);
  assert.ok(!/formatPhoneE164/.test(think));
});

test('receptionist settings UI shows the US/Canada hint', () => {
  const s = src('components/AIReceptionist.tsx');
  assert.match(s, /US or Canada numbers only \(\+1, 10 digits\)/);
});

// ---- 3. Stripe Connect webhook: event.account must be the owner's account ----
test('connectAccountMatches requires identical non-empty acct ids', () => {
  assert.equal(G.connectAccountMatches('acct_123ABC', 'acct_123ABC'), true);
  assert.equal(G.connectAccountMatches('acct_123ABC', 'acct_999'), false);
  assert.equal(G.connectAccountMatches('', 'acct_123ABC'), false);
  assert.equal(G.connectAccountMatches('acct_123ABC', null), false);
  assert.equal(G.connectAccountMatches(null, null), false);
  assert.equal(G.connectAccountMatches('acct_1 ', 'acct_1'), true); // trimmed
  assert.equal(G.connectAccountMatches('not-an-acct', 'not-an-acct'), false);
});

test('verifyConnectEventOwner compares against the saved payment_accounts row', async () => {
  const OWNER = '11111111-1111-4111-8111-111111111111';
  const saved = (id) => async (uid) => {
    assert.equal(uid, OWNER);
    return id === undefined ? null : { stripe_account_id: id };
  };
  assert.deepEqual(await G.verifyConnectEventOwner('acct_OWN', OWNER, saved('acct_OWN')), { ok: true });
  assert.deepEqual(await G.verifyConnectEventOwner('acct_EVIL', OWNER, saved('acct_OWN')), {
    ok: false,
    reason: 'account_mismatch',
  });
  assert.deepEqual(await G.verifyConnectEventOwner('acct_EVIL', OWNER, saved(undefined)), {
    ok: false,
    reason: 'no_saved_account',
  });
  assert.deepEqual(await G.verifyConnectEventOwner('acct_EVIL', OWNER, saved(null)), {
    ok: false,
    reason: 'no_saved_account',
  });
  assert.deepEqual(await G.verifyConnectEventOwner(null, OWNER, saved('acct_OWN')), {
    ok: false,
    reason: 'missing_event_account',
  });
  assert.deepEqual(await G.verifyConnectEventOwner('acct_OWN', '', saved('acct_OWN')), {
    ok: false,
    reason: 'missing_owner',
  });
});

test('Connect webhook checks the account before every paid/active/cancel write', () => {
  const s = src('app/api/payments/connect/webhook/route.ts');
  const guardBefore = (call) => {
    const at = s.indexOf(call);
    assert.ok(at > 0, `${call} present`);
    const guard = s.lastIndexOf('eventIsFromOwnersAccount(', at);
    assert.ok(guard > 0 && at - guard < 600, `guard right before ${call}`);
  };
  guardBefore('markDocumentPaidFromJobCheckout(session');
  guardBefore('markRecurringActiveFromCheckout(session)');
  guardBefore("event.type === 'invoice.paid') {");
  guardBefore("event.type === 'customer.subscription.deleted' || sub.status");
  assert.match(s, /ignored event not from owner/);
});
