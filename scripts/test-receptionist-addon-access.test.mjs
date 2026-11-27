// Run: npm run test:receptionist — AI Receptionist add-on payment gating.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const billing = await jiti.import(path.join(root, 'lib/receptionist-billing.ts'));
const {
  receptionistAddonHasAccess,
  receptionistAddonPaymentRequiredPayload,
  receptionistEnabledFlagsOff,
  RECEPTIONIST_ADDON_AMOUNT_DISPLAY,
} = billing;
const src = (p) => readFileSync(path.join(root, p), 'utf8');
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const past = new Date(Date.now() - 7 * 86400000).toISOString();

test('no billing / empty / failed payment = no access (fail closed, no past_due grace)', () => {
  assert.equal(receptionistAddonHasAccess(null), false);
  assert.equal(receptionistAddonHasAccess(undefined), false);
  assert.equal(receptionistAddonHasAccess({}), false);
  assert.equal(receptionistAddonHasAccess({ status: 'incomplete' }), false);
  assert.equal(receptionistAddonHasAccess({ status: 'unpaid' }), false);
  assert.equal(receptionistAddonHasAccess({ status: 'paused' }), false);
  assert.equal(receptionistAddonHasAccess({ status: 'past_due', currentPeriodEnd: future }), false);
  assert.equal(receptionistAddonHasAccess({ status: 'past_due' }), false);
});

test('active and Stripe add-on trialing have access', () => {
  assert.equal(receptionistAddonHasAccess({ status: 'active' }), true);
  assert.equal(receptionistAddonHasAccess({ status: 'active', currentPeriodEnd: past }), true);
  assert.equal(receptionistAddonHasAccess({ status: 'trialing', currentPeriodEnd: future }), true);
});

test('canceled / cancel-at-period-end keep access only through the already-paid period', () => {
  assert.equal(receptionistAddonHasAccess({ status: 'canceled', currentPeriodEnd: future }), true);
  assert.equal(receptionistAddonHasAccess({ status: 'canceled', currentPeriodEnd: past }), false);
  assert.equal(receptionistAddonHasAccess({ status: 'canceled' }), false);
  assert.equal(
    receptionistAddonHasAccess({ status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: future }),
    true
  );
  // Immediate cancel stores ended_at as currentPeriodEnd (in the past / now) — no access.
  assert.equal(
    receptionistAddonHasAccess({ status: 'canceled', currentPeriodEnd: new Date().toISOString() }),
    false
  );
});

test('pay-first payload matches enable / PATCH / test-call / settings 402 body', () => {
  const payload = receptionistAddonPaymentRequiredPayload();
  assert.equal(payload.needsPayment, true);
  assert.equal(payload.amountDisplay, RECEPTIONIST_ADDON_AMOUNT_DISPLAY);
  assert.match(payload.error, /paid add-on/);
  assert.match(payload.error, /\$49\.99/);
});

test('loss of access turns off both receptionistConfig.enabled and aiReceptionist.enabled', () => {
  const patch = receptionistEnabledFlagsOff({
    company: 'Acme',
    receptionistConfig: {
      enabled: true,
      status: 'active',
      twilio: { phoneNumber: '+15551212' },
    },
    aiReceptionist: { enabled: true, greeting: 'Hi' },
  });
  assert.equal(patch.receptionistConfig.enabled, false);
  assert.equal(patch.receptionistConfig.status, 'disabled');
  assert.equal(patch.receptionistConfig.twilio.phoneNumber, '+15551212');
  assert.equal(patch.aiReceptionist.enabled, false);
  assert.equal(patch.aiReceptionist.greeting, 'Hi');
  const noLine = receptionistEnabledFlagsOff({
    receptionistConfig: { enabled: true, status: 'active' },
  });
  assert.equal(noLine.receptionistConfig.status, 'none');
  assert.deepEqual(receptionistEnabledFlagsOff({}), {});
});

test('upsertReceptionistAddonFromStripe applies both flag-off helper when access is lost', () => {
  const s = src('lib/receptionist-billing.ts');
  assert.match(s, /status === 'past_due'/);
  assert.match(s, /receptionistEnabledFlagsOff\(prev\)/);
  assert.doesNotMatch(
    s,
    /status === 'active' \|\| status === 'trialing' \|\| status === 'past_due'/
  );
});

test('enable route returns the shared 402 pay-first payload when not entitled', () => {
  const s = src('app/api/receptionist/enable/route.ts');
  assert.match(s, /resolveReceptionistAddonAccess/);
  assert.match(s, /receptionistAddonPaymentRequiredPayload\(\)/);
  assert.match(s, /status:\s*402/);
});

