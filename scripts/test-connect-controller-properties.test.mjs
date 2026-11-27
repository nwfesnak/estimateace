import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = process.cwd();
function loadTsModule(relPath, requireMap = {}) {
  const src = fs.readFileSync(path.join(root, relPath), 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  // Mocks first; other '@/lib/*' helpers load for real so this test keeps working when they change.
  const req = (name) => {
    if (name in requireMap) return requireMap[name];
    if (name.startsWith('@/lib/')) {
      const rel = `lib/${name.slice('@/lib/'.length)}.ts`;
      if (fs.existsSync(path.join(root, rel))) return loadTsModule(rel, requireMap);
    }
    return {};
  };
  new Function('require', 'module', 'exports', out)(req, mod, mod.exports);
  return mod.exports;
}

const params = loadTsModule('lib/connect-account-params.ts');

/** Fake Stripe + Supabase so createConnectOnboardingLink runs end to end without network. */
function loadJobPayments({ storedAccountId = null } = {}) {
  const calls = { create: [], links: [], upserts: [], loginLinks: [] };
  const row = storedAccountId
    ? { user_id: 'u1', stripe_account_id: storedAccountId, charges_enabled: false, payouts_enabled: false, details_submitted: false, account_type: 'express' }
    : null;
  const stripe = {
    accounts: {
      retrieve: async (id) => ({ id }),
      create: async (p, opts) => {
        calls.create.push({ params: p, opts });
        return { id: 'acct_test_new', type: 'none', controller: { stripe_dashboard: { type: 'express' } } };
      },
      createLoginLink: async (id) => {
        calls.loginLinks.push(id);
        return { url: `https://connect.stripe.com/express/${id}` };
      },
    },
    accountLinks: {
      create: async (p) => {
        calls.links.push(p);
        return { url: 'https://connect.stripe.com/setup/e/acct_test_new/abc' };
      },
    },
  };
  const table = {
    select: () => table,
    eq: () => table,
    maybeSingle: async () => ({ data: row, error: null }),
    upsert: async (r) => {
      calls.upserts.push(r);
      return { error: null };
    },
  };
  const admin = { from: () => table };
  const mod = loadTsModule('lib/job-payments.ts', {
    '@/lib/supabase/admin': { getSupabaseAdmin: () => admin },
    '@/lib/stripe-server': {
      getStripe: () => stripe,
      getAppUrl: () => 'https://estimateace.com',
      getStripeMode: () => 'test',
    },
    '@/lib/stripe-fees': {},
    '@/lib/connect-account-params': params,
  });
  return { mod, calls };
}

test('Connect Stripe creates the account with controller properties, not legacy type', async () => {
  const { mod, calls } = loadJobPayments();
  const res = await mod.createConnectOnboardingLink('u1', 'pro@example.com', 'https://estimateace.com/api/payments/connect/onboard');
  assert.equal(res.ok, true, res.error);
  assert.equal(res.url, 'https://connect.stripe.com/setup/e/acct_test_new/abc');

  assert.equal(calls.create.length, 1);
  const { params: p, opts } = calls.create[0];
  assert.equal('type' in p, false, 'legacy type must not be sent');
  assert.deepEqual(p, {
    controller: {
      losses: { payments: 'stripe' },
      fees: { payer: 'account' },
      stripe_dashboard: { type: 'express' },
      requirement_collection: 'stripe',
    },
    email: 'pro@example.com',
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    metadata: { supabase_user_id: 'u1', purpose: 'job_payments' },
  });
  assert.deepEqual(opts, { apiVersion: '2026-11-18.endive' });

  // Stripe-hosted onboarding link is unchanged.
  assert.deepEqual(calls.links, [
    {
      account: 'acct_test_new',
      refresh_url: 'https://estimateace.com/?stripe_connect=refresh',
      return_url: 'https://estimateace.com/?stripe_connect=return',
      type: 'account_onboarding',
    },
  ]);
  // Stored as an Express-dashboard account so payout dashboard login links keep working.
  assert.equal(calls.upserts[0].stripe_account_id, 'acct_test_new');
  assert.equal(calls.upserts[0].account_type, 'express');
});

test('an existing connected account is reused, nothing new is created', async () => {
  const { mod, calls } = loadJobPayments({ storedAccountId: 'acct_existing' });
  const res = await mod.createConnectOnboardingLink('u1', 'pro@example.com', 'https://estimateace.com/x');
  assert.equal(res.ok, true);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.links[0].account, 'acct_existing');
});

test('payout dashboard still opens an Express login link', async () => {
  const { mod, calls } = loadJobPayments({ storedAccountId: 'acct_existing' });
  const res = await mod.createConnectDashboardLink('u1');
  assert.equal(res.ok, true);
  assert.deepEqual(calls.loginLinks, ['acct_existing']);
});

test('account_type comes from the controller dashboard (controller accounts report type none)', () => {
  const f = params.accountTypeFromStripe;
  assert.equal(f({ type: 'none', controller: { stripe_dashboard: { type: 'express' } } }), 'express');
  assert.equal(f({ type: 'standard', controller: { stripe_dashboard: { type: 'full' } } }), 'standard');
  assert.equal(f({ type: 'custom', controller: { stripe_dashboard: { type: 'none' } } }), 'custom');
  assert.equal(f({ type: 'express' }), 'express', 'legacy accounts without controller still map');
  assert.equal(f({ type: 'none' }), 'express', 'unknown falls back');
  assert.equal(f(null, 'standard'), 'standard');
});

test('no code path still creates Connect accounts with the legacy type field', () => {
  const src = fs.readFileSync(path.join(root, 'lib/job-payments.ts'), 'utf8');
  assert.doesNotMatch(src, /accounts\.create\(\{\s*type:/);
  assert.match(src, /controller: CONNECT_ACCOUNT_CONTROLLER/);
});
