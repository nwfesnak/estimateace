// Run: npm run test:crew
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const R = await jiti.import(path.join(root, 'lib/crew-redaction.ts'));

const owner = 'owner-1';
const none = { ownerId: owner, canSeePricing: false, canSeeFinancials: false };
const pricingOnly = { ownerId: owner, canSeePricing: true, canSeeFinancials: false };
const finOnly = { ownerId: owner, canSeePricing: false, canSeeFinancials: true };
const full = { ownerId: owner, canSeePricing: true, canSeeFinancials: true };

const stored = {
  id: 'EST-1',
  user_id: owner,
  jobName: 'Deck',
  items: [
    {
      id: 101,
      description: 'Boards',
      qty: 10,
      unit: 'SF',
      price: 12.5,
      total: 125,
      materialsList: [{ id: 'm1', name: 'Pine', qty: 10, unitPrice: 4, total: 40 }],
      laborBreakdown: { hours: 2, rate: 60, total: 120 },
    },
    { id: 102, description: 'Labor', qty: 1, price: 300, total: 300 },
  ],
  laborRate: 60,
  laborAmount: 120,
  taxRate: 7,
  taxAmount: 29.75,
  amountPaid: 100,
  receiptUrls: ['r1.jpg'],
  receiptDetails: { vendor: 'Lowes', total: 55 },
  profile: {
    company: 'Acme',
    taxesEnabled: true,
    aiPriceMemory: { pine: 4 },
    paymentSettings: { zelle: 'acme@example.com' },
    twoFactorPhone: '5555550100',
    depositMinimumAmount: 250,
    _discount: { discountType: 'dollar', discountValue: 25, discountAmount: 25 },
  },
};

test('full-access crew rows are untouched', () => {
  assert.deepEqual(R.redactRow(stored, full), stored);
});

test('no pricing + no financials: money hidden, descriptions kept', () => {
  const r = R.redactRow(stored, none);
  assert.equal(r.items[0].price, 0);
  assert.equal(r.items[0].total, 0);
  assert.equal(r.items[0].description, 'Boards');
  assert.equal(r.items[0].qty, 10);
  assert.equal(r.items[0].materialsList[0].unitPrice, 0);
  assert.equal(r.items[0].materialsList[0].name, 'Pine');
  assert.equal(r.items[0].laborBreakdown.rate, 0);
  assert.equal(r.items[0].laborBreakdown.hours, 2);
  assert.equal(r.laborRate, 0);
  assert.equal(r.amountPaid, 0);
  assert.equal(r.taxAmount, 0);
  assert.equal(r.taxRate, 7, 'tax rate is not a price');
  assert.equal(r.receiptDetails, null);
  assert.deepEqual(r.receiptUrls, []);
  assert.equal(r.profile.aiPriceMemory, undefined);
  assert.equal(r.profile.paymentSettings, undefined);
  assert.equal(r.profile.twoFactorPhone, undefined);
  assert.equal(r.profile._discount.discountAmount, 0);
  assert.equal(r.profile.company, 'Acme');
  assert.equal(r.grandTotal, undefined, 'no totals without financials');
  // stored row not mutated
  assert.equal(stored.items[0].price, 12.5);
});

test('pricing only: prices visible, financials hidden', () => {
  const r = R.redactRow(stored, pricingOnly);
  assert.equal(r.items[0].price, 12.5);
  assert.equal(r.laborRate, 60);
  assert.equal(r.amountPaid, 0);
  assert.equal(r.profile.paymentSettings, undefined);
  assert.deepEqual(r.profile.aiPriceMemory, { pine: 4 });
});

test('financials only: unit prices hidden but real grand total provided', () => {
  const r = R.redactRow(stored, finOnly);
  assert.equal(r.items[0].price, 0);
  assert.equal(r.amountPaid, 100);
  assert.ok(r.grandTotal > 0, 'grandTotal injected');
  assert.deepEqual(r.profile.paymentSettings, { zelle: 'acme@example.com' });
});

test('restore: redacted round-trip saves the owner values unchanged', () => {
  for (const a of [none, pricingOnly, finOnly]) {
    const redacted = R.redactRow(stored, a);
    const restored = R.restoreRow(redacted, a, {
      existing: stored,
      ownerSettingsProfile: null,
      itemIndex: new Map(),
    });
    assert.deepEqual(restored.items, stored.items);
    assert.equal(restored.laborRate, stored.laborRate);
    assert.equal(restored.amountPaid, stored.amountPaid);
    assert.equal(restored.taxAmount, stored.taxAmount);
    assert.deepEqual(restored.receiptDetails, stored.receiptDetails);
    assert.deepEqual(restored.profile, stored.profile);
    assert.equal(restored.grandTotal, undefined, 'injected key stripped');
  }
});

