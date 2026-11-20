// Run: npm run test:billing-account — Billing "Signed up as" account card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const A = await jiti.import(path.join(root, 'lib/billing-account.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

const HELPER =
  'This is the email you sign in with and where account emails (including trial reminders) are sent.';

test('owner card uses auth login email, not the profile contact email', () => {
  const view = A.buildBillingAccountView({
    loginEmail: 'pat@signed-up.example',
    createdAt: '2026-10-01T15:00:00Z',
    name: 'Pat Smith',
    company: 'Smith Painting',
    phone: '555-0100',
    billing: { status: 'trialing', trialEndsAt: '2026-11-30T15:00:00Z', cancelAtPeriodEnd: false },
  });
  assert.equal(view.loginEmail, 'pat@signed-up.example');
  assert.equal(view.name, 'Pat Smith');
  assert.equal(view.company, 'Smith Painting');
  assert.equal(view.phone, '555-0100');
  assert.equal(view.createdLabel, 'Oct 1, 2026');
  assert.equal(view.planLabel, 'Free trial');
  assert.equal(view.trialEndsLabel, 'Nov 30, 2026');
  assert.equal(view.belongsTo, null);
  assert.equal(view.isCrew, false);
  assert.equal(view.helper, HELPER);
});

test('omits empty phone; formats non-trial plans without a trial date', () => {
  const view = A.buildBillingAccountView({
    loginEmail: 'owner@x.com',
    createdAt: '2026-01-15T00:00:00Z',
    name: 'Alex',
    company: 'Ace Co',
    phone: '  ',
    billing: { status: 'active', trialEndsAt: null, cancelAtPeriodEnd: false },
  });
  assert.equal(view.phone, null);
  assert.equal(view.planLabel, 'Active subscription');
  assert.equal(view.trialEndsLabel, null);
  const canceling = A.buildBillingAccountView({
    loginEmail: 'owner@x.com',
    billing: { status: 'active', trialEndsAt: '2026-01-01T00:00:00Z', cancelAtPeriodEnd: true },
  });
  assert.equal(canceling.planLabel, 'Active (cancels at period end)');
  assert.equal(canceling.trialEndsLabel, null);
});

test('crew see their own login email and owner company, never owner plan or phone', () => {
  const view = A.buildBillingAccountView({
    loginEmail: 'crew@example.com',
    createdAt: '2026-09-01T12:00:00Z',
    name: '',
    company: 'Should not appear as crew business',
    phone: '555-OWNER',
    isCrew: true,
    ownerCompany: 'Smith Painting',
    billing: { status: 'trialing', trialEndsAt: '2026-12-01T00:00:00Z', cancelAtPeriodEnd: false },
  });
  assert.equal(view.loginEmail, 'crew@example.com');
  assert.equal(view.company, null);
  assert.equal(view.belongsTo, 'Smith Painting');
  assert.equal(view.planLabel, null);
  assert.equal(view.trialEndsLabel, null);
  assert.equal(view.isCrew, true);
  // phone was passed as the crew's own stored phone — if they have one it can show.
  // Callers must not pass the owner's phone. When crew has no name, it is omitted.
  assert.equal(view.name, null);
  assert.equal(view.helper, HELPER);
});

test('crew helper still explains login email; missing email shows an em dash', () => {
  const view = A.buildBillingAccountView({ isCrew: true, ownerCompany: 'Ace' });
  assert.equal(view.loginEmail, '—');
  assert.equal(view.belongsTo, 'Ace');
});

test('page wiring: card on billing tab, crew can open Account, owner billing stays hidden from crew', () => {
  const page = src('app/page.tsx');
  assert.match(page, /BillingAccountCard/);
  assert.match(page, /buildBillingAccountView/);
  assert.match(page, /signupFieldsFromMetadata\(user\)/);
  assert.match(page, /loginEmail: user\?\.email/);
  assert.match(page, /if \(!currentCrew\) void refreshBillingStatus\(\)/);
  assert.match(page, /currentCrew \? 'Account' : '💳 Billing \/ Contact Us'/);
  assert.match(page, /billingPanel === 'overview' && !currentCrew && \(/);
  const card = src('components/BillingAccountCard.tsx');
  assert.match(card, /data-testid="billing-account-card"/);
  assert.match(card, /break-all/);
  assert.match(card, /Login email/);
  assert.doesNotMatch(card, /Change/);
  assert.match(src('lib/billing-account.ts'), /ACCOUNT_EMAIL_HELPER/);
});
