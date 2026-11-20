// Run: npm run test:trial-inactivity — inactive 60-day trial: warning, export, deletion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const T = await jiti.import(path.join(root, 'lib/trial-inactivity.ts'));
const R = await jiti.import(path.join(root, 'lib/trial-inactivity-runner.ts'));
const X = await jiti.import(path.join(root, 'lib/trial-inactivity-export.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

const DAY = 86400000;
const NOW = new Date('2026-12-31T15:00:00Z');
const ago = (d) => new Date(NOW.getTime() - d * DAY).toISOString();
const UID = 'aaaaaaaa-1111-4111-8111-111111111111';
const cand = (inactive, over = {}) => ({
  user_id: UID,
  email: 'pat@example.com',
  full_name: 'Pat Smith',
  signup_offer: '2mo',
  status: 'trialing',
  stripe_customer_id: 'cus_1',
  stripe_subscription_id: 'sub_1',
  last_active_at: ago(inactive),
  ...over,
});
const cycle = (over = {}) => ({
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  user_id: UID,
  last_active_at: ago(20),
  warning_sent_at: null,
  export_sent_at: null,
  deleted_at: null,
  cleared_at: null,
  attempts: 0,
  ...over,
});

test('policy: warn at 20 days, delete at 30 only with ≥10 days notice, sign-in clears', () => {
  const d = (c, cy) => T.decideInactivityAction(c, cy, NOW);
  assert.equal(d(cand(19), null).action, 'none');
  const w = d(cand(20), null);
  assert.equal(w.action, 'warn');
  assert.equal(w.deleteAfter, new Date(NOW.getTime() + 10 * DAY).toISOString());
  // Warned 5 days ago (inactive 25) → wait.
  assert.equal(d(cand(25), cycle({ last_active_at: ago(25), warning_sent_at: ago(5) })).action, 'wait');
  // Warned 10 days ago, inactive 30 → export then delete.
  assert.equal(d(cand(30), cycle({ last_active_at: ago(30), warning_sent_at: ago(10) })).action, 'export_and_delete');
  // Cron was down: first seen at 45 days → warning now, never straight to deletion.
  assert.equal(d(cand(45), null).action, 'warn');
  assert.equal(d(cand(45), cycle({ last_active_at: ago(45), warning_sent_at: ago(3) })).action, 'wait');
  // Signed in after the warning → clear.
  assert.deepEqual(d(cand(21, { last_active_at: ago(1) }), cycle({ last_active_at: ago(30), warning_sent_at: ago(9) })), {
    action: 'clear',
    reason: 'signed_in',
  });
  // No longer a candidate (signed in / paid / crew / closed) → clear.
  assert.deepEqual(d(null, cycle({ warning_sent_at: ago(2) })), { action: 'clear', reason: 'not_eligible' });
  // Export already confirmed, deletion failed earlier → delete (no second export).
  assert.equal(d(cand(31), cycle({ last_active_at: ago(31), warning_sent_at: ago(11), export_sent_at: ago(1) })).action, 'delete');
  // No usable email → never warned → never deleted.
  assert.equal(d(cand(60, { email: '' }), null).action, 'none');
  // Warning row exists but the send failed → retry the warning, not deletion.
  assert.equal(d(cand(35), cycle({ last_active_at: ago(35) })).action, 'warn');
  assert.equal(d(null, null).action, 'none');
});

test('offers default to the 60-day launch-promotion trial', () => {
  assert.deepEqual(T.parseOffers(undefined), ['2mo']);
  assert.deepEqual(T.parseOffers('2mo, 6mo,bogus'), ['2mo', '6mo']);
});

function fakeDeps({ candidates = [], cycles = [], paid = false, exportOk = true, deleteOk = true, warnOk = true } = {}) {
  const calls = [];
  const rows = new Map(cycles.map((c) => [c.id, { ...c }]));
  let n = 0;
  return {
    calls,
    rows,
    deps: {
      now: () => NOW,
      listCandidates: async () => candidates,
      listOpenCycles: async () => [...rows.values()].filter((r) => !r.cleared_at && !r.deleted_at),
      createCycle: async (userId, lastActiveAt) => {
        const row = cycle({ id: `cccccccc-0000-4000-8000-00000000000${n++}`, user_id: userId, last_active_at: lastActiveAt });
        rows.set(row.id, row);
        calls.push(['create', userId]);
        return row;
      },
      updateCycle: async (id, patch) => {
        Object.assign(rows.get(id), patch);
        calls.push(['update', Object.keys(patch).sort().join(',')]);
      },
      confirmUnpaidTrial: async () => (calls.push(['stripe']), paid ? { ok: false, reason: 'paid' } : { ok: true }),
      sendWarning: async () => (calls.push(['warn']), warnOk ? { ok: true, id: 'em_w' } : { ok: false, error: 'resend down' }),
      sendExport: async () => (calls.push(['export']), exportOk ? { ok: true, id: 'em_x', prefix: 'p', expiresAt: ago(-30) } : { ok: false, error: 'boom' }),
      deleteAccount: async () => (calls.push(['delete']), deleteOk ? { ok: true } : { ok: false, error: 'stripe' }),
      purgeExpiredExports: async () => (calls.push(['purge']), 0),
    },
  };
}

test('runner: dry-run plans but never writes or sends', async () => {
  const f = fakeDeps({ candidates: [cand(22)], cycles: [] });
  const r = await R.runTrialInactivity(f.deps, { dryRun: true });
  assert.equal(r.counts.warn, 1);
  assert.deepEqual(f.calls, []);
  assert.equal(r.plan[0].user, UID.slice(0, 8));
});

test('runner: warning creates the cycle first, then records the send', async () => {
  const f = fakeDeps({ candidates: [cand(22)] });
  const r = await R.runTrialInactivity(f.deps, { dryRun: false });
  assert.equal(r.done.warned, 1);
  assert.deepEqual(f.calls.map((c) => c[0]).slice(0, 3), ['create', 'warn', 'update']);
  const row = [...f.rows.values()][0];
  assert.equal(row.warning_sent_at, NOW.toISOString());
  // Second run the same day: open cycle exists → wait, no second email.
  const again = await R.runTrialInactivity(f.deps, { dryRun: false });
  assert.equal(again.counts.wait, 1);
  assert.equal(f.calls.filter((c) => c[0] === 'warn').length, 1);
});

test('runner: failed warning is recorded and retried, never escalates', async () => {
  const f = fakeDeps({ candidates: [cand(40)], warnOk: false });
  const r = await R.runTrialInactivity(f.deps, { dryRun: false });
  assert.equal(r.done.warned, 0);
  assert.match([...f.rows.values()][0].last_error, /warning: resend down/);
  assert.ok(!f.calls.some((c) => c[0] === 'export' || c[0] === 'delete'));
});

test('runner: export email must succeed before deletion', async () => {
  const cy = cycle({ last_active_at: ago(31), warning_sent_at: ago(11) });
  const bad = fakeDeps({ candidates: [cand(31)], cycles: [cy], exportOk: false });
  const r1 = await R.runTrialInactivity(bad.deps, { dryRun: false });
  assert.equal(r1.done.deleted, 0);
  assert.ok(!bad.calls.some((c) => c[0] === 'delete'));

  const good = fakeDeps({ candidates: [cand(31)], cycles: [cy] });
  const r2 = await R.runTrialInactivity(good.deps, { dryRun: false });
  assert.equal(r2.done.exported, 1);
  assert.equal(r2.done.deleted, 1);
  const order = good.calls.map((c) => c[0]).filter((c) => ['stripe', 'export', 'delete'].includes(c));
  assert.deepEqual(order, ['stripe', 'export', 'delete']);
  const row = good.rows.get(cy.id);
  assert.ok(row.export_sent_at && row.deleted_at);
});

test('runner: a paid customer is never exported or deleted', async () => {
  const cy = cycle({ last_active_at: ago(31), warning_sent_at: ago(11) });
  const f = fakeDeps({ candidates: [cand(31)], cycles: [cy], paid: true });
  const r = await R.runTrialInactivity(f.deps, { dryRun: false });
  assert.equal(r.done.cleared, 1);
  assert.ok(!f.calls.some((c) => c[0] === 'export' || c[0] === 'delete'));
});

test('runner: deletion failure retries next day without a second export', async () => {
  const cy = cycle({ last_active_at: ago(31), warning_sent_at: ago(11) });
  const f = fakeDeps({ candidates: [cand(31)], cycles: [cy], deleteOk: false });
  await R.runTrialInactivity(f.deps, { dryRun: false });
  assert.ok(f.rows.get(cy.id).export_sent_at);
  assert.match(f.rows.get(cy.id).last_error, /delete: stripe/);
  f.deps.deleteAccount = async () => (f.calls.push(['delete2']), { ok: true });
  const r = await R.runTrialInactivity(f.deps, { dryRun: false });
  assert.equal(r.done.deleted, 1);
  assert.equal(f.calls.filter((c) => c[0] === 'export').length, 1);
});

test('runner: signing in clears the pending warning', async () => {
  const cy = cycle({ last_active_at: ago(25), warning_sent_at: ago(5) });
  const f = fakeDeps({ candidates: [], cycles: [cy] });
  const r = await R.runTrialInactivity(f.deps, { dryRun: false });
  assert.equal(r.done.cleared, 1);
  assert.ok(f.rows.get(cy.id).cleared_at);
});

test('runner: caps exports per run', async () => {
  const ids = [1, 2, 3, 4].map((i) => `aaaaaaaa-1111-4111-8111-00000000000${i}`);
  const f = fakeDeps({
    candidates: ids.map((id) => cand(31, { user_id: id })),
    cycles: ids.map((id, i) => cycle({ id: `bbbbbbbb-2222-4222-8222-00000000000${i}`, user_id: id, last_active_at: ago(31), warning_sent_at: ago(11) })),
  });
  const r = await R.runTrialInactivity(f.deps, { dryRun: false, maxExportsPerRun: 2 });
  assert.equal(r.done.exported, 2);
  assert.equal(r.done.deleted, 2);
});

test('emails: warning has the deadline + sign-in link; export has links + expiry', () => {
  const w = T.buildWarningEmail({
    name: 'Pat Smith',
    email: 'pat@example.com',
    lastActiveAt: '2026-11-01T15:00:00Z',
    deleteAfter: '2026-12-01T15:00:00Z',
    signInUrl: 'https://app.estimateace.com/login',
  });
  assert.equal(w.subject, 'Sign in by December 1, 2026 to keep your EstimateAce trial account');
  assert.match(w.text, /Hi Pat,/);
  assert.match(w.text, /https:\/\/app\.estimateace\.com\/login/);
  assert.match(w.text, /card will not be charged/);
  assert.match(w.html, /Sign in to keep my account/);
  const x = T.buildExportEmail({
    name: '',
    email: 'pat@example.com',
    warningSentAt: '2026-11-21T15:00:00Z',
    zipUrl: 'https://x/zip?token=1',
    filesIndexUrl: 'https://x/files',
    fileCount: 12,
    expiresAt: '2027-01-01T15:00:00Z',
    zipAttached: true,
    newTrialUrl: 'https://app.estimateace.com/trial',
  });
  assert.match(x.subject, /data export/);
  assert.match(x.text, /November 21, 2026/);
  assert.match(x.text, /until January 1, 2027/);
  assert.match(x.text, /\(12\): https:\/\/x\/files/);
  assert.match(x.text, /attached to this email/);
  assert.ok(!/<script/i.test(T.buildWarningEmail({ name: '<script>', email: 'a@b.co', lastActiveAt: ago(20), deleteAfter: ago(-10), signInUrl: 'https://a' }).html));
});

test('export: CSV + JSON contents, secrets stripped, formulas defused', async () => {
  const files = [{ path: 'photo/1.jpg', url: 'https://signed/1' }];
  const entries = X.buildExportEntries(
    {
      documents: [
        { id: 'SETTINGS-x', documentType: 'settings', profile: { company: 'Acme', apiToken: 'SECRET', aiReceptionistMessages: [{ callerName: 'Al', summary: 'Leak' }] } },
        { id: 'EST-1', documentType: 'estimate', jobName: '=HYPERLINK("x")', emails: ['c@x.com'], items: [{ description: 'Paint', qty: 2, unit: 'hr', price: 50, total: 100 }] },
        { id: 'INV-1', documentType: 'invoice', jobName: '=HYPERLINK("x")', emails: ['c@x.com'], items: [] },
      ],
      archives: [{ id: 'EST-0', jobName: 'Old job', items: [] }],
      receipts: [],
      crew: [{ email: 'crew@x.com', role: 'full', crew_user_id: 'u' }],
      callLog: [],
      blockedNumbers: [],
    },
    files,
    { email: 'pat@example.com', generatedAt: NOW.toISOString(), expiresAt: ago(-30) }
  );
  const byName = Object.fromEntries(entries.map((e) => [e.name, new TextDecoder().decode(e.data)]));
  for (const n of ['README.txt', 'customers.csv', 'documents.csv', 'line-items.csv', 'leads.csv', 'files.csv', 'index.html', 'settings.json', 'documents.json']) {
    assert.ok(byName[n] != null, n);
  }
  assert.ok(!byName['settings.json'].includes('SECRET'));
  assert.match(byName['line-items.csv'], /Paint,2,hr,50,100/);
  assert.match(byName['documents.csv'], /'=HYPERLINK/);
  assert.equal(byName['customers.csv'].trim().split('\r\n').length, 3); // header + 2 unique customers
  assert.match(byName['leads.csv'], /AI Receptionist,,Al,,,Leak/);
  assert.match(byName['files.csv'], /photo\/1\.jpg,https:\/\/signed\/1/);
  assert.ok(!byName['crew.json'].includes('crew_user_id'));
});

test('wiring: cron secret, dry-run by default, vercel cron, migration safety', () => {
  const route = src('app/api/cron/trial-inactivity/route.ts');
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /const dryRun = forceDry \|\| mode !== 'live'/);
  const vercel = JSON.parse(src('vercel.json'));
  assert.ok(vercel.crons.some((c) => c.path === '/api/cron/trial-inactivity'));
  const sql = src('supabase/trial-inactivity-2026-11.sql');
  assert.match(sql, /WHERE sub\.status = 'trialing'/);
  assert.match(sql, /AND sub\.account_closes_at IS NULL/);
  assert.match(sql, /crew_members cm WHERE cm\.crew_user_id = u\.id/);
  assert.match(sql, /crew_seat_subscriptions cs/);
  assert.match(sql, /receptionist_accounts ra/);
  assert.match(sql, /VALUES \('account-exports', 'account-exports', false\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.trial_inactivity_candidates/);
  assert.match(sql, /WHERE cleared_at IS NULL AND deleted_at IS NULL/);
  const deps = src('lib/trial-inactivity-deps.ts');
  assert.match(deps, /idempotencyKey: `trial-warning\/\$\{cycle\.id\}`/);
  assert.match(deps, /idempotencyKey: `trial-export\/\$\{cycle\.id\}`/);
  assert.match(deps, /deleteAccount: \(userId\) => purgeClosedAccount\(userId\)/);
  assert.match(deps, /stripe\.invoices\.list/);
});

test('signup + terms + privacy explain the rule', () => {
  const trial = src('app/trial/page.tsx');
  assert.match(trial, /offer === '2mo' && \(/);
  assert.match(trial, /TRIAL_INACTIVITY_NOTICE/);
  assert.match(T.TRIAL_INACTIVITY_NOTICE, /20 days/);
  assert.match(T.TRIAL_INACTIVITY_NOTICE, /30 days total/);
  assert.match(src('app/terms/page.tsx'), /id="trial-inactivity"/);
  assert.match(src('app/privacy/page.tsx'), /Inactive promotional trials/);
});
