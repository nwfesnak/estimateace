import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);

const root = process.cwd();

function loadTsModule(relPath, mocks = {}) {
  const full = path.join(root, relPath);
  const src = fs.readFileSync(full, 'utf8');
  const transpiled = ts.transpileModule(src, {
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
        if (fs.existsSync(c)) return loadTsModule(path.relative(root, c), mocks);
      }
    }
    return require(spec);
  };
  const fn = new Function('require', 'module', 'exports', transpiled);
  fn(localRequire, mod, mod.exports);
  return mod.exports;
}


const store = loadTsModule('lib/sms-opt-in-store.ts', {
  '@/lib/supabase/admin': { getSupabaseAdmin: () => null },
  '@/lib/notifications': { formatPhoneE164: (p) => p },
});
const notifications = fs.readFileSync(path.join(root, 'lib/notifications.ts'), 'utf8');
const notifyRoute = fs.readFileSync(path.join(root, 'app/api/appointment-notify/route.ts'), 'utf8');
const storeSrc = fs.readFileSync(path.join(root, 'lib/sms-opt-in-store.ts'), 'utf8');
const inbound = fs.readFileSync(path.join(root, 'app/api/sms/inbound/route.ts'), 'utf8');

test('START (pending YES) is not treated as an opt-out', () => {
  assert.deepEqual(store.consentFromRow({ opted_in: false, method: 'sms_keyword_pending' }), {
    optedIn: false, pendingConfirm: true, optedOut: false,
  });
  assert.deepEqual(store.consentFromRow({ opted_in: false, method: 'web_form_pending' }).optedOut, false);
});

test('STOP still blocks, YES is opted in, no row means no record', () => {
  assert.equal(store.consentFromRow({ opted_in: false, method: 'sms_keyword_stop' }).optedOut, true);
  assert.equal(store.consentFromRow({ opted_in: true, method: 'sms_keyword_yes' }).optedOut, false);
  assert.equal(store.consentFromRow(null), null);
});

test('send paths block only on optedOut; pending write clears opted_out_at', () => {
  assert.match(notifications, /if \(consent\?\.optedOut\) \{\s*return \{ ok: false, error: 'Recipient opted out of SMS \(STOP\)\.'/);
  assert.doesNotMatch(notifications, /consent\.optedIn === false/);
  assert.match(notifyRoute, /if \(consent\?\.optedOut\)/);
  assert.match(storeSrc, /record\.pendingConfirm\) \{[\s\S]*?row\.opted_out_at = null;/);
  assert.match(inbound, /\[sms inbound\]/);
  assert.doesNotMatch(inbound, /console\.log\([^)]*\bfrom\b\s*\}/);
});
