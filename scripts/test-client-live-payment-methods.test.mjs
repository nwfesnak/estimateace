import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = process.cwd();
const cache = new Map();
function loadTsModule(relPath) {
  if (cache.has(relPath)) return cache.get(relPath);
  const src = fs.readFileSync(path.join(root, relPath), 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  cache.set(relPath, mod.exports);
  const req = (spec) => {
    if (spec.startsWith('@/')) {
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        const rel = spec.slice(2) + ext;
        if (fs.existsSync(path.join(root, rel))) return loadTsModule(rel);
      }
    }
    return require(spec);
  };
  new Function('require', 'module', 'exports', out)(req, mod, mod.exports);
  return mod.exports;
}

const { mergeFilledPaymentSettings, buildClientPaymentOptions } = loadTsModule('lib/client-payment-options.ts');
const { resolveAmountDue } = loadTsModule('lib/stripe-fees.ts');
const route = fs.readFileSync(path.join(root, 'app/api/client/document/route.ts'), 'utf8');

// Shapes from EST-14454A-0030 (job copy taken 11:22 AM ET) vs company SETTINGS saved 2:52 PM ET.
const jobCopy = {
  venmo: { enabled: false, connected: false, handle: '' },
  zelle: { enabled: false, connected: false, handle: '', qrUrl: '' },
  paypal: { enabled: false, connected: false, handle: '' },
  stripe: { enabled: true, connected: false },
  mailcheck: { enabled: false, connected: false, handle: '' },
};
const companyNow = {
  venmo: { enabled: true, connected: true, handle: 'test-venmo' },
  zelle: { enabled: true, connected: true, handle: '5555550100', qrUrl: '' },
  paypal: { enabled: false, connected: false, handle: '' },
  stripe: { enabled: false, connected: false },
  mailcheck: { enabled: false, connected: false, handle: '' },
};

function optionsFor(settings, amount) {
  return buildClientPaymentOptions({
    stripeReady: false,
    paymentSettings: settings,
    amount,
    invoiceNumber: 'EST-14454A-0030',
    company: 'Dogs and Cats',
    label: 'Deposit due',
    feePercentRate: 0,
    chargeFees: false,
  });
}

test('deposit gate passes for the GOFF Test estimate ($106, 30%, min $50)', () => {
  const due = resolveAmountDue({
    documentType: 'estimate', grandTotal: 106, amountPaid: 0,
    depositPercent: 30, showDepositOnApproval: true, depositMinimumAmount: 50,
  });
  assert.equal(due.payKind, 'deposit');
  assert.equal(due.depositDue, 31.8);
});

test('old behaviour: job copy alone → no way to pay (the bug Nathan hit)', () => {
  assert.equal(optionsFor(jobCopy, 31.8).length, 0);
});

test('live company methods → Venmo and Zelle offered for the $31.80 deposit', () => {
  const opts = optionsFor(mergeFilledPaymentSettings(jobCopy, companyNow), 31.8);
  assert.deepEqual(opts.map((o) => o.method).sort(), ['venmo', 'zelle']);
  for (const o of opts) assert.equal(o.totalAmount, 31.8);
});

test('a method turned off on the company page disappears from older jobs', () => {
  const job = { ...jobCopy, venmo: { enabled: true, connected: true, handle: 'old-handle' } };
  const company = { ...companyNow, venmo: { enabled: false, connected: false, handle: '' } };
  const opts = optionsFor(mergeFilledPaymentSettings(job, company), 31.8);
  assert.ok(!opts.some((o) => o.method === 'venmo'));
});

test('a blank company handle falls back to the handle saved on the job', () => {
  const job = { ...jobCopy, zelle: { enabled: true, connected: true, handle: '5555550199', qrUrl: '' } };
  const company = { ...companyNow, zelle: { enabled: true, connected: false, handle: '', qrUrl: '' } };
  const z = optionsFor(mergeFilledPaymentSettings(job, company), 31.8).find((o) => o.method === 'zelle');
  assert.ok(z);
  assert.equal(z.handle, '5555550199');
});

test('route: payment methods follow company settings; deposit/fee terms stay per-job', () => {
  assert.match(
    route,
    /paymentSettings: mergeFilledPaymentSettings\(\s*profile\.paymentSettings \|\| snap\.paymentSettings,\s*sp\.paymentSettings\s*\)/
  );
  assert.doesNotMatch(route, /_jobSettingsSnapshottedAt === 'string'\s*\?\s*snap\.paymentSettings/);
  for (const k of ['depositPercentage', 'showDepositOnApproval', 'depositMinimumAmount', 'chargeCCFee', 'ccFeePercentage']) {
    assert.match(route, new RegExp(`${k}: snap\\.${k}`));
  }
});

test('Stripe connected flag follows the status API both ways', () => {
  const { stripeConnectedFlagFromStatus: f } = loadTsModule('lib/client-payment-options.ts');
  assert.equal(f({ connected: true, connectReady: true }), true);
  assert.equal(f({ connected: true, connectReady: false }), true);
  // Mitigation Hero today: no Connect account id → status says connected:false
  assert.equal(f({ connected: false, connectReady: false }), false);
  // odd / partial replies and crew never change the flag
  assert.equal(f({}), null);
  assert.equal(f(null), null);
  assert.equal(f({ error: 'Unauthorized' }), null);
  assert.equal(f({ connected: false, isCrew: true }), null);
});

test('page: refreshStripeConnectStatus can clear the flag and only on res.ok', () => {
  const page = fs.readFileSync(path.join(root, 'app/page.tsx'), 'utf8');
  const i = page.indexOf('const refreshStripeConnectStatus');
  const body = page.slice(i, page.indexOf('const startStripeConnectOnboard', i));
  assert.match(body, /if \(res\.ok\) \{[\s\S]*stripeConnectedFlagFromStatus\(json\)/);
  assert.match(body, /connected: nextStripeConnected/);
  assert.doesNotMatch(body, /if \(json\.connectReady \|\| json\.connected\) \{/);
});
