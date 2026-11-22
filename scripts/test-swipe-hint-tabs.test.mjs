// Run: npm run test:swipe-hint-tabs — swipe-hint arrows on scrolling tab strips.
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

const T = loadTsModule('lib/swipe-hint-tabs.ts');
const src = (p) => readFileSync(path.join(root, p), 'utf8');

test('no arrows when every tab already fits', () => {
  assert.deepEqual(
    T.getTabStripOverflow({ scrollLeft: 0, scrollWidth: 360, clientWidth: 360 }),
    { canScrollLeft: false, canScrollRight: false }
  );
  assert.deepEqual(
    T.getTabStripOverflow({ scrollLeft: 0, scrollWidth: 359, clientWidth: 360 }),
    { canScrollLeft: false, canScrollRight: false }
  );
});

test('right arrow shows when more tabs are off-screen to the right', () => {
  // Typical 360px Company Profile: four tabs wider than the viewport, at rest.
  const atStart = T.getTabStripOverflow({ scrollLeft: 0, scrollWidth: 560, clientWidth: 360 });
  assert.equal(atStart.canScrollLeft, false);
  assert.equal(atStart.canScrollRight, true);

  const at440 = T.getTabStripOverflow({ scrollLeft: 0, scrollWidth: 560, clientWidth: 440 });
  assert.equal(at440.canScrollLeft, false);
  assert.equal(at440.canScrollRight, true);
});

test('left arrow appears once scrolled; right arrow hides at the end', () => {
  const mid = T.getTabStripOverflow({ scrollLeft: 80, scrollWidth: 560, clientWidth: 360 });
  assert.equal(mid.canScrollLeft, true);
  assert.equal(mid.canScrollRight, true);

  const end = T.getTabStripOverflow({ scrollLeft: 200, scrollWidth: 560, clientWidth: 360 });
  assert.equal(end.canScrollLeft, true);
  assert.equal(end.canScrollRight, false);

  // Within slop of the end still counts as the end.
  const almostEnd = T.getTabStripOverflow({ scrollLeft: 198.5, scrollWidth: 560, clientWidth: 360 });
  assert.equal(almostEnd.canScrollRight, false);
});

test('arrow tap scrolls by a large fraction of the visible width', () => {
  assert.equal(T.tabStripScrollAmount(360), Math.max(Math.round(360 * 0.7), 120));
  assert.equal(T.tabStripScrollAmount(440), Math.max(Math.round(440 * 0.7), 120));
  assert.ok(T.tabStripScrollAmount(360) >= 120);
  assert.equal(T.tabStripScrollAmount(0), 120);
});

test('Company Profile and crew account tab rows use the swipe-hint strip', () => {
  const page = src('app/page.tsx');
  const panel = src('components/SwipeHintTabStrip.tsx');
  assert.match(page, /from '@\/components\/SwipeHintTabStrip'/);
  assert.match(page, /<SwipeHintTabStrip className="border-b mb-8" data-testid="company-profile-tabs">/);
  assert.match(page, /<SwipeHintTabStrip className="border-b mb-8" data-testid="crew-account-tabs">/);
  assert.match(panel, /data-testid="swipe-hint-right"/);
  assert.match(panel, /data-testid="swipe-hint-left"/);
  assert.match(panel, /data-testid="swipe-hint-fade-right"/);
  assert.match(panel, /data-testid="swipe-hint-fade-left"/);
  assert.match(panel, /Show more tabs/);
  assert.match(panel, /Show previous tabs/);
  assert.match(panel, /scrollBy/);
  assert.match(panel, /WebkitOverflowScrolling/);
  assert.match(panel, /touchAction: 'pan-x'/);
  assert.match(panel, /getTabStripOverflow/);
  // Arrows are real buttons so they work in the iOS webview (not hover-only).
  assert.match(panel, /onClick=\{\(\) => scrollByDir\(1\)\}/);
  assert.match(panel, /onClick=\{\(\) => scrollByDir\(-1\)\}/);
  // Hints are hidden until overflow exists (conditional render).
  assert.match(panel, /canScrollRight && \(/);
  assert.match(panel, /canScrollLeft && \(/);
});
