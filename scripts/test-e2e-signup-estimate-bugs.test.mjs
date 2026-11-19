import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function loadTs(relPath) {
  const src = readFileSync(join(root, relPath), 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: relPath,
  });
  const module = { exports: {} };
  const fn = new Function('require', 'module', 'exports', outputText);
  fn(require, module, module.exports);
  return module.exports;
}

const { getTaxRateFromZip, STATE_TAX_RATES } = loadTs('lib/tax-rates.ts');
const { signupFieldsFromMetadata, seedSettingsFromSignupMetadata } = loadTs(
  'lib/signup-profile.ts'
);
const { isEstimateApproved, readEstimateApproval } = loadTs('lib/estimate-approval.ts');

test('tax rate is 0 when zip and state are unknown (no misleading 7%)', () => {
  assert.equal(getTaxRateFromZip('', ''), 0);
  assert.equal(getTaxRateFromZip('   ', '  '), 0);
  assert.equal(getTaxRateFromZip('00000', 'XX'), 0);
});

test('tax rate uses job state, including 0% states', () => {
  assert.equal(getTaxRateFromZip('', 'NC'), 4.75);
  assert.equal(getTaxRateFromZip('', 'nc'), 4.75);
  assert.equal(getTaxRateFromZip('', 'OR'), 0);
  assert.equal(getTaxRateFromZip('', 'IN'), 7);
});

test('known ZIP overrides state rate', () => {
  assert.equal(getTaxRateFromZip('90210', 'CA'), 9.5);
  assert.equal(getTaxRateFromZip('10001-1234', 'NY'), 8.875);
});

test('owner business state can be passed as the fallback', () => {
  assert.equal(getTaxRateFromZip('', 'FL'), STATE_TAX_RATES.FL);
});

test('signup metadata maps company, full_name, phone, and email', () => {
  const fields = signupFieldsFromMetadata({
    email: 'owner@example.com',
    user_metadata: {
      company: 'Ace Builders LLC',
      full_name: 'Jordan Lee',
      phone: '555-0100',
      preferred_plan: 'yearly',
      promo: '6mo',
    },
  });
  assert.equal(fields.company, 'Ace Builders LLC');
  assert.equal(fields.name, 'Jordan Lee');
  assert.equal(fields.phone, '555-0100');
  assert.equal(fields.email, 'owner@example.com');
  assert.equal(fields.preferredPlan, 'yearly');
  assert.equal(fields.promo, '6mo');
});

test('signup metadata falls back to name when full_name is missing', () => {
  const fields = signupFieldsFromMetadata({
    user_metadata: { name: 'Sam', company: 'Sam Co' },
  });
  assert.equal(fields.name, 'Sam');
  assert.equal(fields.company, 'Sam Co');
});

test('seedSettingsFromSignupMetadata writes only empty SETTINGS fields', async () => {
  const upserts = [];
  const admin = {
    from() {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          return { data: { profile: { company: '', email: 'old@example.com' } } };
        },
        async upsert(row) {
          upserts.push(row);
          return { error: null };
        },
      };
    },
  };
  const wrote = await seedSettingsFromSignupMetadata(admin, {
    id: 'user-1',
    email: 'new@example.com',
    user_metadata: { company: 'New Co', full_name: 'Pat', phone: '555-2' },
  });
  assert.equal(wrote, true);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].id, 'SETTINGS-user-1');
  assert.equal(upserts[0].profile.company, 'New Co');
  assert.equal(upserts[0].profile.name, 'Pat');
  assert.equal(upserts[0].profile.phone, '555-2');
  assert.equal(upserts[0].profile.email, 'old@example.com');
});

test('seedSettingsFromSignupMetadata skips crew accounts and no-ops when already filled', async () => {
  const crewWrote = await seedSettingsFromSignupMetadata(
    { from() { throw new Error('should not touch db'); } },
    { id: 'crew-1', app_metadata: { is_crew: true }, user_metadata: { company: 'X' } }
  );
  assert.equal(crewWrote, false);

  const admin = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          return { data: { profile: { company: 'Existing', name: 'Ann', phone: '1', email: 'a@b.c' } } };
        },
        async upsert() { throw new Error('should not upsert'); },
      };
    },
  };
  const wrote = await seedSettingsFromSignupMetadata(admin, {
    id: 'user-2',
    email: 'a@b.c',
    user_metadata: { company: 'Other', full_name: 'Other' },
  });
  assert.equal(wrote, false);
});

test('a brand-new estimate is not treated as approved', () => {
  assert.equal(isEstimateApproved({}), false);
  assert.equal(isEstimateApproved({ profile: {} }), false);
  assert.equal(isEstimateApproved({ status: 'draft', profile: { depositPercentage: 10 } }), false);
  const pending = readEstimateApproval({ profile: { showDepositOnApproval: true } });
  assert.equal(pending.approvedAt, null);
});

test('approval is recognized from profile timestamps', () => {
  assert.equal(
    isEstimateApproved({ profile: { _estimateApprovedAt: '2026-11-19T12:00:00.000Z', _estimateApprovedBy: 'owner' } }),
    true
  );
});

test('auth email templates are branded and keep ConfirmationURL', () => {
  const confirmation = readFileSync(join(root, 'supabase/email-templates/confirmation.html'), 'utf8');
  const recovery = readFileSync(join(root, 'supabase/email-templates/recovery.html'), 'utf8');
  for (const html of [confirmation, recovery]) {
    assert.match(html, /EstimateAce/);
    assert.match(html, /\{\{ \.ConfirmationURL \}\}/);
    assert.doesNotMatch(html, /Supabase Auth|powered by supabase/i);
    assert.doesNotMatch(html, /mail\.app\.supabase\.io/);
  }
  assert.match(confirmation, /Confirm my email/);
  assert.match(recovery, /Reset password/);
});
