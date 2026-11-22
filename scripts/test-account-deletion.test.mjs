// Run: npm run test:account-deletion — full account deletion (purge) coverage + safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const P = await jiti.import(path.join(root, 'lib/account-purge.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

const UID = '3f6c2a1e-1111-4222-8333-944455556666';

/**
 * Every table in the live public schema (production, Nov 19 2026). A new table must be
 * added to ACCOUNT_DATA_TABLES or ACCOUNT_DATA_KEPT (with a reason) or this fails.
 */
const LIVE_PUBLIC_TABLES = [
  'app_tutorials',
  'archive-est',
  'company_vendors',
  'crew_members',
  'crew_seat_subscriptions',
  'estimates',
  'login_otp',
  'payment_accounts',
  'promo_limits',
  'promo_redemptions',
  'rate_limit_counters',
  'receipts',
  'receptionist_accounts',
  'receptionist_blocked_numbers',
  'receptionist_call_finalizations',
  'sms_opt_ins',
  'stripe_disputes',
  'subscriptions',
  // supabase/trial-inactivity-2026-11.sql (not yet applied)
  'trial_inactivity_log',
];

/** Fake service-role client that records every call in order. */
function fakeAdmin({ failTable, deleteUserError } = {}) {
  const log = [];
  const result = (table) => ({ error: failTable === table ? { message: 'boom' } : null, count: 2 });
  return {
    log,
    from(table) {
      return {
        delete(opts) {
          return {
            eq(col, val) {
              log.push(`delete ${table}.${col}=${val}${opts?.count ? ' (count)' : ''}`);
              return Promise.resolve(result(table));
            },
            like(col, pattern) {
              log.push(`delete ${table}.${col} like ${pattern}`);
              return Promise.resolve(result(table));
            },
          };
        },
      };
    },
    auth: {
      admin: {
        async deleteUser(id) {
          log.push(`auth.deleteUser ${id}`);
          return { error: deleteUserError || null };
        },
      },
    },
  };
}

function steps(log, over = {}) {
  return {
    stopBilling: async (u) => void log.push(`stopBilling ${u}`),
    releaseCrewSeats: async (u) => void log.push(`releaseCrewSeats ${u}`),
    releasePhoneLine: async (u) => void log.push(`releasePhoneLine ${u}`),
    deleteMedia: async (u) => (log.push(`deleteMedia ${u}`), { removed: 7, complete: true }),
    deleteCrewLogins: async (u) => (log.push(`deleteCrewLogins ${u}`), 1),
    ...over,
  };
}

test('every live public table is purged or deliberately kept', () => {
  const purged = new Set(P.ACCOUNT_DATA_TABLES.map((t) => t.table));
  for (const t of LIVE_PUBLIC_TABLES) {
    assert.ok(purged.has(t) || P.ACCOUNT_DATA_KEPT[t], `table ${t} is neither purged nor documented as kept`);
  }
  for (const t of purged) assert.ok(LIVE_PUBLIC_TABLES.includes(t), `${t} not in live schema`);
  assert.ok(!purged.has('subscriptions'), 'subscriptions must go last via auth cascade (cron retry key)');
});

test('full purge order: billing → phone → files → crew logins → tables → counters → login', async () => {
  const admin = fakeAdmin();
  const r = await P.purgeAccountData(admin, UID, steps(admin.log));
  assert.equal(r.ok, true, r.error);
  const L = admin.log;
  const at = (s) => L.findIndex((x) => x.startsWith(s));
  assert.ok(at('stopBilling') === 0);
  assert.ok(at('releaseCrewSeats') > at('stopBilling'));
  assert.ok(at('delete crew_members.crew_user_id') > at('releaseCrewSeats'), 'seat lookup reads crew_members first');
  assert.ok(at('releasePhoneLine') > at('releaseCrewSeats'));
  assert.ok(at('deleteMedia') > at('releasePhoneLine'));
  assert.ok(at('deleteCrewLogins') > at('deleteMedia'));
  assert.ok(at('delete crew_members.owner_user_id') > at('deleteCrewLogins'), 'crew logins read crew_members first');
  assert.ok(at('delete receptionist_accounts') > at('releasePhoneLine'));
  assert.ok(at(`delete rate_limit_counters.bucket like %${UID}%`) > 0);
  assert.equal(L.at(-1), `auth.deleteUser ${UID}`);
  for (const { table, column } of P.ACCOUNT_DATA_TABLES) {
    assert.ok(L.includes(`delete ${table}.${column}=${UID} (count)`), `${table}.${column} deleted`);
  }
  assert.ok(!L.some((x) => x.startsWith('delete subscriptions')), 'schedule row left for the cascade');
  assert.equal(r.mediaRemoved, 7);
  assert.equal(r.crewLoginsDeleted, 1);
});

