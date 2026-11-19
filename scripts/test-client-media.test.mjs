// Run: npm run test:client-media — customer approve page photos + concept renderings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const M = await jiti.import(path.join(root, 'lib/client-media.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

const UID = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const row = (over = {}) => ({
  id: 'EST-1',
  user_id: UID,
  photoUrls: [
    `${UID}/photo/a.jpg`,
    `${OTHER}/photo/stolen.jpg`,
    `https://x.supabase.co/storage/v1/object/sign/media/${UID}/photo/b.jpg?token=abc`,
    `${UID}/../${OTHER}/photo/c.jpg`,
    `${UID}/%2e%2e/${OTHER}/photo/d.jpg`,
    'https://evil.example.com/e.jpg',
    'data:image/png;base64,AAAA',
    `${UID}/video/clip.mp4`,
    `${UID}/receipt/r.jpg`,
    `${UID}/photo/a.jpg`,
  ],
  profile: {
    _jobRenderings: [
      { sourcePath: `${UID}/photo/a.jpg`, resultPath: `${UID}/render/result-1.png`, lineDescription: 'Kitchen  cabinets', status: 'ready' },
      { sourcePath: `${OTHER}/photo/x.jpg`, resultPath: `${UID}/render/result-2.png`, lineDescription: 'Bath' },
      { sourcePath: `${UID}/photo/a.jpg`, resultPath: `${OTHER}/render/result-3.png` },
      { sourcePath: `${UID}/photo/a.jpg`, resultPath: `${UID}/render/result-4.png`, status: 'error' },
      { sourcePath: `${UID}/photo/a.jpg` },
    ],
  },
  ...over,
});

test('only the token owner folder, images only, no receipts/videos/traversal/external', () => {
  const plan = M.planClientMedia(row(), UID, {});
  assert.deepEqual(plan.photos, [`${UID}/photo/a.jpg`, `${UID}/photo/b.jpg`]);
  assert.equal(plan.renderings.length, 2);
  assert.deepEqual(plan.renderings[0], {
    beforePath: `${UID}/photo/a.jpg`,
    afterPath: `${UID}/render/result-1.png`,
    label: 'Kitchen cabinets',
  });
  // Foreign "before" is dropped but our own rendering still shows (after only).
  assert.equal(plan.renderings[1].beforePath, null);
  for (const p of [...plan.photos, ...plan.renderings.flatMap((r) => [r.beforePath, r.afterPath])]) {
    if (p) assert.ok(p.startsWith(`${UID}/`), p);
  }
});

test('a row belonging to another account (or a different uid) yields nothing', () => {
  assert.deepEqual(M.planClientMedia(row({ user_id: OTHER }), UID, {}), { photos: [], renderings: [] });
  assert.deepEqual(M.planClientMedia(row(), OTHER, {}).photos, []);
  assert.deepEqual(M.planClientMedia(row(), '', {}), { photos: [], renderings: [] });
  assert.deepEqual(M.planClientMedia(null, UID, {}), { photos: [], renderings: [] });
});

test('respects Send toggles and the AI rendering switch', () => {
  const noPhotos = M.planClientMedia(row({ profile: { ...row().profile, _clientMedia: { photos: false, renderings: true } } }), UID, {});
  assert.equal(noPhotos.photos.length, 0);
  assert.equal(noPhotos.renderings.length, 2);
  const noRenders = M.planClientMedia(row({ profile: { ...row().profile, _clientMedia: { photos: true, renderings: false } } }), UID, {});
  assert.equal(noRenders.renderings.length, 0);
  assert.equal(M.planClientMedia(row(), UID, { aiJobRenderingEnabled: false }).renderings.length, 0);
});

test('caps photo and rendering counts', () => {
  const many = Array.from({ length: 40 }, (_, i) => `${UID}/photo/p${i}.jpg`);
  const renders = Array.from({ length: 20 }, (_, i) => ({ resultPath: `${UID}/render/r${i}.png` }));
  const plan = M.planClientMedia(row({ photoUrls: many, profile: { _jobRenderings: renders } }), UID, {});
  assert.equal(plan.photos.length, M.CLIENT_MEDIA_LIMITS.maxPhotos);
  assert.equal(plan.renderings.length, M.CLIENT_MEDIA_LIMITS.maxRenderings);
});

test('signs with a short TTL and returns URLs only (never paths); drops failures', async () => {
  const plan = M.planClientMedia(row(), UID, {});
  let seen = null;
  const out = await M.signClientMedia(
    plan,
    async (paths, ttl) => {
      seen = { paths, ttl };
      return paths.map((p) =>
        p.endsWith('b.jpg') ? { path: p, signedUrl: null, error: 'nope' } : { path: p, signedUrl: `https://signed/${p.length}` }
      );
    },
    0
  );
  assert.equal(seen.ttl, M.CLIENT_MEDIA_LIMITS.signedUrlTtlSec);
  assert.ok(seen.ttl <= 3600);
  assert.ok(seen.paths.every((p) => p.startsWith(`${UID}/`)));
  assert.equal(new Set(seen.paths).size, seen.paths.length);
  assert.equal(out.photos.length, 1);
  assert.equal(out.renderings.length, 2);
  assert.equal(out.expiresAt, new Date(seen.ttl * 1000).toISOString());
  assert.ok(!JSON.stringify(out).includes(`${UID}/photo`), 'storage paths leaked');
  const failed = await M.signClientMedia(plan, async () => {
    throw new Error('storage down');
  });
  assert.deepEqual(failed, { photos: [], renderings: [], expiresAt: null });
});

test('document route: media signed from the token row, private bucket, no-store', () => {
  const r = src('app/api/client/document/route.ts');
  assert.match(r, /verifyClientActionToken\(token\)/);
  assert.match(r, /planClientMedia\(row, uid, settingsProfile\)/);
  assert.match(r, /from\('media'\)\.createSignedUrls\(paths, ttl\)/);
  assert.doesNotMatch(r, /getPublicUrl/);
  assert.match(r, /'Cache-Control': 'private, no-store'/);
  // Fallback branch (no row) must not return media.
  const fallback = r.slice(r.indexOf('if (!row) {\n      // Still allow'), r.indexOf('let profile ='));
  assert.doesNotMatch(fallback, /media:/);
});

test('approve page renders the gallery with the concept-rendering disclaimer', () => {
  const page = src('app/client/approve/page.tsx');
  assert.match(page, /<ClientJobMedia media=\{doc\?\.media\} onExpired=\{refreshMedia\} \/>/);
  const c = src('components/ClientJobMedia.tsx');
  assert.match(c, /Concept rendering: an AI illustration/);
  assert.match(c, /After \(concept rendering\)/);
  assert.match(c, /referrerPolicy="no-referrer"/);
  assert.match(c, /grid-cols-3/);
});

test('editor persists Send toggles for the customer page', () => {
  const p = src('app/page.tsx');
  assert.match(p, /_clientMedia: clientMediaShareRef\.current/);
  assert.match(p, /clientMediaShareRef\.current = \{\s*photos: sendIncludeSitePhotos,/);
});
