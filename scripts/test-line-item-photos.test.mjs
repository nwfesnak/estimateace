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

// ---- v2: line photos also appear in the Site Photos section (derived, not copied) ----
const SITE = [`${UID}/photo/site-1.jpg`];
const lines = () => [
  { id: 11, description: 'Rebuild rear deck with composite boards', photos: [p(1), p(2)] },
  { id: 12, description: 'Paint living room', photos: [p(3)] },
  { id: 13, description: 'No photos here' },
];

test('Site Photos section is derived from the lines: captions, order, no copies into photoUrls', () => {
  const site = [...SITE];
  const items = lines();
  const groups = L.siteSectionLinePhotoGroups(items, site);
  assert.deepEqual(groups.map((g) => [g.itemId, g.caption, g.refs]), [
    [11, 'Line 1: Rebuild rear deck with composite boards', [p(1), p(2)]],
    [12, 'Line 2: Paint living room', [p(3)]],
  ]);
  assert.deepEqual(site, SITE, 'site photo list untouched');
  assert.equal(L.siteSectionPhotoCount(site, items), 4);
  // Same storage object: the refs are the line's own paths
  assert.equal(groups[0].refs[0], items[0].photos[0]);
  // A ref that is already a Site Photo is not shown twice
  const dup = L.siteSectionLinePhotoGroups([{ id: 1, photos: [SITE[0], p(9)] }], SITE);
  assert.deepEqual(dup[0].refs, [p(9)]);
  assert.match(L.linePhotoCaption({ description: 'x'.repeat(200) }, 0), /^Line 1: x+…$/);
  assert.equal(L.linePhotoCaption({}, 4), 'Line 5');
});

test('removing a photo from its line removes it from the Site Photos section too', () => {
  let items = lines();
  items = items.map((it) => (it.id === 11 ? L.withLinePhotoRemoved(it, 0) : it));
  const groups = L.siteSectionLinePhotoGroups(items, SITE);
  assert.deepEqual(groups[0].refs, [p(2)]);
  items = items.map((it) => (it.id === 12 ? L.withLinePhotoRemoved(it, 0) : it));
  assert.deepEqual(L.siteSectionLinePhotoGroups(items, SITE).map((g) => g.itemId), [11]);
  assert.equal(L.siteSectionPhotoCount(SITE, items), 2);
  // deleting the whole line also drops its photos from the section
  assert.equal(L.siteSectionLinePhotoGroups(items.filter((it) => it.id !== 11), SITE).length, 0);
});

test('switch off: no line photos in the Site Photos section, still under their lines', async () => {
  const items = lines();
  assert.deepEqual(L.siteSectionLinePhotoGroups(items, SITE, false), []);
  assert.equal(L.siteSectionPhotoCount(SITE, items, false), 1);
  const signed = await L.signClientLinePhotos(L.planClientLinePhotos(items, UID), async (paths) => paths.map((x) => ({ path: x, signedUrl: `https://s/${x.slice(-6)}` })), 900);
  assert.equal(Object.keys(signed).length, 2, 'under-line photos are independent of the switch');
  assert.deepEqual(L.clientSiteLinePhotoGroups(items, signed, false), []);
  const on = L.clientSiteLinePhotoGroups(items, signed, true);
  assert.deepEqual(on.map((g) => [g.caption, g.photos.length]), [['Line 1: Rebuild rear deck with composite boards', 2], ['Line 2: Paint living room', 1]]);
  assert.equal(on[0].photos[0].url, signed['11'][0].url, 'same signed URL / same object');
  const CM = await jiti.import(path.join(root, 'lib/client-media.ts'));
  assert.equal(CM.clientSitePhotosEnabled({ profile: {} }), true);
  assert.equal(CM.clientSitePhotosEnabled({ profile: { _clientMedia: { photos: false } } }), false);
});

