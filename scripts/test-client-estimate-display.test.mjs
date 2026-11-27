// Run: npm run test:client-estimate-display
// Covers the 4 combinations of Client Estimate Display × Show Discount
// across customer view, PDF, and email presentation, plus wiring.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);

const root = process.cwd();
const tsModuleCache = new Map();

function loadTsModule(relPath, mocks = {}) {
  const full = path.join(root, relPath);
  const cacheKey = path.resolve(full);
  if (tsModuleCache.has(cacheKey)) return tsModuleCache.get(cacheKey).exports;
  const src = fs.readFileSync(full, 'utf8');
  const transpiled = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  tsModuleCache.set(cacheKey, mod);
  const localRequire = (spec) => {
    if (spec in mocks) return mocks[spec];
    const dir = path.dirname(full);
    const resolved = [];
    if (spec.startsWith('@/')) {
      const target = spec.slice(2);
      resolved.push(
        path.join(root, target + '.ts'),
        path.join(root, target + '.tsx'),
        path.join(root, target, 'index.ts')
      );
    } else if (spec.startsWith('.')) {
      resolved.push(
        path.join(dir, spec + '.ts'),
        path.join(dir, spec + '.tsx'),
        path.join(dir, spec, 'index.ts'),
        path.join(dir, spec + '.js')
      );
    }
    for (const c of resolved) {
      if (fs.existsSync(c)) return loadTsModule(path.relative(root, c), mocks);
    }
    return require(spec);
  };
  const fn = new Function('require', 'module', 'exports', transpiled);
  fn(localRequire, mod, mod.exports);
  return mod.exports;
}

const src = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const display = loadTsModule('lib/client-estimate-display.ts');
const jobSettings = loadTsModule('lib/job-settings-snapshot.ts');

const COMBOS = [
  { name: 'display ON, discount ON', showClientEstimateDisplay: true, showDiscountOnEstimate: true },
  { name: 'display ON, discount OFF', showClientEstimateDisplay: true, showDiscountOnEstimate: false },
  { name: 'display OFF, discount ON', showClientEstimateDisplay: false, showDiscountOnEstimate: true },
  { name: 'display OFF, discount OFF', showClientEstimateDisplay: false, showDiscountOnEstimate: false },
];

const SURFACES = ['customer', 'pdf', 'email'];
const fixture = display.SAMPLE_PROOF_FIXTURE;

test('resolvers: missing Client Estimate Display defaults to true (existing users keep breakdowns)', () => {
  assert.equal(display.resolveShowClientEstimateDisplay({}, {}), true);
  assert.equal(display.resolveShowClientEstimateDisplay({ showClientEstimateDisplay: false }, {}), false);
  assert.equal(display.resolveShowClientEstimateDisplay({}, { showClientEstimateDisplay: false }), false);
  assert.equal(
    display.resolveShowClientEstimateDisplay(
      { showClientEstimateDisplay: true },
      { showClientEstimateDisplay: false }
    ),
    true,
    'job snapshot wins over the company default'
  );
});

test('resolvers: missing Show Discount defaults to true so customer/email keep showing an existing discount', () => {
  assert.equal(display.resolveShowDiscountOnEstimate({}, {}), true);
  assert.equal(display.resolveShowDiscountOnEstimate({ showDiscountOnEstimate: false }, {}), false);
  assert.equal(display.resolveShowDiscountOnEstimate({}, { showDiscountOnEstimate: true }), true);
});

test('all 4 flag combinations present independently on customer view, PDF, and email', () => {
  let checked = 0;
  for (const flags of COMBOS) {
    const presentation = display.presentClientEstimate({
      ...flags,
      discountAmount: fixture.discountAmount,
      breakdownSettings: fixture.breakdownSettings,
    });

    assert.equal(presentation.showDiscountLine, flags.showDiscountOnEstimate);
    assert.equal(presentation.showSubtotalBeforeDiscount, flags.showDiscountOnEstimate);
    assert.equal(presentation.showItemBreakdowns, flags.showClientEstimateDisplay);
    assert.equal(
      presentation.breakdownSettings.showMaterialBreakdownOnEstimate,
      flags.showClientEstimateDisplay
    );
    assert.equal(
      presentation.breakdownSettings.showLaborBreakdownOnEstimate,
      flags.showClientEstimateDisplay
    );
    assert.equal(
      presentation.breakdownSettings.showCostBreakdownOnEstimate,
      flags.showClientEstimateDisplay
    );

    for (const surface of SURFACES) {
      const html = display.renderClientEstimateSurfaceHtml(surface, fixture, flags);
      assert.match(html, /Grand total: \$2250\.00/);
      assert.match(html, /Interior paint/);
      assert.equal(
        html.includes('data-proof="discount-line"'),
        flags.showDiscountOnEstimate,
        `${flags.name} ${surface} discount line`
      );
      assert.equal(
        html.includes('data-proof="subtotal-before-discount"'),
        flags.showDiscountOnEstimate,
        `${flags.name} ${surface} must not leak a hidden discount via subtotal`
      );
      assert.equal(
        html.includes('Military'),
        flags.showDiscountOnEstimate,
        `${flags.name} ${surface} discount name`
      );
      assert.equal(
        html.includes('data-proof="item-breakdown"'),
        flags.showClientEstimateDisplay,
        `${flags.name} ${surface} breakdowns`
      );
      assert.equal(
        /Materials needed/i.test(html),
        flags.showClientEstimateDisplay,
        `${flags.name} ${surface} materials`
      );
      assert.equal(
        /Labor:/i.test(html) || /Labor —/i.test(html) || /hrs/.test(html),
        flags.showClientEstimateDisplay,
        `${flags.name} ${surface} labor`
      );
      // Discount visibility must not change whether breakdowns appear, and vice versa.
      if (flags.showDiscountOnEstimate && !flags.showClientEstimateDisplay) {
        assert.match(html, /data-proof="discount-line"/);
        assert.doesNotMatch(html, /data-proof="item-breakdown"/);
      }
      if (!flags.showDiscountOnEstimate && flags.showClientEstimateDisplay) {
        assert.doesNotMatch(html, /data-proof="discount-line"/);
        assert.match(html, /data-proof="item-breakdown"/);
      }
      checked += 1;
    }
  }
  assert.equal(checked, 12, '4 combinations × 3 surfaces');
});

