// Dashboard Leads boxes (AI Receptionist / Email summaries) must fit narrow phones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(path.join(root, 'app/page.tsx'), 'utf8');
const css = readFileSync(path.join(root, 'app/globals.css'), 'utf8');

test('leads grid is single minmax(0,1fr) column on phones and boxes can shrink', () => {
  assert.match(page, /className=\{`grid min-w-0 grid-cols-1 gap-4 \$\{/);
  assert.equal(
    (page.match(/min-w-0 rounded-2xl border border-slate-200 bg-slate-50\/80 p-4 min-h-\[180px\]/g) || []).length,
    2
  );
  assert.doesNotMatch(page, /<div className="rounded-2xl border border-slate-200 bg-slate-50\/80 p-4 min-h-\[180px\]">/);
});

test('native app keeps side safe-area insets on phones', () => {
  assert.match(css, /html\.native-app \.app-shell-main \{\s*padding-left: max\(1rem, env\(safe-area-inset-left/);
});

test('bottom nav labels stay spaced and can wrap on narrow phones', () => {
  assert.match(page, /className="app-shell-bottom-nav border-t shadow-inner flex items-center justify-around pt-2 px-1 no-print"/);
  // typography is owned by CSS (clamp / media queries), not a fixed text-xs on the nav
  assert.doesNotMatch(
    page,
    /className="app-shell-bottom-nav[^"]*text-xs/
  );
  const items = page.match(/app-shell-bottom-nav-item/g) || [];
  const labels = page.match(/app-shell-bottom-nav-label/g) || [];
  const icons = page.match(/app-shell-bottom-nav-icon/g) || [];
  assert.equal(items.length, 7, 'all seven nav buttons use the item class');
  assert.equal(labels.length, 7, 'all seven nav labels use the label class');
  assert.equal(icons.length, 7, 'all seven nav icons use the icon class');
  assert.equal((page.match(/app-shell-bottom-nav-item[^"]*min-w-0/g) || []).length, 7);

  assert.match(css, /\.app-shell-bottom-nav-item\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.app-shell-bottom-nav-item\s*\{[^}]*min-height:\s*2\.75rem/);
  assert.match(css, /\.app-shell-bottom-nav-label\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /\.app-shell-bottom-nav-label\s*\{[^}]*overflow-wrap:\s*normal/);
  assert.match(css, /\.app-shell-bottom-nav\s*\{[^}]*font-size:\s*clamp\(0\.5rem,\s*2\.45vw,\s*0\.75rem\)/);
  assert.match(css, /\.app-shell-bottom-nav-item\s*\{[^}]*container-type:\s*inline-size/);
  assert.match(css, /\.app-shell-bottom-nav-label\s*\{[^}]*font-size:\s*min\(1em,\s*17\.5cqw\)/);
  assert.match(css, /\.app-shell-bottom-nav-label\s*\{[^}]*word-break:\s*normal/);
  assert.match(css, /@media \(max-width: 439\.98px\)/);
  assert.match(css, /@media \(max-width: 359\.98px\)/);
});
