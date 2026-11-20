// Run: npm run test:crew-tabs — per-tab crew permissions, redaction, API, UI, and RLS migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const T = await jiti.import(path.join(root, 'lib/crew-tab-access.ts'));
const R = await jiti.import(path.join(root, 'lib/crew-redaction.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

test('CREW_TABS lists every real workspace tab and defaults all to true for legacy compatibility', () => {
  assert.deepEqual(T.CREW_TAB_KEYS, [
    'dashboard',
    'estimates',
    'invoices',
    'newEstimate',
    'reports',
    'calendar',
    'recurring',
    'receptionist',
  ]);
  assert.equal(T.CREW_TABS.length, 8);
  assert.deepEqual(T.normalizeCrewTabAccess(null), T.DEFAULT_CREW_TAB_ACCESS);
  assert.deepEqual(T.normalizeCrewTabAccess(undefined), T.DEFAULT_CREW_TAB_ACCESS);
  for (const key of T.CREW_TAB_KEYS) {
    assert.equal(T.DEFAULT_CREW_TAB_ACCESS[key], true);
  }
});

test('parseCrewTabAccessPatch and mergeCrewTabAccess ignore unknown keys and non-booleans', () => {
  const patch = T.parseCrewTabAccessPatch({
    dashboard: false,
    invoices: 'yes',
    companyProfile: true,
    reports: false,
  });
  assert.deepEqual(patch, { dashboard: false, reports: false });
  const merged = T.mergeCrewTabAccess(null, patch);
  assert.equal(merged.dashboard, false);
  assert.equal(merged.reports, false);
  assert.equal(merged.estimates, true);
  assert.equal(merged.invoices, true);
});

test('firstAllowedCrewTab falls back to an allowed tab or account (never Company Profile)', () => {
  assert.equal(T.firstAllowedCrewTab({ dashboard: false, estimates: false, invoices: true }), 'invoices');
  assert.equal(
    T.firstAllowedCrewTab(T.createUniformCrewTabAccess(false)),
    'account'
  );
});

test('document classification and crewCanRead/WriteDocumentRow enforce estimates/invoices/newEstimate/reports', () => {
  const est = { id: 'EST-001', documentType: 'estimate', invoiceNumber: 'EST-001' };
  const inv = { id: 'INV-001', documentType: 'invoice', invoiceNumber: 'INV-001' };
  const settings = { id: 'SETTINGS-owner-1', profile: { company: 'Acme' } };

  assert.equal(T.classifyWorkspaceDocumentRow(est), 'estimate');
  assert.equal(T.classifyWorkspaceDocumentRow(inv), 'invoice');
  assert.equal(T.classifyWorkspaceDocumentRow(settings), 'settings');

  // Crew with estimates=false, newEstimate=true cannot read existing estimates, but can write a new EST-*
  const onlyNew = { ...T.createUniformCrewTabAccess(false), newEstimate: true };
  assert.equal(T.crewCanReadDocumentRow(onlyNew, est, 'estimates'), false);
  assert.equal(T.crewCanWriteDocumentRow(onlyNew, est, { isNew: true }), true);
  assert.equal(T.crewCanWriteDocumentRow(T.createUniformCrewTabAccess(false), est, { isNew: false }), false);
  assert.equal(T.crewCanWriteDocumentRow(onlyNew, inv, { isNew: true }), false);

  // Crew with invoices=true, estimates=false can read/write invoices only
  const invOnly = { ...T.createUniformCrewTabAccess(false), invoices: true };
  assert.equal(T.crewCanReadDocumentRow(invOnly, inv, 'estimates'), true);
  assert.equal(T.crewCanReadDocumentRow(invOnly, est, 'estimates'), false);
  assert.equal(T.crewCanWriteDocumentRow(invOnly, inv, { isNew: false }), true);
  assert.equal(T.crewCanWriteDocumentRow(invOnly, est, { isNew: false }), false);

  // Archive table requires reports=true AND financial/doc permission
  assert.equal(T.crewCanReadDocumentRow(invOnly, inv, 'archive-est'), false);
  const reportsAndInv = { ...invOnly, reports: true };
  assert.equal(T.crewCanReadDocumentRow(reportsAndInv, inv, 'archive-est'), true);
  assert.equal(T.crewCanReadDocumentRow(reportsAndInv, est, 'archive-est'), false);
});

test('redaction strips tab-specific SETTINGS fields even for full-access crew when those tabs are denied', () => {
  const fullMoneyNoTabs = {
    canSeePricing: true,
    canSeeFinancials: true,
    tabAccess: {
      ...T.DEFAULT_CREW_TAB_ACCESS,
      calendar: false,
      receptionist: false,
      dashboard: false,
    },
  };
  const settingsRow = {
    id: 'SETTINGS-owner',
    profile: {
      company: 'Acme Roofing',
      _appointments: [{ id: 'a1' }],
      appointmentReminderEnabled: true,
      aiReceptionistSettings: { enabled: true },
      receptionistConfig: { status: 'on' },
      receptionistBilling: { status: 'active' },
      emailLeadSummariesEnabled: true,
      emailLeadSummaries: [{ id: 'l1' }],
      monitoredEmail: 'leads@acme.com',
    },
  };
  const redacted = R.redactRow(settingsRow, fullMoneyNoTabs);
  assert.equal(redacted.profile.company, 'Acme Roofing');
  assert.equal('_appointments' in redacted.profile, false);
  assert.equal('appointmentReminderEnabled' in redacted.profile, false);
  assert.equal('aiReceptionistSettings' in redacted.profile, false);
  assert.equal('receptionistConfig' in redacted.profile, false);
  assert.equal('receptionistBilling' in redacted.profile, false);
  assert.equal('emailLeadSummariesEnabled' in redacted.profile, false);
  assert.equal('emailLeadSummaries' in redacted.profile, false);
  assert.equal('monitoredEmail' in redacted.profile, false);

  // Full-access crew with ALL tabs enabled keeps those SETTINGS fields untouched
  const allTabs = {
    canSeePricing: true,
    canSeeFinancials: true,
    tabAccess: T.DEFAULT_CREW_TAB_ACCESS,
  };
  const untouched = R.redactRow(settingsRow, allTabs);
  assert.deepEqual(untouched, settingsRow);
});

test('server routes enforce per-tab crew permissions', () => {
  for (const [file, pattern] of [
    ['app/api/crew/me/route.ts', /tabAccess/],
    ['app/api/crew/list/route.ts', /tabAccess/],
    ['app/api/crew/invite/route.ts', /tabAccess/],
    ['app/api/crew/update/route.ts', /parseCrewTabAccessPatch/],
    ['app/api/crew/data/[table]/route.ts', /crewCanReadDocumentRow/],
    ['app/api/crew/data/[table]/route.ts', /crewCanWriteDocumentRow/],
    ['app/api/documents/save/route.ts', /crewCanWriteDocumentRow/],
    ['app/api/documents/send/route.ts', /crewCanWriteDocumentRow/],
    ['app/api/documents/terms-link/route.ts', /crewCanWriteDocumentRow/],
    ['app/api/payments/job-checkout/route.ts', /crewCanWriteDocumentRow/],
    ['app/api/recurring/plans/route.ts', /requireTab:\s*\['recurring',\s*'reports'\]/],
    ['app/api/recurring/checkout/route.ts', /crewHasTab\(ws\.tabAccess,\s*'recurring'\)/],
    ['app/api/recurring/send/route.ts', /crewHasTab\(ws\.tabAccess,\s*'recurring'\)/],
    ['app/api/appointments/sync/route.ts', /requireTab:\s*'calendar'/],
    ['app/api/appointment-notify/route.ts', /requireTab:\s*'calendar'/],
    ['app/api/appointment-reminders/send/route.ts', /requireTab:\s*'calendar'/],
    ['app/api/receptionist/route.ts', /requireTab:\s*'receptionist'/],
    ['app/api/receptionist/usage/route.ts', /requireTab:\s*'receptionist'/],
    ['app/api/receptionist/blocklist/route.ts', /requireTab:\s*'receptionist'/],
    ['app/api/receptionist/enable/route.ts', /requireTab:\s*'receptionist'/],
    ['app/api/receptionist/disable/route.ts', /requireTab:\s*'receptionist'/],
    ['app/api/receptionist/sync/route.ts', /requireTab:\s*'receptionist'/],
    ['app/api/receptionist/website-facts/route.ts', /requireTab:\s*'receptionist'/],
    ['app/api/ai-quote/route.ts', /requireTab:\s*\['estimates',\s*'invoices',\s*'newEstimate'\]/],
    ['app/api/photo-estimate/route.ts', /requireTab:\s*\['estimates',\s*'invoices',\s*'newEstimate'\]/],
    ['app/api/job-render/route.ts', /requireTab:\s*\['estimates',\s*'invoices',\s*'newEstimate'\]/],
    ['app/api/translate/route.ts', /requireTab:\s*\['estimates',\s*'invoices',\s*'newEstimate'\]/],
    ['app/api/grok/route.ts', /requireTab:\s*\['estimates',\s*'invoices',\s*'newEstimate'\]/],
    ['app/api/receipts/scan/route.ts', /requireTab:\s*\['estimates',\s*'invoices',\s*'newEstimate',\s*'reports'\]/],
  ]) {
    assert.match(src(file), pattern, `${file} missing ${pattern}`);
  }
});

test('app/page.tsx renders per-tab toggles and enforces crew nav + deep-link redirects', () => {
  const page = src('app/page.tsx');
  assert.match(page, /data-testid="crew-tab-access-panel"/);
  assert.match(page, /crew-tab-toggle-\$\{tab\.key\}/);
  assert.match(page, /Allow all/);
  assert.match(page, /Deny all/);
  assert.match(page, /Company Profile stays owner-only; crew always keep Account\./);
  assert.match(page, /\{hasCrewTab\('dashboard'\) && \(/);
  assert.match(page, /\{hasCrewTab\('estimates'\) && \(/);
  assert.match(page, /\{hasCrewTab\('invoices'\) && \(/);
  assert.match(page, /\{hasCrewTab\('newEstimate'\) && \(/);
  assert.match(page, /\{hasCrewTab\('reports'\) && \(/);
  assert.match(page, /\{hasCrewTab\('calendar'\) && \(/);
  assert.match(page, /data-testid=\{currentCrew \? 'nav-account' : 'nav-profile'\}/);
  assert.match(page, /navigateToAllowedCrewLanding/);
});

test('SQL migration adds tab_access and updates estimates + archive-est RLS policies', () => {
  const sql = src('supabase/crew-tab-access-2026-11.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS tab_access JSONB DEFAULT NULL/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.crew_has_tab\(owner_id uuid, tab_key text\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.crew_has_tab\(uuid, text\) FROM PUBLIC/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.crew_has_tab\(uuid, text\) FROM anon/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.crew_has_tab\(uuid, text\) TO authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.crew_has_tab\(uuid, text\) TO service_role/);
  assert.match(sql, /ON public\.estimates\s+FOR SELECT/);
  assert.match(sql, /ON public\.estimates\s+FOR INSERT/);
  assert.match(sql, /ON public\.estimates\s+FOR UPDATE/);
  assert.match(sql, /ON public\."archive-est"\s+FOR SELECT/);
  assert.match(sql, /public\.crew_has_tab\(user_id, 'reports'\)/);
});
