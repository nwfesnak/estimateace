// Run: npm run test:line-photos — up to 5 photos per estimate line (editor, customer page, PDF).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const L = await jiti.import(path.join(root, 'lib/line-item-photos.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

const UID = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const p = (n) => `${UID}/line-photo/${n}.jpg`;

test('cap is 5 per line; add/remove/move keep order and never exceed the cap', () => {
  assert.equal(L.LINE_PHOTO_LIMIT, 5);
  let item = { id: 1, description: 'Paint', photos: [] };
  item = L.withLinePhotosAdded(item, [p(1), p(2), p(2), '', p(3)]);
  assert.deepEqual(item.photos, [p(1), p(2), p(3)]);
  assert.equal(L.remainingLinePhotoSlots(item), 2);
  item = L.withLinePhotosAdded(item, [p(4), p(5), p(6), p(7)]);
  assert.deepEqual(item.photos, [p(1), p(2), p(3), p(4), p(5)]);
  assert.equal(L.remainingLinePhotoSlots(item), 0);
  item = L.withLinePhotoMoved(item, 0, 1);
  assert.deepEqual(item.photos.slice(0, 2), [p(2), p(1)]);
  assert.deepEqual(L.withLinePhotoMoved(item, 0, -1).photos, item.photos, 'out of range is a no-op');
  item = L.withLinePhotoRemoved(item, 1);
  assert.deepEqual(item.photos, [p(2), p(3), p(4), p(5)]);
  assert.equal(item.description, 'Paint', 'other line fields untouched');
  // Legacy / malformed lines
  assert.deepEqual(L.getLinePhotos({}), []);
  assert.deepEqual(L.getLinePhotos({ photos: 'x' }), []);
  assert.deepEqual(L.getLinePhotos({ photos: [1, null, p(1), p(1)] }), [p(1)]);
  assert.equal(L.getLinePhotos({ photos: Array.from({ length: 9 }, (_, i) => p(i)) }).length, 5);
});

test('photos ride along with the line JSON (save / reload / duplicate copy the items array as-is)', () => {
  const items = [{ id: 7, description: 'Deck', photos: [p(1), p(2)] }, { id: 8, description: 'Rail' }];
  const copied = JSON.parse(JSON.stringify(items));
  assert.deepEqual(L.getLinePhotos(copied[0]), [p(1), p(2)]);
  assert.deepEqual(L.allLinePhotoRefs(copied), [p(1), p(2)]);
  const save = src('lib/estimate-save.ts');
  assert.match(save, /items: input\.items \?\? \[\]/);
});

test('new uploads land in the owner media folder under line-photo/', () => {
  const path1 = L.newLinePhotoPath(UID, 'JPG', 'abc', 1000);
  assert.equal(path1, `${UID}/line-photo/1000-abc.jpg`);
  assert.equal(L.newLinePhotoPath(UID, '../x', 'r', 1), `${UID}/line-photo/1-r.x`);
});

test('customer plan: owner folder images only, keyed by the same id the item list uses', () => {
  const items = [
    { id: 101, photos: [p(1), `${OTHER}/line-photo/x.jpg`, `${UID}/../${OTHER}/a.jpg`, 'https://evil.example.com/e.jpg', `${UID}/receipt/r.jpg`, `${UID}/line-photo/doc.pdf`] },
    { description: 'no id', photos: [p(2)] },
    { id: 103 },
  ];
  const plan = L.planClientLinePhotos(items, UID);
  assert.deepEqual(plan, [
    { lineId: '101', paths: [p(1)] },
    { lineId: 'idx-1', paths: [p(2)] },
  ]);
  assert.deepEqual(L.planClientLinePhotos(items, ''), []);
  assert.deepEqual(L.planClientLinePhotos(null, UID), []);
});

test('customer signing returns URLs only and drops failures', async () => {
  const plan = [{ lineId: '101', paths: [p(1), p(2)] }];
  let seen;
  const out = await L.signClientLinePhotos(
    plan,
    async (paths, ttl) => {
      seen = { paths, ttl };
      return paths.map((x) => (x.endsWith('2.jpg') ? { path: x, signedUrl: null, error: 'no' } : { path: x, signedUrl: 'https://signed/1' }));
    },
    900
  );
  assert.equal(seen.ttl, 900);
  assert.deepEqual(out, { 101: [{ url: 'https://signed/1' }] });
  assert.ok(!JSON.stringify(out).includes(UID));
  assert.deepEqual(await L.signClientLinePhotos(plan, async () => { throw new Error('down'); }, 900), {});
});

test('wiring: editor control, PDF/print thumbs, customer page, route signing; site photos untouched', () => {
  const page = src('app/page.tsx');
  assert.match(page, /<LineItemPhotosEditor/);
  assert.equal((page.match(/<LineItemPhotoThumbs/g) || []).length, 2, 'preview/PDF + print documents');
  assert.match(page, /setDeviceCameraPhotoTarget\('line'\)/);
  // Site photos still go through the original upload + gallery
  assert.match(page, /handleMediaUpload\(dt\.files, asReceipt \? 'receipt' : 'photo'\)/);
  assert.match(page, /renderPhotoGallery\(\{ editable: true \}\)/);
  const route = src('app/api/client/document/route.ts');
  assert.match(route, /planClientLinePhotos\(/);
  assert.match(route, /planClientMedia\(row, uid, settingsProfile\)/);
  const approve = src('app/client/approve/page.tsx');
  assert.equal((approve.match(/<ClientLinePhotoStrip/g) || []).length, 3);
  const comp = src('components/LineItemPhotos.tsx');
  assert.match(comp, /accept="image\/\*"/);
});

test('no new native plugin (ships through the live web app)', () => {
  const pkg = JSON.parse(src('package.json'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.ok(!deps.includes('@capacitor/camera'));
  assert.match(src('capacitor.config.ts'), /url: 'https:\/\/app\.estimateace\.com'/);
});
