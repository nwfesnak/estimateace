import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = process.cwd();
function loadTsModule(relPath) {
  const src = fs.readFileSync(path.join(root, relPath), 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out)(() => ({}), mod, mod.exports);
  return mod.exports;
}

const { guardStripeAccountIdPatch } = loadTsModule('lib/connect-account-id-guard.ts');
const jobPayments = fs.readFileSync(path.join(root, 'lib/job-payments.ts'), 'utf8');
const webhook = fs.readFileSync(path.join(root, 'app/api/payments/connect/webhook/route.ts'), 'utf8');

const flags = { charges_enabled: false, payouts_enabled: false, details_submitted: false };

test('a linked id is never nulled by a status sync or other path', () => {
  for (const reason of ['status_sync', 'webhook', 'other', 'onboarding_replace']) {
    const d = guardStripeAccountIdPatch('acct_live1', { stripe_account_id: null, ...flags }, reason);
    assert.equal(d.action, 'blocked_clear');
    assert.equal('stripe_account_id' in d.patch, false, 'id must be dropped from the patch');
    assert.equal(d.patch.charges_enabled, false, 'other flags still written');
    assert.equal(d.nextId, 'acct_live1');
  }
  const blank = guardStripeAccountIdPatch('acct_live1', { stripe_account_id: '  ' }, 'status_sync');
  assert.equal(blank.action, 'blocked_clear');
});

test('only an explicit deauthorize may clear the id', () => {
  const d = guardStripeAccountIdPatch('acct_live1', { stripe_account_id: null, ...flags }, 'deauthorized');
  assert.equal(d.action, 'clear');
  assert.equal(d.patch.stripe_account_id, null);
});

test('set, replace and unchanged are reported for logging', () => {
  assert.equal(guardStripeAccountIdPatch(null, { stripe_account_id: 'acct_new' }).action, 'set');
  const r = guardStripeAccountIdPatch('acct_old', { stripe_account_id: 'acct_new' }, 'onboarding_replace');
  assert.equal(r.action, 'replace');
  assert.equal(r.previousId, 'acct_old');
  assert.equal(guardStripeAccountIdPatch('acct_x', { stripe_account_id: 'acct_x' }).action, 'unchanged');
  assert.equal(guardStripeAccountIdPatch('acct_x', { charges_enabled: true }).action, 'unchanged');
  assert.equal(guardStripeAccountIdPatch(null, { stripe_account_id: null }).action, 'unchanged');
});

test('job-payments no longer nulls the id on "no such account"', () => {
  assert.doesNotMatch(jobPayments, /clearStalePaymentAccount/);
  assert.match(jobPayments, /markConnectAccountUnreachable\(userId, existing\.stripe_account_id, 'status_sync'\)/);
  assert.match(jobPayments, /guardStripeAccountIdPatch\(existing\?\.stripe_account_id, safePatch, reason\)/);
  assert.match(jobPayments, /refused to clear stripe_account_id/);
  // The unreachable path writes only flags, never stripe_account_id.
  const fn = jobPayments.slice(
    jobPayments.indexOf('async function markConnectAccountUnreachable'),
    jobPayments.indexOf('export async function clearPaymentAccountOnDeauthorize')
  );
  assert.doesNotMatch(fn, /stripe_account_id\s*:/);
  // Re-onboarding replacement is tagged so the old id is logged.
  assert.match(jobPayments, /'onboarding_replace'/);
  assert.match(jobPayments, /replaced_account_id: staleAccountId/);
});

test('connect webhook clears only on account.application.deauthorized', () => {
  assert.match(webhook, /case 'account\.application\.deauthorized'/);
  assert.match(webhook, /clearPaymentAccountOnDeauthorize\(connectedAccount\)/);
  assert.match(jobPayments, /'deauthorized'\n\s*\);/);
});
