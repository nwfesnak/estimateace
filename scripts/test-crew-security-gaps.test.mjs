// Run: npm run test:crew-gaps
// Covers SETTINGS secret stripping for all crew, tab/flag route guards,
// always-on crew data proxy, line-photo storage policy, and the new SQL migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const R = await jiti.import(path.join(root, 'lib/crew-redaction.ts'));
const W = await jiti.import(path.join(root, 'lib/workspace.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

const owner = 'owner-1';
const full = { ownerId: owner, canSeePricing: true, canSeeFinancials: true };
const fullNoCalendar = {
  ...full,
  tabAccess: {
    dashboard: true,
    estimates: true,
    invoices: true,
    newEstimate: true,
    reports: true,
    calendar: false,
    recurring: true,
    receptionist: false,
  },
};

const settingsRow = {
  id: `SETTINGS-${owner}`,
  user_id: owner,
  profile: {
    company: 'Acme Builders',
    slogan: 'Done right',
    logoUrl: 'https://example.com/logo.png',
    phone: '704-555-0100',
    email: 'hello@acme.test',
    address: '1 Main St',
    twoFactorPhone: '5555550100',
    aiPriceMemory: { pine: 4 },
    paymentSettings: { zelle: 'secret@example.com' },
    receptionistBilling: { status: 'active', customerId: 'cus_secret' },
    aiReceptionistSettings: { transferNumber: '+14155552671' },
    _appointments: [{ id: 'a1', at: '2026-12-01T15:00:00.000Z' }],
    emailLeadSummaries: [{ from: 'lead@x.com' }],
  },
};

test('pickCrewCompanyDisplayProfile keeps letterhead and drops secrets', () => {
  const picked = R.pickCrewCompanyDisplayProfile(settingsRow.profile);
  assert.equal(picked.company, 'Acme Builders');
  assert.equal(picked.logoUrl, 'https://example.com/logo.png');
  assert.equal(picked.phone, '704-555-0100');
  assert.equal(picked.twoFactorPhone, undefined);
  assert.equal(picked.aiPriceMemory, undefined);
  assert.equal(picked.paymentSettings, undefined);
  assert.equal(picked.receptionistBilling, undefined);
  assert.equal(picked._appointments, undefined);
  for (const k of R.CREW_ALWAYS_HIDDEN_PROFILE_KEYS) {
    assert.ok(!R.CREW_COMPANY_DISPLAY_PROFILE_KEYS.includes(k), `${k} must not be a display key`);
  }
});

test('redactRow strips SETTINGS secrets even for full-data crew', () => {
  const r = R.redactRow(settingsRow, full);
  assert.equal(r.profile.company, 'Acme Builders');
  assert.equal(r.profile.logoUrl, 'https://example.com/logo.png');
  assert.equal(r.profile.twoFactorPhone, undefined);
  assert.equal(r.profile.aiPriceMemory, undefined);
  assert.equal(r.profile.paymentSettings, undefined);
  assert.equal(r.profile.receptionistBilling, undefined);
  assert.equal(settingsRow.profile.twoFactorPhone, '5555550100', 'source not mutated');
});

test('full-data crew with calendar/receptionist tabs off lose those SETTINGS keys', () => {
  const r = R.redactRow(settingsRow, fullNoCalendar);
  assert.equal(r.profile.company, 'Acme Builders');
  assert.equal(r.profile._appointments, undefined);
  assert.equal(r.profile.aiReceptionistSettings, undefined);
  assert.equal(r.profile.twoFactorPhone, undefined);
});

test('restoreRow puts owner secrets back so full-data crew cannot wipe them', () => {
  const incoming = {
    id: `SETTINGS-${owner}`,
    user_id: owner,
    profile: { company: 'Acme Builders', paymentSettings: { zelle: 'attacker@example.com' } },
  };
  const restored = R.restoreRow(incoming, full, {
    existing: settingsRow,
    ownerSettingsProfile: settingsRow.profile,
    itemIndex: new Map(),
  });
  assert.deepEqual(restored.profile.paymentSettings, { zelle: 'secret@example.com' });
  assert.equal(restored.profile.twoFactorPhone, '5555550100');
  assert.deepEqual(restored.profile.aiPriceMemory, { pine: 4 });
});

test('crewMaySeePricing is true for owners and pricing-enabled crew only', () => {
  assert.equal(W.crewMaySeePricing({ ok: true, ownerUserId: owner, isCrew: false, crew: null }), true);
  assert.equal(
    W.crewMaySeePricing({
      ok: true,
      ownerUserId: owner,
      isCrew: true,
      crew: { can_see_pricing: true, can_see_estimates_and_financials: false },
    }),
    true
  );
  assert.equal(
    W.crewMaySeePricing({
      ok: true,
      ownerUserId: owner,
      isCrew: true,
      crew: { can_see_pricing: false, can_see_estimates_and_financials: true },
    }),
    false
  );
  assert.equal(W.crewMaySeePricing({ ok: false, ownerUserId: null, isCrew: true, reason: 'crew_seat_inactive', crew: {} }), false);
});

test('app always enables the crew data proxy for every crew login', () => {
  const page = src('app/page.tsx');
  assert.match(page, /setCrewDataProxy\(true\)/);
  assert.doesNotMatch(
    page,
    /setCrewDataProxy\(\s*!\(json\.canSeePricing === true && json\.canSeeEstimatesAndFinancials === true\)/
  );
});

test('restoreDocumentForCrewWrite runs for all crew, not only restricted crew', () => {
  const access = src('lib/crew-access.ts');
  const fn = access.slice(access.indexOf('export async function restoreDocumentForCrewWrite'));
  assert.match(fn, /if \(!access\) return row;/);
  assert.doesNotMatch(fn, /if \(!access \|\| crewHasFullDataAccess\(access\)\) return row;/);
});

test('API routes enforce financials / pricing / owner-only billing', () => {
  const receipts = src('app/api/receipts/scan/route.ts');
  assert.match(receipts, /requireFinancials:\s*true/);

  for (const file of ['app/api/ai-quote/route.ts', 'app/api/grok/route.ts', 'app/api/photo-estimate/route.ts']) {
    const s = src(file);
    assert.match(s, /requirePricing:\s*true/, `${file} requires See pricing`);
  }

  const checkout = src('app/api/billing/checkout/route.ts');
  const portal = src('app/api/billing/portal/route.ts');
  for (const [name, s] of [
    ['checkout', checkout],
    ['portal', portal],
  ]) {
    assert.match(s, /resolveWorkspace\(user\.id\)/, `${name} resolves workspace`);
    assert.match(s, /if \(ws\.isCrew\) return crewPermissionDeniedResponse\(\);/, `${name} refuses crew`);
  }
});

test('documents send/checkout still require both pricing and financials flags', () => {
  const send = src('app/api/documents/send/route.ts');
  const pay = src('app/api/payments/job-checkout/route.ts');
  const terms = src('app/api/documents/terms-link/route.ts');
  for (const [name, s] of [
    ['send', send],
    ['job-checkout', pay],
    ['terms-link', terms],
  ]) {
    assert.match(s, /requireFinancials:\s*true/, `${name} requires full data access`);
  }
  const workspace = src('lib/workspace.ts');
  assert.match(workspace, /row\?\.can_see_pricing === true && row\?\.can_see_estimates_and_financials === true/);
});

test('new SQL migration tightens SETTINGS SELECT, adds letterhead RPC, allows line-photo, drops crew deletes', () => {
  const sql = src('supabase/crew-security-gaps-2026-11.sql');
  assert.match(sql, /DO NOT APPLY until Nathan approves/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.crew_company_display\(\)/);
  assert.match(sql, /twoFactorPhone/);
  assert.match(sql, /paymentSettings/);
  assert.match(sql, /aiPriceMemory/);
  assert.match(sql, /receptionistBilling/);
  for (const k of R.CREW_COMPANY_DISPLAY_PROFILE_KEYS) {
    assert.match(sql, new RegExp(`'${k}'`), `RPC lists display key ${k}`);
  }
  // Tightened SELECT: deny SETTINGS, do not grant the SETTINGS id equality from 11 / tab-access
  const selectStart = sql.indexOf('CREATE POLICY "Crew can view owner estimates"');
  const selectEnd = sql.indexOf('DROP POLICY IF EXISTS "Crew can insert owner estimates"');
  assert.ok(selectStart > 0 && selectEnd > selectStart, 'view policy block found');
  const select = sql.slice(selectStart, selectEnd);
  assert.match(select, /id NOT LIKE 'SETTINGS-%'/);
  assert.doesNotMatch(select, /id = 'SETTINGS-' \|\| user_id/);

  assert.match(sql, /media_kind\(name\) IN \('photo', 'video', 'render', 'line-photo'\)/);
  assert.match(sql, /DROP POLICY IF EXISTS "Crew can delete owner estimates"/);
  assert.match(sql, /DROP POLICY IF EXISTS "Crew can delete owner archives"/);
  assert.match(sql, /DROP POLICY IF EXISTS "Crew can delete owner media"/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.crew_company_display\(\) FROM anon/);

  const verify = src('scripts/verify-crew-security-gaps.sql');
  assert.match(verify, /Read-only checks/);
  assert.match(verify, /line-photo/);
});

test('verify script is read-only (no DDL / DML)', () => {
  const verify = src('scripts/verify-crew-security-gaps.sql');
  assert.doesNotMatch(verify, /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/im);
});