test('email helper HTML includes the discount description only when the discount toggle is on', () => {
  const on = display.renderEmailDiscountRowsHtml({
    showDiscountLine: true,
    subtotalBeforeDiscount: 2500,
    discountAmount: 250,
    discountDescription: 'Military',
  });
  assert.match(on, /Military/);
  assert.match(on, /\$2500\.00/);
  assert.match(on, /−\$250\.00/);
  const off = display.renderEmailDiscountRowsHtml({
    showDiscountLine: false,
    subtotalBeforeDiscount: 2500,
    discountAmount: 250,
    discountDescription: 'Military',
  });
  assert.equal(off, '');
});

test('job snapshot stores Client Estimate Display independently of Show Discount', () => {
  const snap = jobSettings.buildNewJobSettingsSnapshot({
    showDiscountOnEstimate: false,
    showClientEstimateDisplay: true,
  });
  assert.equal(snap.showDiscountOnEstimate, false);
  assert.equal(snap.showClientEstimateDisplay, true);

  const later = jobSettings.buildNewJobSettingsSnapshot({
    showDiscountOnEstimate: true,
    showClientEstimateDisplay: false,
  });
  const resolved = jobSettings.resolveJobSettingsFromDoc(snap, later);
  assert.equal(resolved.showDiscountOnEstimate, false, 'job keeps its own discount flag');
  assert.equal(resolved.showClientEstimateDisplay, true, 'job keeps its own display flag');
  assert.equal(jobSettings.DEFAULT_JOB_SETTINGS_SNAPSHOT.showClientEstimateDisplay, true);
});

test('legacy jobs without the new field default to showing client estimate display', () => {
  const resolved = jobSettings.resolveJobSettingsFromDoc({}, { showDiscountOnEstimate: true });
  assert.equal(resolved.showClientEstimateDisplay, true);
});

test('Company Profile UI is two separate cards that each save only their own field', () => {
  const page = src('app/page.tsx');
  assert.match(page, /data-testid="client-estimate-display-card"/);
  assert.match(page, /data-testid="show-discount-on-estimate-card"/);
  assert.match(
    page,
    /saveBreakdownProfileSettings\(\{\s*showClientEstimateDisplay:\s*checked\s*\}\)/
  );
  assert.match(
    page,
    /saveBreakdownProfileSettings\(\{\s*showDiscountOnEstimate:\s*checked\s*\}\)/
  );
  // The old single-card heading-plus-only-discount-toggle is gone.
  assert.doesNotMatch(
    page,
    /Material, labor, and cost breakdown buttons are on the estimate editor \(above Add Line Item\)\./
  );
});

test('PDF/preview hides breakdowns when Client Estimate Display is off and does not leak a hidden discount', () => {
  const page = src('app/page.tsx');
  assert.match(page, /if \(!getShowClientEstimateDisplay\(\)\) return null;/);
  assert.match(page, /shouldShowClientDiscount\(\) && \(/);
  assert.match(page, /Subtotal before discount/);
  // The leak: "Subtotal before discount" used to be gated only by hasActiveDiscount().
  assert.doesNotMatch(
    page,
    /\{hasActiveDiscount\(\) && \(\s*<div className=\{`text-right font-semibold text-gray-700 \$\{textClass\}`\}>\s*Subtotal before discount/
  );
});

test('email send honors both flags instead of always showing a discount when the amount is > 0', () => {
  const send = src('app/api/documents/send/route.ts');
  assert.match(send, /presentClientEstimate/);
  assert.match(send, /body\.showDiscountOnEstimate === true/);
  assert.match(send, /body\.showClientEstimateDisplay !== false/);
  assert.match(send, /renderEmailDiscountRowsHtml/);
  assert.match(send, /itemBreakdownForEmailHtml/);
  assert.doesNotMatch(send, /const showDiscount = discountAmount > 0\.005/);
});

test('customer document API and approve page honor both flags', () => {
  const api = src('app/api/client/document/route.ts');
  assert.match(api, /showDiscountOnEstimate: resolveShowDiscountOnEstimate/);
  assert.match(api, /showClientEstimateDisplay: resolveShowClientEstimateDisplay/);
  assert.match(api, /itemBreakdownForCustomerHtml/);
  const approve = src('app/client/approve/page.tsx');
  assert.match(approve, /doc\?\.showDiscountOnEstimate !== false/);
  assert.match(approve, /it\.breakdownHtml/);
});

test('editor send payload includes both independent flags', () => {
  const page = src('app/page.tsx');
  assert.match(page, /showDiscountOnEstimate: getShowDiscountOnEstimate\(\)/);
  assert.match(page, /showClientEstimateDisplay: getShowClientEstimateDisplay\(\)/);
});