test('restore: crew edits (qty, new line, new receipt, description) are kept', () => {
  const redacted = R.redactRow(stored, none);
  redacted.items[0].qty = 12;
  redacted.items[0].description = 'Boards (more)';
  redacted.items.push({ id: 999, description: 'Crew added', qty: 1, price: 0, total: 0 });
  redacted.receiptUrls = ['r2.jpg'];
  const restored = R.restoreRow(redacted, none, {
    existing: stored,
    ownerSettingsProfile: null,
    itemIndex: new Map(),
  });
  assert.equal(restored.items[0].price, 12.5);
  assert.equal(restored.items[0].total, 150, 'total recomputed from owner price × new qty');
  assert.equal(restored.items[0].description, 'Boards (more)');
  assert.equal(restored.items[0].materialsList[0].unitPrice, 4);
  assert.equal(restored.items[2].description, 'Crew added');
  assert.equal(restored.items[2].price, 0);
  assert.deepEqual(restored.receiptUrls.sort(), ['r1.jpg', 'r2.jpg']);
});

test('restore: crew cannot erase hidden profile data or zero prices', () => {
  const evil = {
    id: 'EST-1',
    user_id: owner,
    items: [{ id: 101, description: 'Boards', qty: 10, price: 0, total: 0 }],
    laborRate: 0,
    profile: { company: 'Acme', paymentSettings: { zelle: 'attacker@example.com' } },
  };
  const restored = R.restoreRow(evil, none, {
    existing: stored,
    ownerSettingsProfile: null,
    itemIndex: new Map(),
  });
  assert.equal(restored.items[0].price, 12.5);
  assert.equal(restored.laborRate, 60);
  assert.deepEqual(restored.profile.paymentSettings, { zelle: 'acme@example.com' });
  assert.deepEqual(restored.profile.aiPriceMemory, { pine: 4 });
});

test('restore: new document copied from an estimate gets prices from the item index', () => {
  const redacted = R.redactRow(stored, none);
  const newInvoice = { ...redacted, id: 'INV-1', documentType: 'invoice' };
  const restored = R.restoreRow(newInvoice, none, {
    existing: null,
    ownerSettingsProfile: stored.profile,
    itemIndex: R.buildItemIndex([stored]),
  });
  assert.equal(restored.items[0].price, 12.5);
  assert.equal(restored.items[1].total, 300);
  assert.deepEqual(restored.profile.paymentSettings, stored.profile.paymentSettings);
  assert.equal(restored.profile.depositMinimumAmount, 250);
});

test('items stored as a JSON string keep their shape', () => {
  const row = { ...stored, items: JSON.stringify(stored.items) };
  const r = R.redactRow(row, none);
  assert.equal(typeof r.items, 'string');
  assert.equal(JSON.parse(r.items)[0].price, 0);
  const back = R.restoreRow(r, none, { existing: row, ownerSettingsProfile: null, itemIndex: new Map() });
  assert.deepEqual(JSON.parse(back.items), stored.items);
});

test('money key detection', () => {
  for (const k of ['price', 'total', 'unitPrice', 'laborRate', 'discountAmount', 'cost', 'amount'])
    assert.ok(R.isMoneyKey(k), k);
  for (const k of [
    'taxRate',
    'qty',
    'hours',
    'description',
    'depositPercentage',
    'ccFeePercentage',
    'translation',
    'translationLang',
    'translatedAt',
    'translationSource',
  ])
    assert.ok(!R.isMoneyKey(k), k);
});

test('restricted crew redaction keeps line-item translation fields', () => {
  const row = {
    ...stored,
    items: stored.items.map((it, i) =>
      i === 0
        ? {
            ...it,
            translation: 'Tablones',
            translationLang: 'es',
            translatedAt: '2026-11-20T16:00:00.000Z',
            translationSource: 'Boards',
          }
        : it
    ),
  };
  const r = R.redactRow(row, none);
  assert.equal(r.items[0].price, 0);
  assert.equal(r.items[0].description, 'Boards');
  assert.equal(r.items[0].translation, 'Tablones');
  assert.equal(r.items[0].translationLang, 'es');
  assert.equal(r.items[0].translatedAt, '2026-11-20T16:00:00.000Z');
  assert.equal(r.items[0].translationSource, 'Boards');
  const restored = R.restoreRow(r, none, {
    existing: row,
    ownerSettingsProfile: row.profile,
    itemIndex: new Map(),
  });
  assert.equal(restored.items[0].translation, 'Tablones');
  assert.equal(restored.items[0].price, 12.5);
});
