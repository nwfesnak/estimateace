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

const { resolveAmountDue, estimateDepositPending } = loadTsModule('lib/stripe-fees.ts');
const page = fs.readFileSync(path.join(root, 'app/page.tsx'), 'utf8');

const base = { depositPercent: 10, showDepositOnApproval: true, depositMinimumAmount: 0 };

test('estimate asks for the deposit; invoice asks for the full balance (by design)', () => {
  const est = resolveAmountDue({ documentType: 'estimate', grandTotal: 1000, ...base });
  assert.equal(est.payKind, 'deposit');
  assert.equal(est.depositDue, 100);
  assert.equal(est.payLabel, 'Deposit due');
  const inv = resolveAmountDue({ documentType: 'invoice', grandTotal: 1000, ...base });
  assert.equal(inv.payKind, 'balance');
  assert.equal(inv.depositDue, 0);
  assert.equal(inv.amountDueNow, 1000);
  assert.equal(inv.payLabel, 'Total due');
});

test('estimateDepositPending: pending when deposits on and nothing paid', () => {
  const r = estimateDepositPending({ grandTotal: 1000, amountPaid: 0, ...base });
  assert.equal(r.pending, true);
  assert.equal(r.depositDue, 100);
  assert.equal(r.depositPercent, 10);
});

test('estimateDepositPending: not pending once a deposit is recorded', () => {
  assert.equal(estimateDepositPending({ grandTotal: 1000, amountPaid: 100, ...base }).pending, false);
});

test('estimateDepositPending: off switch, 0%, or below minimum → not pending', () => {
  assert.equal(
    estimateDepositPending({ grandTotal: 1000, ...base, showDepositOnApproval: false }).pending,
    false
  );
  assert.equal(estimateDepositPending({ grandTotal: 1000, ...base, depositPercent: 0 }).pending, false);
  assert.equal(
    estimateDepositPending({ grandTotal: 400, ...base, depositMinimumAmount: 500 }).pending,
    false
  );
  assert.equal(
    estimateDepositPending({ grandTotal: 500, ...base, depositMinimumAmount: 500 }).pending,
    true
  );
});

test('estimateDepositPending: tiny totals (deposit < $0.50) are not pending', () => {
  assert.equal(estimateDepositPending({ grandTotal: 4, ...base }).pending, false);
});

function fnBody(name) {
  const start = page.indexOf(`const ${name} = async`);
  assert.ok(start > 0, `${name} not found`);
  const next = page.indexOf('\n  const ', start + 20);
  return page.slice(start, next);
}

test('Convert to Invoice warns before skipping an uncollected deposit', () => {
  const body = fnBody('convertToInvoice');
  const guard = body.indexOf('getEstimateDepositStatus()');
  const persist = body.indexOf("setDocumentType('invoice')");
  assert.ok(guard > 0 && persist > 0 && guard < persist, 'deposit check must run before converting');
  assert.match(body, /confirm\(/);
  assert.match(body, /converting now skips the deposit/);
  assert.match(body, /setView\('sendPreview'\);\s*showMessage\(\s*'Deposit screen/);
});

test('Mark Approved in the editor opens the deposit screen when a deposit is owed', () => {
  const body = fnBody('markEstimateApproved');
  assert.match(body, /!sourceRow \? getEstimateDepositStatus\(\) : null/);
  assert.match(body, /if \(deposit\?\.pending\) \{\s*setView\('sendPreview'\)/);
});

test('invoice preview explains deposits are requested on the estimate', () => {
  assert.match(page, /data-testid="invoice-deposit-stage-hint"/);
});

test('getEstimateDepositStatus uses the job snapshot deposit settings', () => {
  const i = page.indexOf('function getEstimateDepositStatus()');
  assert.ok(i > 0);
  const body = page.slice(i, i + 600);
  assert.match(body, /jobSettings\.depositPercentage/);
  assert.match(body, /jobSettings\.showDepositOnApproval/);
  assert.match(body, /jobSettings\.depositMinimumAmount/);
  assert.match(body, /amountPaid/);
});