test('v2 wiring: editor/print/preview galleries, Send switch counts, customer section, quick lines text only', () => {
  const page = src('app/page.tsx');
  assert.match(page, /siteSectionLinePhotoGroups\(items, photoUrls, options\?\.includeLinePhotos !== false\)/);
  assert.match(page, /sendIncludeSitePhotos && siteSectionPhotoCount\(photoUrls, items\) > 0/);
  assert.match(page, /sendIncludeSitePhotos && siteSectionPhotoCount\(photoUrls, items\) > 0 && \(\s*<div className="mt-12">\s*\{\/\* Print always expands/);
  assert.match(page, /setSendIncludeSitePhotos\(sitePhotoSectionTotal > 0/);
  assert.doesNotMatch(page, /setPhotoUrls\([^)]*line-photo/);
  const quick = page.slice(page.indexOf('const saveAsQuickLine = '), page.indexOf('const applyQuickLine = '));
  assert.doesNotMatch(quick, /photos/);
  const route = src('app/api/client/document/route.ts');
  assert.match(route, /clientSiteLinePhotoGroups\(ownedItems, linePhotos, clientSitePhotosEnabled\(row\), 40\)/);
  const c = src('components/ClientJobMedia.tsx');
  assert.match(c, /siteLinePhotos/);
  assert.match(c, /Site photos \(\{photos\.length \+ linePhotoTotal\}\)/);
});

// ---- v3: estimate email + print view follow the Site Photos switch ----
const E = await jiti.import(path.join(root, 'lib/email-line-photos.ts'));
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

test('email: line photo URLs are https-only, capped at 5 per line, keyed by line id', () => {
  const out = E.sanitizeEmailLinePhotoUrls({
    11: ['https://s/1', 'http://insecure/2', 'javascript:alert(1)', 'https://s/1', 'https://s/3', 'https://s/4', 'https://s/5', 'https://s/6', 'https://s/7'],
    12: ['nope'],
  });
  assert.deepEqual(out, { 11: ['https://s/1', 'https://s/3', 'https://s/4', 'https://s/5', 'https://s/6'] });
  assert.deepEqual(E.sanitizeEmailLinePhotoUrls(null), {});
  assert.deepEqual(E.sanitizeEmailLinePhotoUrls(['https://x']), {});
});

test('email: line photos always under their line; join the Site photos block only when the switch is on', () => {
  const groups = [{ caption: 'Line 1: Deck <b>', urls: ['https://s/1', 'http://bad'] }];
  assert.deepEqual(E.sanitizeEmailSiteLinePhotos(groups, false), [], 'switch off -> not in Site photos block');
  const on = E.sanitizeEmailSiteLinePhotos(groups, true);
  assert.deepEqual(on, [{ caption: 'Line 1: Deck <b>', urls: ['https://s/1'] }]);
  const block = E.emailSitePhotosBlockHtml(['https://s/site'], on, esc);
  assert.match(block, /Site photos/);
  assert.match(block, /alt="Site photo"/);
  assert.match(block, /Line 1: Deck &lt;b&gt;/);
  assert.ok(block.indexOf('https://s/site') < block.indexOf('https://s/1'), 'site photos first');
  assert.equal(E.emailSitePhotosBlockHtml([], [], esc), '');
  assert.match(E.emailSitePhotosBlockHtml([], on, esc), /Site photos/, 'line-only job still gets the block when on');
  const thumbs = E.emailLinePhotoThumbsHtml(['https://s/1?a=1&b="x"'], esc);
  assert.match(thumbs, /width="64"/);
  assert.match(thumbs, /&amp;b=&quot;x&quot;/);
  assert.equal(E.emailLinePhotoThumbsHtml([], esc), '');
});

test('v3 wiring: send route + editor payload + print view follows the switch', () => {
  const route = src('app/api/documents/send/route.ts');
  assert.match(route, /sanitizeEmailLinePhotoUrls\(body\.linePhotoUrls\)/);
  assert.match(route, /sanitizeEmailSiteLinePhotos\(body\.siteLinePhotos, body\.includeSitePhotos !== false\)/);
  assert.match(route, /emailLinePhotoThumbsHtml\(linePhotoUrls\[String\(it\.id\)\], escapeHtml\)/);
  assert.match(route, /mediaHtml \+= emailSitePhotosBlockHtml\(sitePhotoUrls, siteLinePhotos, escapeHtml\)/);
  const page = src('app/page.tsx');
  assert.match(page, /const includePhotos = sendIncludeSitePhotos && sitePhotoSectionTotal > 0;/);
  assert.match(page, /const emailSiteLinePhotos = includePhotos\s*\?/);
  assert.match(page, /linePhotoUrls: emailLinePhotoUrls,\s*siteLinePhotos: emailSiteLinePhotos,/);
  // print view: whole Site Photos section (site + line photos) gated by the switch
  const printDoc = page.slice(page.indexOf('id="print-document"'), page.indexOf('id="preview-document"'));
  assert.match(printDoc, /sendIncludeSitePhotos && siteSectionPhotoCount\(photoUrls, items\) > 0/);
  assert.doesNotMatch(printDoc, /\{photoUrls\.length > 0 && \(/);
});