test('PATCH /api/receptionist never persists enabled:true without access; OFF is allowed', () => {
  const s = src('app/api/receptionist/route.ts');
  const patch = s.slice(s.indexOf('export async function PATCH'), s.indexOf('export async function POST'));
  assert.match(patch, /resolveReceptionistAddonAccess/);
  assert.match(patch, /next\.enabled = false/);
  assert.match(patch, /receptionistAddonPaymentRequiredPayload/);
  assert.match(patch, /status:\s*402/);
  // Turning off does not require entitlement
  assert.match(patch, /if \(next\.enabled\) \{/);
});

test('in-app test call POST /api/receptionist requires add-on and returns the same 402', () => {
  const s = src('app/api/receptionist/route.ts');
  const post = s.slice(s.indexOf('export async function POST'));
  assert.match(post, /resolveReceptionistAddonAccess\(ws\.ownerUserId\)/);
  assert.match(post, /receptionistAddonPaymentRequiredPayload\(\)/);
  assert.match(post, /status:\s*402/);
  const payIdx = post.indexOf('receptionistAddonPaymentRequiredPayload');
  const quotaIdx = post.indexOf('reserveAiQuota');
  assert.ok(payIdx > 0 && quotaIdx > payIdx, 'add-on check should run before consuming AI quota');
});

test('SETTINGS write API refuses enabled:true without access and always allows OFF', () => {
  const s = src('app/api/receptionist/settings/route.ts');
  assert.match(s, /requestedEnabled/);
  assert.match(s, /resolveReceptionistAddonAccess/);
  assert.match(s, /enabled = false/);
  assert.match(s, /receptionistAddonPaymentRequiredPayload/);
  assert.match(s, /status:\s*402/);
  assert.match(s, /aiReceptionist: settings/);
  // Disabled path does not require entitlement
  assert.match(s, /if \(enabled\) \{/);
});

test('saveReceptionistData goes through the settings API, not a direct SETTINGS upsert', () => {
  const page = src('app/page.tsx');
  const fn = page.slice(page.indexOf('const saveReceptionistData = async'), page.indexOf('const syncAppointmentsToServer'));
  assert.match(fn, /\/api\/receptionist\/settings/);
  assert.doesNotMatch(fn, /supabase\.from\('estimates'\)\.upsert/);
  assert.match(fn, /needsPayment/);
  assert.match(fn, /setReceptionistSettings\(\(prev\) => \(\{ \.\.\.prev, enabled: false \}\)\)/);
  assert.match(fn, /if \(currentCrew\) \{/);
});

test('UI blocks turning the AI answering toggle ON when unpaid and shows subscribe prompt', () => {
  const s = src('components/AIReceptionist.tsx');
  assert.match(s, /if \(on && !addonActive\)/);
  assert.match(s, /id="receptionist-subscribe"/);
  assert.match(s, /AI Receptionist is not subscribed yet/);
  assert.match(s, /Subscribe · \$\{addonAmountDisplay\}\/mo/);
  // Auto-enable requires a paid add-on (a leftover "active" line is not enough)
  assert.match(s, /if \(!addonActive \|\| !linePhone \|\| settings\.enabled\) return;/);
  assert.doesNotMatch(s, /!addonActive && lineStatus !== 'active'/);
});

test('client hasAiReceptionistAddon treats past_due as unpaid', () => {
  const page = src('app/page.tsx');
  const fn = page.slice(page.indexOf('const hasAiReceptionistAddon'), page.indexOf('const showReceptionistLeadsOnDashboard'));
  assert.match(fn, /status === 'past_due'/);
  assert.match(fn, /return false/);
  assert.doesNotMatch(fn, /status === 'active' \|\| status === 'trialing' \|\| status === 'past_due'/);
});

test('SMS webhook logs the inbound lead but does not auto-reply when the add-on is inactive', () => {
  const s = src('app/api/webhooks/twilio/sms/route.ts');
  assert.match(s, /loadReceptionistBilling/);
  assert.match(s, /receptionistAddonHasAccess/);
  const leadIdx = s.indexOf('appendReceptionistLead');
  const unpaidIdx = s.indexOf('if (!receptionistAddonHasAccess(billing))');
  const emptyIdx = s.indexOf('return emptyTwiml();', unpaidIdx);
  assert.ok(leadIdx > 0 && unpaidIdx > leadIdx, 'lead should be saved before the unpaid check');
  assert.ok(emptyIdx > unpaidIdx, 'unpaid path should return empty TwiML (no auto-reply)');
  const replyIdx = s.indexOf('Thanks for texting');
  assert.ok(replyIdx > unpaidIdx, 'paid auto-reply comes after the unpaid return');
});
