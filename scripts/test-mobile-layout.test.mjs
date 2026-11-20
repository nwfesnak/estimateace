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
