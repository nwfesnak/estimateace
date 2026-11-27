import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function loadTs(relPath, mocks = {}) {
  const full = join(root, relPath);
  const src = readFileSync(full, 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: relPath,
  });
  const module = { exports: {} };
  const localRequire = (spec) => {
    if (spec in mocks) return mocks[spec];
    if (spec.startsWith('@/')) {
      const target = spec.slice(2);
      const candidates = [join(root, target + '.ts'), join(root, target + '.tsx'), join(root, target, 'index.ts')];
      for (const c of candidates) {
        if (existsSync(c)) return loadTs(relative(root, c), mocks);
      }
    }
    return require(spec);
  };
  const fn = new Function('require', 'module', 'exports', outputText);
  fn(localRequire, module, module.exports);
  return module.exports;
}

const {
  BLANK_DRAFT_MAX_AGE_MS,
  BLANK_NOTHING_TO_SAVE_MESSAGE,
  hasMeaningfulEstimateInput,
  shouldInsertNewDocument,
  isWorkspaceDocumentId,
  isSentOrNonDraftDocument,
  canDiscardBlankDraft,
  defaultTermsFromSettingsProfile,
  normalizeTermsText,
} = loadTs('lib/blank-estimate.ts');

const emptyLine = { id: 1, description: '', qty: 1, unit: '', price: 0, total: 0 };

function blankDoc(overrides = {}) {
  return {
    id: 'EST-ABC123-0007',
    user_id: 'owner-1',
    jobName: '',
    address: '',
    city: '',
    state: '',
    zipCode: '',
    phones: [''],
    emails: [''],
    date: '2026-11-27',
    invoiceNumber: 'EST-ABC123-0007',
    items: [emptyLine],
    terms: 'Standard company terms go here.',
    profile: {
      disclosure: 'Standard company terms go here.',
      taxesEnabled: true,
      showDiscountOnEstimate: false,
    },
    documentType: 'estimate',
    dueDate: '',
    paymentStatus: 'pending',
    amountPaid: 0,
    paymentMethod: '',
    photoUrls: [],
    videoUrls: [],
    receiptUrls: [],
    receiptDetails: [],
    laborHours: 0,
    laborRate: 0,
    laborAmount: 0,
    taxRate: 7.25,
    taxAmount: 0,
    isTaxExempt: false,
    taxLabor: true,
    created_at: '2026-11-27T15:00:00.000Z',
    ...overrides,
  };
}

const defaultTerms = 'Standard company terms go here.';

test('defaults alone are not meaningful input', () => {
  assert.equal(hasMeaningfulEstimateInput(blankDoc(), { defaultTerms }), false);
  assert.equal(hasMeaningfulEstimateInput(blankDoc({ terms: '', taxRate: 9.5, date: '2026-01-01' }), { defaultTerms: '' }), false);
  assert.equal(
    hasMeaningfulEstimateInput(
      blankDoc({
        items: [{ id: 99, description: '   ', qty: 1, unit: '', price: 0, total: 0 }],
        phones: ['', '  '],
        emails: [null],
      }),
      { defaultTerms }
    ),
    false
  );
});

test('company template terms do not count; edited or unique terms do', () => {
  assert.equal(
    hasMeaningfulEstimateInput(blankDoc({ terms: '  Standard   company terms go here.  ' }), { defaultTerms }),
    false
  );
  assert.equal(
    hasMeaningfulEstimateInput(blankDoc({ terms: 'Please pay within 10 days.' }), { defaultTerms }),
    true
  );
  assert.equal(normalizeTermsText('  Standard   company terms go here.  '), normalizeTermsText(defaultTerms));
});

test('client fields count as meaningful input', () => {
  for (const override of [
    { jobName: 'Kitchen remodel' },
    { address: '12 Main St' },
    { city: 'Raleigh' },
    { state: 'NC' },
    { zipCode: '27601' },
    { zipcode: '27601' },
    { phones: ['555-0100'] },
    { emails: ['pat@example.com'] },
  ]) {
    assert.equal(hasMeaningfulEstimateInput(blankDoc(override), { defaultTerms }), true, String(Object.keys(override)));
  }
});

