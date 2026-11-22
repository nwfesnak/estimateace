// Run: npm run test:platform-tutorials — platform video tutorial links + admin allowlist.
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

const T = loadTsModule('lib/platform-tutorials.ts');
const src = (p) => readFileSync(path.join(root, p), 'utf8');

test('built-in platform admins include admin@estimateace.com and nwfesnak@gmail.com', () => {
  const emails = T.getPlatformAdminEmails('');
  assert.ok(emails.includes('admin@estimateace.com'));
  assert.ok(emails.includes('nwfesnak@gmail.com'));
  assert.equal(T.isPlatformAdminEmail('admin@estimateace.com', ''), true);
  assert.equal(T.isPlatformAdminEmail('NWFESNAK@gmail.com', ''), true);
  assert.equal(T.isPlatformAdminEmail('crew@example.com', ''), false);
  assert.equal(T.isPlatformAdminEmail('', ''), false);
  assert.equal(T.isPlatformAdminEmail(null, ''), false);
});

test('PLATFORM_ADMIN_EMAILS env adds extra admins without dropping defaults', () => {
  const emails = T.getPlatformAdminEmails('ops@estimateace.com, Other@Ace.test');
  assert.ok(emails.includes('admin@estimateace.com'));
  assert.ok(emails.includes('nwfesnak@gmail.com'));
  assert.ok(emails.includes('ops@estimateace.com'));
  assert.ok(emails.includes('other@ace.test'));
  assert.equal(T.isPlatformAdminEmail('ops@estimateace.com', 'ops@estimateace.com'), true);
});

