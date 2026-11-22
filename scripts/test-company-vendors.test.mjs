// Run: npm run test:company-vendors — saved labor vendors (picker, one-time vs save, RLS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadTsModule(relPath, mocks = {}) {
  const full = path.join(root, relPath);
  const srcText = readFileSync(full, 'utf8');
  const transpiled = ts.transpileModule(srcText, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const localRequire = (spec) => {
    if (spec in mocks) return mocks[spec];
    if (spec.startsWith('@/')) {
      const target = spec.slice(2);
      const candidates = [
        path.join(root, target + '.ts'),
        path.join(root, target + '.tsx'),
        path.join(root, target, 'index.ts'),
      ];
      for (const c of candidates) {
        if (existsSync(c)) return loadTsModule(path.relative(root, c), mocks);
      }
    }
    return require(spec);
  };
  const fn = new Function('require', 'module', 'exports', transpiled);
  fn(localRequire, mod, mod.exports);
  return mod.exports;
}

const V = loadTsModule('lib/company-vendors.ts');
const L = loadTsModule('lib/labor-logs.ts');
const src = (p) => readFileSync(path.join(root, p), 'utf8');

const owner = '3f6c2a1e-1111-4222-8333-944455556666';

function sampleVendor(over = {}) {
  return V.normalizeCompanyVendor({
    id: 'vend-1',
    company_id: owner,
    name: 'Harbor Framing',
    trade: 'Carpentry',
    phone: '555-0101',
    email: 'harbor@example.com',
    rate: 65,
    created_at: '2026-11-22T00:00:00.000Z',
    updated_at: '2026-11-22T00:00:00.000Z',
    ...over,
  });
}

test('normalizeCompanyVendor maps snake_case rows and drops blank names', () => {
  const v = sampleVendor();
  assert.equal(v.name, 'Harbor Framing');
  assert.equal(v.companyId, owner);
  assert.equal(v.trade, 'Carpentry');
  assert.equal(v.rate, 65);
  assert.equal(V.normalizeCompanyVendor({ company_id: owner, name: '  ' }), null);
  assert.equal(V.normalizeCompanyVendor(null), null);
  const noRate = V.normalizeCompanyVendor({
    id: 'v2',
    company_id: owner,
    name: 'One-off Pete',
    rate: null,
  });
  assert.equal(noRate.rate, null);
});

test('picking a saved vendor fills draft fields and default rate', () => {
  const v = sampleVendor();
  const draft = V.vendorToDraft(v);
  assert.deepEqual(draft, {
    vendorId: 'vend-1',
    name: 'Harbor Framing',
    trade: 'Carpentry',
    phone: '555-0101',
    email: 'harbor@example.com',
  });
  assert.equal(V.applyVendorRate(v, 40), 65);
  assert.equal(V.applyVendorRate(sampleVendor({ rate: null }), 40), 40);
  assert.equal(V.applyVendorRate(sampleVendor({ rate: 0 }), 40), 40);
});

test('one-time use stays on the labor line and is not marked to save', () => {
  const draft = {
    vendorId: '',
    name: 'Temp Helper',
    trade: 'Cleanup',
    phone: '555-0199',
    email: '',
  };
  assert.equal(
    V.shouldSaveNewVendor({ canManage: true, saveVendor: false, name: draft.name, selectedId: '' }),
    false
  );
  const snap = V.vendorSnapshotFromDraft(draft);
  assert.equal(snap.vendorName, 'Temp Helper');
  assert.equal(snap.trade, 'Cleanup');
  assert.equal(snap.phone, '555-0199');
  assert.equal(snap.vendorId, undefined);

  const logs = L.normalizeLaborLogs([
    { id: 'labor-1', hours: 4, rate: 40, memo: '', total: 160, ...snap },
  ]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].vendorName, 'Temp Helper');
  assert.equal(logs[0].trade, 'Cleanup');
  assert.equal(logs[0].phone, '555-0199');
  assert.equal(logs[0].memo, 'Temp Helper');
});