test('billing that cannot be stopped deletes nothing', async () => {
  const admin = fakeAdmin();
  const r = await P.purgeAccountData(admin, UID, steps(admin.log, {
    stopBilling: async () => {
      throw new Error('Could not stop subscriptions: sub_1');
    },
  }));
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not stop/);
  assert.ok(!admin.log.some((x) => x.startsWith('delete') || x.startsWith('auth')));
});

test('Twilio failure or partial media stops before any row or the login is deleted', async () => {
  for (const over of [
    { releasePhoneLine: async () => { throw new Error('twilio down'); } },
    { deleteMedia: async () => ({ removed: 100000, complete: false }) },
  ]) {
    const admin = fakeAdmin();
    const r = await P.purgeAccountData(admin, UID, steps(admin.log, over));
    assert.equal(r.ok, false);
    assert.ok(!admin.log.some((x) => x.startsWith('delete') || x.startsWith('auth')), JSON.stringify(admin.log));
  }
});

test('a failed table delete keeps the login (and the cron retry row)', async () => {
  const admin = fakeAdmin({ failTable: 'receipts' });
  const r = await P.purgeAccountData(admin, UID, steps(admin.log));
  assert.equal(r.ok, false);
  assert.match(r.error, /receipts/);
  assert.ok(!admin.log.some((x) => x.startsWith('auth.deleteUser')));
});

test('re-running after the login is already gone is fine (idempotent)', async () => {
  const admin = fakeAdmin({ deleteUserError: { message: 'User not found', status: 404 } });
  const r = await P.purgeAccountData(admin, UID, steps(admin.log));
  assert.equal(r.ok, true, r.error);
  assert.ok(admin.log.includes(`delete subscriptions.user_id=${UID}`), 'leftover schedule row cleared');
  const admin2 = fakeAdmin({ deleteUserError: { message: 'Database error deleting user', status: 500 } });
  const r2 = await P.purgeAccountData(admin2, UID, steps(admin2.log));
  assert.equal(r2.ok, false);
});

test('refuses anything that is not a user id', async () => {
  for (const bad of ['', '%', '../x', 'SETTINGS-abc', `${UID}%`]) {
    const admin = fakeAdmin();
    const r = await P.purgeAccountData(admin, bad, steps(admin.log));
    assert.equal(r.ok, false);
    assert.equal(admin.log.length, 0);
  }
});

test('Stripe: subscriptions are canceled, customers are never deleted', () => {
  const cleanup = src('lib/account-cleanup.ts');
  const purge = src('lib/account-purge.ts');
  assert.match(purge, /stopAccountBilling\(admin, stripe, uid, 'now'\)/);
  assert.match(cleanup, /stripe\.subscriptions\.cancel\(/);
  for (const s of [cleanup, purge]) assert.ok(!/customers\.del\(/.test(s), 'Stripe customers are kept for tax records');
});

test('crew: owner purge removes crew logins it created; crew with a real workspace are kept', () => {
  const cleanup = src('lib/account-cleanup.ts');
  assert.match(cleanup, /meta\.is_crew !== true \|\| meta\.owner_user_id !== ownerId/);
  assert.match(cleanup, /\.not\('id', 'like', 'SETTINGS-%'\)/);
});

test('privacy policy mentions the mobile apps and account deletion', () => {
  const privacy = src('app/privacy/page.tsx');
  assert.match(privacy, /iPhone|iOS/);
  assert.match(privacy, /Android/);
  assert.match(privacy, /\/delete-account/);
});