test('line items count when they have a description, unit, price, non-default qty, or photos', () => {
  assert.equal(
    hasMeaningfulEstimateInput(blankDoc({ items: [{ ...emptyLine, description: 'Tear out' }] }), { defaultTerms }),
    true
  );
  assert.equal(
    hasMeaningfulEstimateInput(blankDoc({ items: [{ ...emptyLine, unit: 'sf' }] }), { defaultTerms }),
    true
  );
  assert.equal(
    hasMeaningfulEstimateInput(blankDoc({ items: [{ ...emptyLine, price: 25 }] }), { defaultTerms }),
    true
  );
  assert.equal(
    hasMeaningfulEstimateInput(blankDoc({ items: [{ ...emptyLine, qty: 3 }] }), { defaultTerms }),
    true
  );
  assert.equal(
    hasMeaningfulEstimateInput(blankDoc({ items: [{ ...emptyLine, photos: ['uid/line-photo/a.jpg'] }] }), { defaultTerms }),
    true
  );
  assert.equal(
    hasMeaningfulEstimateInput(blankDoc({ items: [emptyLine, { ...emptyLine, notes: 'Match existing tile' }] }), { defaultTerms }),
    true
  );
});

test('photos, videos, receipts, renderings, labor, mileage, discounts, due date, and tax-exempt count', () => {
  assert.equal(hasMeaningfulEstimateInput(blankDoc({ photoUrls: ['uid/photo/a.jpg'] }), { defaultTerms }), true);
  assert.equal(hasMeaningfulEstimateInput(blankDoc({ videoUrls: ['uid/video/a.mp4'] }), { defaultTerms }), true);
  assert.equal(hasMeaningfulEstimateInput(blankDoc({ receiptUrls: ['uid/receipt/a.jpg'] }), { defaultTerms }), true);
  assert.equal(
    hasMeaningfulEstimateInput(blankDoc({ receiptDetails: [{ vendor: 'Lowes', amount: 12 }] }), { defaultTerms }),
    true
  );
  assert.equal(
    hasMeaningfulEstimateInput(
      blankDoc({ profile: { _jobRenderings: [{ id: 'r1' }] } }),
      { defaultTerms }
    ),
    true
  );
  assert.equal(
    hasMeaningfulEstimateInput(
      blankDoc({ profile: { _laborLogs: [{ id: 'l1', hours: 2, rate: 40, total: 80, memo: 'Bob' }] } }),
      { defaultTerms }
    ),
    true
  );
  assert.equal(
    hasMeaningfulEstimateInput(blankDoc({ laborHours: 3, laborAmount: 120 }), { defaultTerms }),
    true
  );
  assert.equal(
    hasMeaningfulEstimateInput(
      blankDoc({ profile: { _mileageLogs: [{ id: 'm1', miles: 12, purpose: 'dump' }] } }),
      { defaultTerms }
    ),
    true
  );
  assert.equal(
    hasMeaningfulEstimateInput(blankDoc({ profile: { _discount: { discountValue: 50 } } }), { defaultTerms }),
    true
  );
  assert.equal(hasMeaningfulEstimateInput(blankDoc({ dueDate: '2026-12-01' }), { defaultTerms }), true);
  assert.equal(hasMeaningfulEstimateInput(blankDoc({ isTaxExempt: true }), { defaultTerms }), true);
  assert.equal(hasMeaningfulEstimateInput(blankDoc({ amountPaid: 25 }), { defaultTerms }), true);
});

test('lowercase database columns are recognized the same way', () => {
  const row = {
    id: 'EST-ABC123-0008',
    user_id: 'owner-1',
    jobname: 'Deck',
    address: '',
    city: '',
    state: '',
    zipcode: '',
    phones: [],
    emails: [],
    items: [],
    terms: defaultTerms,
    photourls: [],
    documenttype: 'estimate',
    paymentstatus: 'pending',
    amountpaid: 0,
    created_at: '2026-11-27T15:00:00.000Z',
  };
  assert.equal(hasMeaningfulEstimateInput(row, { defaultTerms }), true);
  assert.equal(hasMeaningfulEstimateInput({ ...row, jobname: '' }, { defaultTerms }), false);
});