test('tutorial URLs must be http(s) and reject javascript or blank values', () => {
  assert.equal(T.isAllowedTutorialUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(T.isAllowedTutorialUrl('http://vimeo.com/123456'), true);
  assert.equal(T.isAllowedTutorialUrl('javascript:alert(1)'), false);
  assert.equal(T.isAllowedTutorialUrl('data:text/html,x'), false);
  assert.equal(T.isAllowedTutorialUrl('ftp://files.example/video.mp4'), false);
  assert.equal(T.isAllowedTutorialUrl(''), false);
  assert.equal(T.isAllowedTutorialUrl('youtube.com/watch?v=dQw4w9WgXcQ'), false);
});

test('YouTube and Vimeo ids produce public thumbnails', () => {
  assert.equal(
    T.tutorialThumbnailUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
  );
  assert.equal(
    T.tutorialThumbnailUrl('https://youtu.be/dQw4w9WgXcQ'),
    'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
  );
  assert.equal(
    T.tutorialThumbnailUrl('https://www.youtube.com/embed/dQw4w9WgXcQ'),
    'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
  );
  assert.equal(
    T.tutorialThumbnailUrl('https://vimeo.com/123456789'),
    'https://vumbnail.com/123456789.jpg'
  );
  assert.equal(T.tutorialThumbnailUrl('https://loom.com/share/abc'), '');
});

test('normalizeLinkTutorial maps a DB row and drops invalid urls', () => {
  const row = T.normalizeLinkTutorial({
    id: '11111111-1111-4111-8111-111111111111',
    title: '  Send an estimate  ',
    description: 'Walkthrough',
    url: 'https://youtu.be/dQw4w9WgXcQ',
    sort_order: 2,
    created_at: '2026-11-22T00:00:00.000Z',
    created_by_email: 'nwfesnak@gmail.com',
  });
  assert.equal(row.title, 'Send an estimate');
  assert.equal(row.kind, 'link');
  assert.equal(row.sortOrder, 2);
  assert.equal(row.thumbnailUrl, 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.equal(T.normalizeLinkTutorial({ id: 'x', title: 'Bad', url: 'javascript:hi' }), null);
});

test('migration creates global app_tutorials with read-only RLS for authenticated users', () => {
  const sql = src('supabase/app-tutorials-2026-11.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.app_tutorials/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /Authenticated users can read app_tutorials/);
  assert.match(sql, /FOR SELECT\s+TO authenticated\s+USING \(true\)/s);
  assert.match(sql, /REVOKE ALL ON TABLE public\.app_tutorials FROM anon/);
  assert.match(sql, /GRANT SELECT ON TABLE public\.app_tutorials TO authenticated/);
  assert.match(sql, /GRANT ALL ON TABLE public\.app_tutorials TO service_role/);
  assert.match(sql, /Do not apply to production until this PR is merged/);
  assert.doesNotMatch(sql, /FOR INSERT/);
  assert.doesNotMatch(sql, /FOR UPDATE/);
  assert.doesNotMatch(sql, /FOR DELETE/);
});

test('API writes are admin-only and support JSON links, edit, reorder, and delete', () => {
  const route = src('app/api/tutorials/route.ts');
  assert.match(route, /isPlatformAdminEmail/);
  assert.match(route, /requireAdmin/);
  assert.match(route, /from\('app_tutorials'\)/);
  assert.match(route, /export async function PATCH/);
  assert.match(route, /orderedIds/);
  assert.match(route, /isAllowedTutorialUrl/);
  assert.match(route, /status: 403/);
  // writes use the service-role client, not the caller's JWT
  assert.match(route, /getSupabaseAdmin/);
});

test('Video Tutorials UI is on Company Profile, visible to crew, and opens links externally', () => {
  const page = src('app/page.tsx');
  const panel = src('components/VideoTutorialsPanel.tsx');
  assert.match(page, /from '@\/components\/VideoTutorialsPanel'/);
  assert.match(page, /<VideoTutorialsPanel onMessage=\{showMessage\} \/>/);
  assert.match(page, /profileTab === 'tutorials'/);
  assert.match(page, /data-testid="crew-video-tutorials-tab"/);
  assert.match(page, /tab === 'tutorials' \? 'tutorials' : 'billing'/);
  assert.match(panel, /Tutorials coming soon/);
  assert.match(panel, /data-testid="tutorials-empty-state"/);
  assert.match(panel, /data-testid="video-tutorials-admin"/);
  assert.match(panel, /openExternalUrl/);
  assert.match(panel, /Add tutorial/);
  assert.match(panel, /Move up/);
  assert.match(panel, /min-h-11/);
  assert.match(panel, /min-\[400px\]:flex-row/);
});

test('tutorial API calls send the Supabase session Bearer token', async () => {
  const panel = src('components/VideoTutorialsPanel.tsx');
  assert.match(panel, /from '@\/lib\/session-auth'/);
  assert.match(panel, /fetchWithSession/);
  // Bare cookie-only fetch is what caused production 401s.
  assert.equal((panel.match(/fetchWithSession\(\s*['"]\/api\/tutorials['"]/g) || []).length, 6);
  assert.doesNotMatch(panel, /(?<!fetchWithSession\()fetch\(\s*['"]\/api\/tutorials['"]/);

  const session = {
    access_token: 'tok_session_abc',
  };
  const mocks = {
    '@/lib/supabase/client': {
      getSupabaseClient: () => ({
        auth: {
          getSession: async () => ({ data: { session } }),
        },
      }),
    },
  };
  const auth = loadTsModule('lib/session-auth.ts', mocks);
  const headers = auth.authorizationHeaders('tok_abc', { 'Content-Type': 'application/json' });
  assert.equal(headers.get('Authorization'), 'Bearer tok_abc');
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.equal(auth.authorizationHeaders(null).get('Authorization'), null);
  assert.equal(auth.authorizationHeaders('').get('Authorization'), null);

  assert.equal(await auth.getSessionAccessToken(), 'tok_session_abc');

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    await auth.fetchWithSession('/api/tutorials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Demo', url: 'https://example.com/v' }),
    });
    await auth.fetchWithSession('/api/tutorials');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/api/tutorials');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer tok_session_abc');
  assert.equal(calls[0].init.headers.get('Content-Type'), 'application/json');
  assert.equal(calls[1].init.credentials, 'include');
  assert.equal(calls[1].init.headers.get('Authorization'), 'Bearer tok_session_abc');
});

test('account purge documents app_tutorials as kept platform data', () => {
  const purge = src('lib/account-purge.ts');
  const delTest = src('scripts/test-account-deletion.test.mjs');
  assert.match(purge, /app_tutorials:/);
  assert.match(delTest, /'app_tutorials'/);
  assert.doesNotMatch(purge, /table: 'app_tutorials'/);
});
