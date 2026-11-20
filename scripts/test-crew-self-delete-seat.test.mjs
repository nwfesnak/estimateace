// Run: npm run test:account-deletion — crew member deletes own account → owner's seat ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const CB = await jiti.import(path.join(root, 'lib/crew-billing.ts'));
const R = await jiti.import(path.join(root, 'lib/crew-seat-release.ts'));
const P = await jiti.import(path.join(root, 'lib/account-purge.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '33333333-3333-4333-8333-333333333333';
const CREW = '22222222-2222-4222-8222-222222222222';

function seatSub(id, status = 'active', meta = {}) {
  return {
    id,
    status,
    metadata: { purpose: 'crew_seat', supabase_user_id: OWNER, crew_email: 'pat@crew.test', crew_user_id: CREW, ...meta },
  };
}

/** Fake Stripe: subscriptions keyed by id; records cancels. */
function fakeStripe(subs) {
  const calls = [];
  return {
    calls,
    subscriptions: {
      async retrieve(id) {
        calls.push(`retrieve ${id}`);
        if (!subs[id]) throw Object.assign(new Error(`No such subscription: '${id}'`), { code: 'resource_missing' });
        return subs[id];
      },
      async cancel(id) {
        calls.push(`cancel ${id}`);
        subs[id] = { ...subs[id], status: 'canceled' };
        return subs[id];
      },
    },
  };
}

const recorded = [];
const record = async (sub) => (recorded.push(`${sub.id}:${sub.status}`), { ok: true });

test('cancelCrewSeatNow: cancels an active seat now and records it', async () => {
  const stripe = fakeStripe({ sub_seat: seatSub('sub_seat') });
  assert.equal(await CB.cancelCrewSeatNow(stripe, 'sub_seat', record), 'canceled');
  assert.deepEqual(stripe.calls, ['retrieve sub_seat', 'cancel sub_seat']);
  assert.ok(recorded.includes('sub_seat:canceled'));
});

test('cancelCrewSeatNow is idempotent and never touches non-seat subscriptions', async () => {
  const stripe = fakeStripe({
    sub_done: seatSub('sub_done', 'canceled'),
    sub_main: { id: 'sub_main', status: 'active', metadata: { supabase_user_id: OWNER } },
  });
  assert.equal(await CB.cancelCrewSeatNow(stripe, 'sub_done', record), 'already_ended');
  assert.equal(await CB.cancelCrewSeatNow(stripe, 'sub_gone', record), 'missing');
  assert.equal(await CB.cancelCrewSeatNow(stripe, 'sub_main', record), 'not_a_seat');
  assert.ok(!stripe.calls.some((c) => c.startsWith('cancel')), stripe.calls.join(','));
});

test('cancelCrewSeatNow with expectations refuses another crew member\'s seat', async () => {
  const stripe = fakeStripe({
    sub_other: seatSub('sub_other', 'active', { crew_user_id: 'someone-else', crew_email: 'sam@crew.test' }),
    sub_other_owner: seatSub('sub_other_owner', 'active', { supabase_user_id: OTHER_OWNER }),
  });
  const expect = { crewUserId: CREW, crewEmail: 'pat@crew.test', ownerUserId: OWNER };
  assert.equal(await CB.cancelCrewSeatNow(stripe, 'sub_other', record, expect), 'not_this_crew');
  assert.equal(await CB.cancelCrewSeatNow(stripe, 'sub_other_owner', record, expect), 'not_this_crew');
  assert.ok(!stripe.calls.some((c) => c.startsWith('cancel')));
});

test('crew deletes own account: every seat for them is found (member row, seat rows, by email) and canceled once', async () => {
  const subs = {
    sub_a: seatSub('sub_a'), // on crew_members.stripe_subscription_id
    sub_b: seatSub('sub_b', 'active', { crew_user_id: undefined }), // found by owner + email only
    sub_c: seatSub('sub_c', 'active', { supabase_user_id: OTHER_OWNER }), // second owner, by crew_user_id
  };
  const stripe = fakeStripe(subs);
  const deps = {
    memberships: async () => [{ owner_user_id: OWNER, email: 'Pat@Crew.test', stripe_subscription_id: 'sub_a' }],
    seatsByOwnerEmail: async (owner, email) => {
      assert.equal(owner, OWNER);
      assert.equal(email, 'pat@crew.test');
      return [
        { owner_user_id: OWNER, crew_email: email, stripe_subscription_id: 'sub_a' },
        { owner_user_id: OWNER, crew_email: email, stripe_subscription_id: 'sub_b' },
      ];
    },
    seatsByCrewUser: async () => [
      { owner_user_id: OTHER_OWNER, crew_email: 'pat@crew.test', stripe_subscription_id: 'sub_c' },
      { owner_user_id: OWNER, crew_email: 'pat@crew.test', stripe_subscription_id: 'sub_a' },
    ],
    cancel: CB.cancelCrewSeatNow,
  };
  const r = await R.releaseSeatsForDeletedCrew(stripe, CREW, deps, record);
  assert.deepEqual(r.canceled.sort(), ['sub_a', 'sub_b', 'sub_c']);
  assert.equal(stripe.calls.filter((c) => c.startsWith('cancel')).length, 3);

  // Second run (purge retried): nothing left to cancel.
  const again = await R.releaseSeatsForDeletedCrew(stripe, CREW, deps, record);
  assert.deepEqual(again.canceled, []);
  assert.equal(stripe.calls.filter((c) => c.startsWith('cancel')).length, 3);
});

test('a crew member with no seat: nothing happens', async () => {
  const stripe = fakeStripe({});
  const deps = { memberships: async () => [], seatsByOwnerEmail: async () => [], seatsByCrewUser: async () => [], cancel: CB.cancelCrewSeatNow };
  assert.deepEqual(await R.releaseSeatsForDeletedCrew(stripe, CREW, deps, record), { canceled: [], skipped: [] });
  assert.equal(stripe.calls.length, 0);
});

test('a Stripe error stops the purge before anything is deleted (retried next day)', async () => {
  const log = [];
  const admin = {
    from: (t) => ({ delete: () => ({ eq: (c) => (log.push(`delete ${t}.${c}`), Promise.resolve({ error: null, count: 0 })), like: () => Promise.resolve({ error: null, count: 0 }) }) }),
    auth: { admin: { deleteUser: async () => (log.push('auth'), { error: null }) } },
  };
  const r = await P.purgeAccountData(admin, CREW, {
    stopBilling: async () => {},
    releaseCrewSeats: async () => {
      throw new Error('Stripe API down');
    },
    releasePhoneLine: async () => {},
    deleteMedia: async () => ({ removed: 0, complete: true }),
    deleteCrewLogins: async () => 0,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /Stripe API down/);
  assert.equal(log.length, 0);
});

test('owner "delete crew member" and crew self-deletion share one billing path', () => {
  assert.match(src('app/api/crew/remove/route.ts'), /await cancelCrewSeatNow\(stripe, subId\)/);
  assert.match(src('lib/account-purge.ts'), /releaseSeatsForDeletedCrew\(stripe, uid, deps\)/);
  // Owner flow sends no email/notification, so the self-deletion path doesn't either.
  for (const f of ['app/api/crew/remove/route.ts', 'lib/crew-seat-release.ts']) {
    assert.ok(!/sendEmailNotification|sendSmsNotification|notify/i.test(src(f).replace(/notification, so neither/, '')), f);
  }
});

test('seat history survives the crew login being deleted (FK fallback)', () => {
  assert.match(src('lib/crew-billing.ts'), /code === '23503' && payload\.crew_user_id/);
});

test('privacy policy discloses the Meta Pixel: data, purpose, off in apps, opt-out links', () => {
  const p = src('app/privacy/page.tsx');
  assert.match(p, /Meta Pixel/);
  assert.match(p, /_fbp/);
  assert.match(p, /IP address/);
  assert.match(p, /retargeting/);
  assert.match(p, /turned off inside the EstimateAce\s+iPhone and Android apps/);
  assert.match(p, /https:\/\/www\.facebook\.com\/adpreferences/);
  assert.match(p, /browser\s+settings/);
  assert.match(p, /Last updated: November 20, 2026/);
  // The pixel really is gated off in the native wrapper.
  assert.match(src('app/layout.tsx'), /native-app/);
});