test('shouldInsertNewDocument is false for blanks and reserved ids, true once there is content', () => {
  assert.equal(shouldInsertNewDocument(blankDoc(), { defaultTerms }), false);
  assert.equal(shouldInsertNewDocument(blankDoc({ jobName: 'Shed' }), { defaultTerms }), true);
  assert.equal(shouldInsertNewDocument({ id: 'SETTINGS-owner-1', jobName: 'x' }), false);
  assert.equal(shouldInsertNewDocument({ id: 'REC-1', jobName: 'Weekly mow' }), false);
});

test('isWorkspaceDocumentId allows EST/INV numbers only', () => {
  assert.equal(isWorkspaceDocumentId('EST-ABC123-0001'), true);
  assert.equal(isWorkspaceDocumentId('INV-ABC123-0001'), true);
  assert.equal(isWorkspaceDocumentId('EST-0001'), true);
  assert.equal(isWorkspaceDocumentId('SETTINGS-owner-1'), false);
  assert.equal(isWorkspaceDocumentId('RECEPTIONIST-SECRETS-owner-1'), false);
  assert.equal(isWorkspaceDocumentId('PLATFORM-TUTORIALS'), false);
  assert.equal(isWorkspaceDocumentId('REC-123'), false);
  assert.equal(isWorkspaceDocumentId('INV-REC-1'), false);
});

test('sent, approved, paid, and reserved rows are non-draft', () => {
  assert.equal(isSentOrNonDraftDocument(blankDoc()), false);
  assert.equal(
    isSentOrNonDraftDocument(blankDoc({ profile: { _invoiceSentAt: '2026-11-27T16:00:00.000Z' } })),
    true
  );
  assert.equal(
    isSentOrNonDraftDocument(blankDoc({ profile: { _estimateApprovedAt: '2026-11-27T16:00:00.000Z' } })),
    true
  );
  assert.equal(isSentOrNonDraftDocument(blankDoc({ paymentStatus: 'paid' })), true);
  assert.equal(isSentOrNonDraftDocument(blankDoc({ amountPaid: 10 })), true);
  assert.equal(isSentOrNonDraftDocument(blankDoc({ id: 'SETTINGS-owner-1' })), true);
});

test('canDiscardBlankDraft allows only owned, recent, blank drafts', () => {
  const row = blankDoc();
  assert.deepEqual(
    canDiscardBlankDraft(row, { ownerUserId: 'owner-1', defaultTerms, now: '2026-11-27T16:00:00.000Z' }),
    { ok: true }
  );

  assert.equal(
    canDiscardBlankDraft(row, { ownerUserId: 'someone-else', defaultTerms, now: '2026-11-27T16:00:00.000Z' }).reason,
    'not_owned'
  );
  assert.equal(
    canDiscardBlankDraft(blankDoc({ jobName: 'Patio' }), {
      ownerUserId: 'owner-1',
      defaultTerms,
      now: '2026-11-27T16:00:00.000Z',
    }).reason,
    'has_content'
  );
  assert.equal(
    canDiscardBlankDraft(blankDoc({ profile: { _invoiceSentAt: '2026-11-27T15:30:00.000Z' } }), {
      ownerUserId: 'owner-1',
      defaultTerms,
      now: '2026-11-27T16:00:00.000Z',
    }).reason,
    'not_draft'
  );
  assert.equal(
    canDiscardBlankDraft(row, {
      ownerUserId: 'owner-1',
      defaultTerms,
      now: '2026-11-30T16:00:00.000Z',
    }).reason,
    'too_old'
  );
  assert.equal(
    canDiscardBlankDraft(blankDoc({ created_at: undefined }), {
      ownerUserId: 'owner-1',
      defaultTerms,
      now: '2026-11-27T16:00:00.000Z',
    }).reason,
    'too_old'
  );
  assert.equal(
    canDiscardBlankDraft(row, {
      ownerUserId: 'owner-1',
      defaultTerms,
      sessionCreatedIds: ['EST-OTHER-0001'],
    }).reason,
    'not_in_session'
  );
  assert.deepEqual(
    canDiscardBlankDraft(row, {
      ownerUserId: 'owner-1',
      defaultTerms,
      sessionCreatedIds: [row.id],
    }),
    { ok: true }
  );
  assert.equal(
    canDiscardBlankDraft(blankDoc({ id: 'SETTINGS-owner-1' }), { ownerUserId: 'owner-1', defaultTerms }).reason,
    'reserved'
  );
});