test('Save this vendor is owner-only and requires a new named vendor', () => {
  assert.equal(V.canWriteCompanyVendors(false), true);
  assert.equal(V.canWriteCompanyVendors(true), false);
  assert.equal(
    V.shouldSaveNewVendor({ canManage: true, saveVendor: true, name: 'Ada', selectedId: '' }),
    true
  );
  assert.equal(
    V.shouldSaveNewVendor({ canManage: false, saveVendor: true, name: 'Ada', selectedId: '' }),
    false
  );
  assert.equal(
    V.shouldSaveNewVendor({ canManage: true, saveVendor: true, name: 'Ada', selectedId: 'vend-1' }),
    false
  );
  assert.equal(
    V.shouldSaveNewVendor({ canManage: true, saveVendor: true, name: '  ', selectedId: '' }),
    false
  );
});

test('labor memo falls back to vendor name unless a note is typed', () => {
  const draft = V.emptyVendorDraft();
  draft.name = 'Sam the painter';
  assert.equal(V.laborMemoFromVendor(draft, ''), 'Sam the painter');
  assert.equal(V.laborMemoFromVendor(draft, '  Paid extra for trim  '), 'Paid extra for trim');
});

test('vendorRowForWrite scopes the row to company_id and trims fields', () => {
  const row = V.vendorRowForWrite(
    owner,
    { vendorId: '', name: '  Sue  ', trade: 'Paint', phone: '', email: 'sue@example.com' },
    55.5
  );
  assert.equal(row.company_id, owner);
  assert.equal(row.name, 'Sue');
  assert.equal(row.trade, 'Paint');
  assert.equal(row.phone, null);
  assert.equal(row.email, 'sue@example.com');
  assert.equal(row.rate, 55.5);
});

test('migration creates company_vendors with owner writes and crew reads', () => {
  const sql = src('supabase/company-vendors-2026-11.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.company_vendors/);
  assert.match(sql, /company_id UUID NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /Owners and crew can read company_vendors/);
  assert.match(sql, /auth\.uid\(\) = company_id\s+OR public\.is_crew_of\(company_id\)/s);
  assert.match(sql, /Owners can insert company_vendors/);
  assert.match(sql, /Owners can update company_vendors/);
  assert.match(sql, /Owners can delete company_vendors/);
  assert.match(sql, /WITH CHECK \(auth\.uid\(\) = company_id\)/);
  assert.match(sql, /USING \(auth\.uid\(\) = company_id\)/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.company_vendors FROM anon/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.company_vendors TO authenticated/);
  assert.match(sql, /idx_company_vendors_company_name/);
  assert.doesNotMatch(sql, /FOR ALL[\s\S]*is_crew_of/);
});

test('labor popup wires the picker, save checkbox, and manage actions', () => {
  const page = src('app/page.tsx');
  const picker = src('components/LaborVendorPicker.tsx');
  assert.match(page, /from '@\/components\/LaborVendorPicker'/);
  assert.match(page, /from '@\/lib\/company-vendors'/);
  assert.match(page, /<LaborVendorPicker/);
  assert.match(page, /canWriteCompanyVendors\(Boolean\(currentCrew\)\)/);
  assert.match(page, /\.from\('company_vendors'\)/);
  assert.match(page, /saveNewVendorIfRequested/);
  assert.match(picker, /data-testid="labor-vendor-picker"/);
  assert.match(picker, /data-testid="labor-saved-vendor-select"/);
  assert.match(picker, /data-testid="labor-save-vendor-toggle"/);
  assert.match(picker, /data-testid="labor-update-saved-vendor"/);
  assert.match(picker, /data-testid="labor-delete-saved-vendor"/);
  assert.match(picker, /Save this vendor/);
  assert.match(picker, /Add a new vendor/);
  assert.match(picker, /Leave unchecked for one-time use/);
  // Mobile-friendly controls: full-width select, 44px-ish targets, stacked fields
  assert.match(picker, /className="h-11 w-full min-w-0/);
  assert.match(picker, /grid grid-cols-1 min-\[400px\]:grid-cols-2/);
  assert.match(picker, /flex flex-col min-\[400px\]:flex-row/);
  assert.match(picker, /min-h-11/);
});

test('account purge includes company_vendors by company_id', () => {
  const purge = src('lib/account-purge.ts');
  const delTest = src('scripts/test-account-deletion.test.mjs');
  assert.match(purge, /table: 'company_vendors', column: 'company_id'/);
  assert.match(delTest, /'company_vendors'/);
});