test('discard max age is 48 hours and empty-save copy is set', () => {
  assert.equal(BLANK_DRAFT_MAX_AGE_MS, 48 * 60 * 60 * 1000);
  assert.match(BLANK_NOTHING_TO_SAVE_MESSAGE, /Nothing to save yet/i);
  assert.equal(defaultTermsFromSettingsProfile({ disclosure: '  Pay net 30  ' }), 'Pay net 30');
});

const page = readFileSync(join(root, 'app/page.tsx'), 'utf8');
const saveApi = readFileSync(join(root, 'app/api/documents/save/route.ts'), 'utf8');
const discardApi = readFileSync(join(root, 'app/api/documents/discard-blank/route.ts'), 'utf8');

test('editor save and autosave go through the shared meaningful-input helper', () => {
  assert.match(page, /from '@\/lib\/blank-estimate'/);
  assert.match(page, /hasMeaningfulEstimateInput\(/);
  assert.match(page, /sessionCreatedDocIdsRef/);
  assert.match(page, /shouldInsertNewDocument\(/);
  assert.match(page, /discardBlankSessionDraft/);
  assert.match(page, /\/api\/documents\/discard-blank/);
  assert.match(page, /BLANK_NOTHING_TO_SAVE_MESSAGE/);
  // Autosave and flush must use the helper, not a narrower inline check only
  const flush = page.slice(page.indexOf('const flushPendingAutosave = async'), page.indexOf('const flushPendingAutosave = async') + 2200);
  assert.match(flush, /hasMeaningfulEstimateInput/);
  const debounce = page.slice(page.indexOf('const debouncedSave = () => {'), page.indexOf('const debouncedSave = () => {') + 3500);
  assert.match(debounce, /hasMeaningfulEstimateInput/);
  assert.match(page, /shouldInsertNewDocument/);
  assert.match(page, /sessionCreatedDocIdsRef\.current\.add/);
});

test('leaving the editor, starting a new document, loading another job, and page hide discard a session blank draft', () => {
  assert.match(page, /leavingEditor/);
  assert.match(page, /discardBlankSessionDraftRef\.current/);
  const fresh = page.slice(page.indexOf('const newEstimate = async'), page.indexOf('const newEstimate = async') + 1200);
  assert.match(fresh, /await flushPendingAutosaveRef\.current\(\)/);
  assert.match(fresh, /await discardBlankSessionDraftRef\.current\(\)/);
  assert.ok(
    fresh.indexOf('await flushPendingAutosaveRef.current()') < fresh.indexOf('await discardBlankSessionDraftRef.current()'),
    'flush previous job, then discard it if still blank, before resetting the form'
  );
  const load = page.slice(page.indexOf('const loadSelectedEstimate = async'), page.indexOf('const loadSelectedEstimate = async') + 900);
  assert.match(load, /await flushPendingAutosaveRef\.current\(\)/);
  assert.match(load, /await discardBlankSessionDraftRef\.current\(\)/);
  assert.ok(
    load.indexOf('await discardBlankSessionDraftRef.current()') < load.indexOf('loadedDocNumberRef.current ='),
    'must discard the previous blank draft before switching the loaded document id'
  );
  const hide = page.slice(page.indexOf('const flushAndDiscard = '), page.indexOf('const flushAndDiscard = ') + 1600);
  assert.match(hide, /addEventListener\('pagehide'/);
  assert.match(hide, /addEventListener\('beforeunload'/);
  assert.match(hide, /discardBlankSessionDraftRef\.current/);
  assert.match(hide, /flushAndDiscard\(true\)/);
});

test('server save refuses to insert a blank new document and discard-blank uses the same guard', () => {
  assert.match(saveApi, /shouldInsertNewDocument/);
  assert.match(saveApi, /blank_new_document/);
  assert.match(saveApi, /!ownsExisting/);
  assert.match(discardApi, /canDiscardBlankDraft/);
  assert.match(discardApi, /\.delete\(\)/);
  assert.match(discardApi, /user_id/);
  assert.match(discardApi, /SETTINGS-\$\{workspaceUserId\}/);
});
