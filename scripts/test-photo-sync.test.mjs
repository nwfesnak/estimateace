// Run: npm run test:photo-sync — photos saved on one device must survive a stale tab on another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const S = await jiti.import(path.join(root, 'lib/document-sync.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

const UID = '11111111-1111-1111-1111-111111111111';
const site = (n) => `${UID}/photo-${n}.jpg`;
const linep = (n) => `${UID}/line-photo/${n}.jpg`;

let clock = Date.parse('2026-11-27T16:00:00.000Z');
const tick = () => new Date((clock += 60_000)).toISOString();

/** Tiny in-memory `estimates` table + an editor tab that mirrors app/page.tsx saveToDB. */
function makeDb() {
  const rows = new Map();
  return {
    get: (id) => (rows.has(id) ? structuredClone(rows.get(id)) : null),
    upsert: (row) => rows.set(row.id, structuredClone(row)),
  };
}
function makeTab(db, { sync }) {
  const tab = { base: null, state: null };
  tab.open = (id) => {
    const row = db.get(id);
    tab.base = row;
    tab.state = structuredClone(row);
  };
  /** Autosave: old code (sync=false) blindly upserts the tab's in-memory state. */
  tab.save = () => {
    const payload = { ...structuredClone(tab.state), updated_at: tick() };
    if (sync) {
      const d = S.decideDocumentSync(tab.base, payload, db.get(payload.id));
      if (d.action === 'skip') return 'skip';
      if (d.action === 'adopt-remote') {
        tab.open(payload.id);
        return 'adopt-remote';
      }
      if (d.action === 'write-merged') {
        const merged = S.applyMergedMedia(payload, d.media);
        db.upsert(merged);
        tab.base = merged;
        tab.state = structuredClone(merged);
        return 'write-merged';
      }
    }
    db.upsert(payload);
    tab.base = payload;
    return 'write';
  };
  return tab;
}
const baseRow = () => ({
  id: 'EST-111111-0007',
  user_id: UID,
  jobName: 'Deck repair',
  items: [
    { id: 1, description: 'Boards', qty: 10, price: 12, photos: [] },
    { id: 2, description: 'Stain', qty: 1, price: 80 },
  ],
  photoUrls: [],
  videoUrls: [],
  receiptUrls: [],
  receiptDetails: [],
  profile: { company: 'Dogs and Cats', _jobRenderings: [] },
  amountPaid: 0,
  updated_at: tick(),
});

test('REPRO (old behavior): idle PC tab autosave wipes photos the phone just saved', () => {
  const db = makeDb();
  db.upsert(baseRow());
  const pc = makeTab(db, { sync: false });
  const phone = makeTab(db, { sync: false });
  pc.open('EST-111111-0007');
  phone.open('EST-111111-0007');
  phone.state.photoUrls = [site(1), site(2)];
  phone.state.items[0].photos = [linep('a')];
  phone.save();
  assert.equal(db.get('EST-111111-0007').photoUrls.length, 2);
  pc.save(); // any re-render / unrelated edit on the PC fires autosave with stale state
  const after = db.get('EST-111111-0007');
  assert.deepEqual(after.photoUrls, [], 'old code: site photos gone');
  assert.deepEqual(after.items[0].photos, [], 'old code: line photos gone');
});

test('FIX: idle PC tab does not write; it adopts the phone version (site + line photos)', () => {
  const db = makeDb();
  db.upsert(baseRow());
  const pc = makeTab(db, { sync: true });
  const phone = makeTab(db, { sync: true });
  pc.open('EST-111111-0007');
  phone.open('EST-111111-0007');
  phone.state.photoUrls = [site(1), site(2)];
  phone.state.items[0].photos = [linep('a'), linep('b')];
  assert.equal(phone.save(), 'write');
  assert.equal(pc.save(), 'adopt-remote', 'stale tab must not overwrite');
  const after = db.get('EST-111111-0007');
  assert.deepEqual(after.photoUrls, [site(1), site(2)]);
  assert.deepEqual(after.items[0].photos, [linep('a'), linep('b')]);
  assert.deepEqual(pc.state.photoUrls, [site(1), site(2)], 'PC now shows the phone photos');
  assert.deepEqual(pc.state.items[0].photos, [linep('a'), linep('b')]);
});

test('FIX: PC edited text while phone added photos -> both kept (three-way media merge)', () => {
  const db = makeDb();
  db.upsert(baseRow());
  const pc = makeTab(db, { sync: true });
  const phone = makeTab(db, { sync: true });
  pc.open('EST-111111-0007');
  phone.open('EST-111111-0007');
  phone.state.photoUrls = [site(1)];
  phone.state.items[0].photos = [linep('a')];
  phone.save();
  pc.state.jobName = 'Deck repair + rail';
  pc.state.items[1].price = 95; // PC edited a line too
  pc.state.photoUrls = [site(9)]; // and took its own site photo
  assert.equal(pc.save(), 'write-merged');
  const after = db.get('EST-111111-0007');
  assert.equal(after.jobName, 'Deck repair + rail');
  assert.equal(after.items[1].price, 95);
  assert.deepEqual(after.photoUrls.sort(), [site(1), site(9)].sort());
  assert.deepEqual(after.items[0].photos, [linep('a')]);
});

test('FIX: a photo deleted on one device stays deleted after the other device saves', () => {
  const db = makeDb();
  const row = baseRow();
  row.photoUrls = [site(1), site(2)];
  row.items[0].photos = [linep('a'), linep('b')];
  db.upsert(row);
  const pc = makeTab(db, { sync: true });
  const phone = makeTab(db, { sync: true });
  pc.open(row.id);
  phone.open(row.id);
  phone.state.photoUrls = [site(2)];
  phone.state.items[0].photos = [linep('b')];
  phone.save();
  pc.state.jobName = 'edited on PC';
  pc.save();
  const after = db.get(row.id);
  assert.deepEqual(after.photoUrls, [site(2)]);
  assert.deepEqual(after.items[0].photos, [linep('b')]);
  assert.equal(after.jobName, 'edited on PC');
});

test('FIX: nothing changed anywhere -> no write at all', () => {
  const db = makeDb();
  db.upsert(baseRow());
  const pc = makeTab(db, { sync: true });
  pc.open('EST-111111-0007');
  assert.equal(pc.save(), 'skip', 'opened and untouched -> no write');
  pc.state.jobName = 'typed';
  assert.equal(pc.save(), 'write');
  assert.equal(pc.save(), 'skip', 'already saved -> no second write');
});

test('merge helpers: refs, keyed lists, line photo cap, lines added on the other device', () => {
  assert.deepEqual(S.mergeRefList(['a', 'b'], ['a', 'b', 'c'], ['b', 'd']), ['b', 'c', 'd']);
  assert.deepEqual(S.mergeRefList([], [], ['x']), ['x']);
  assert.deepEqual(S.mergeRefList(null, ['a'], undefined), ['a']);
  const r = S.mergeKeyedList([{ id: 1 }], [{ id: 1 }, { id: 2 }], [{ id: 3 }], (x) => String(x.id));
  assert.deepEqual(r.map((x) => x.id), [2, 3]);
  const items = S.mergeLineItems(
    [{ id: 1, photos: [] }],
    [{ id: 1, description: 'local edit', photos: [linep(1), linep(2), linep(3)] }],
    [{ id: 1, photos: [linep(4), linep(5), linep(6)] }, { id: 7, description: 'added on phone', photos: [linep(7)] }]
  );
  assert.equal(items[0].description, 'local edit');
  assert.equal(items[0].photos.length, 5, 'capped at 5');
  assert.equal(items[1].id, 7, 'line added on the other device is kept');
  // Lines untouched on this tab -> take the other device's lines wholesale (text edits too)
  const same = S.mergeLineItems([{ id: 1, price: 1 }], [{ id: 1, price: 1 }], [{ id: 1, price: 2, photos: [linep(1)] }]);
  assert.deepEqual(same, [{ id: 1, price: 2, photos: [linep(1)] }]);
  // AI renderings live in profile._jobRenderings
  const m = S.mergeDocumentMedia(
    { profile: { _jobRenderings: [] } },
    { profile: { _jobRenderings: [{ id: 'r1' }] } },
    { profile: { _jobRenderings: [{ id: 'r2' }] } }
  );
  assert.deepEqual(m.jobRenderings.map((x) => x.id), ['r1', 'r2']);
});

test('content compare ignores jsonb key order, numeric strings, lowercase columns', () => {
  const a = { jobName: 'x', profile: { a: 1, b: 2 }, amountPaid: 0, photoUrls: ['p'] };
  const b = { jobName: 'x', profile: { b: 2, a: 1 }, amountPaid: '0', photourls: ['p'] };
  assert.ok(S.sameDocContent(a, b));
  assert.ok(!S.sameDocContent(a, { ...b, photourls: ['p', 'q'] }));
  const t = '2026-11-27T16:13:00.000Z';
  assert.equal(S.remoteChangedSince({ ...a, updated_at: t }, { ...a, photoUrls: ['zz'], updated_at: '2026-11-27T16:13:00+00:00' }), false, 'same timestamp = same version');
  assert.equal(S.decideDocumentSync(null, a, b).action, 'write', 'no base (new doc) behaves as before');
  assert.equal(S.decideDocumentSync(a, a, null).action, 'write', 'row missing behaves as before');
});

test('document numbers: phone + PC can no longer mint the same EST number', () => {
  const ids = ['EST-111111-0003', 'INV-111111-0009', { id: 'EST-111111-0004' }, 'EST-0012', 'junk'];
  assert.equal(S.maxDocumentSequence(ids), 12);
  assert.equal(S.nextDocumentSequence(2, ids), 13, 'device counter behind -> jump past used numbers');
  assert.equal(S.nextDocumentSequence(40, ids), 41);
  assert.equal(S.nextDocumentSequence(NaN, []), 1);
});

test('page.tsx wiring: saves sync first, focus pulls, list opens fresh row, new numbers checked', () => {
  const page = src('app/page.tsx');
  assert.match(page, /from '@\/lib\/document-sync'/);
  assert.match(page, /const syncDocumentBeforeSave = async/);
  assert.match(page, /await syncDocumentBeforeSave\(docId, payload/);
  assert.match(page, /docSyncBaseRef\.current = \{ id: docId, row: payload/);
  assert.match(page, /docSyncBaseRef\.current = est \?/, 'loading a document sets the base');
  assert.match(page, /syncOnly: true/);
  assert.match(page, /addEventListener\('visibilitychange', pull\)/);
  assert.match(page, /await fetchOwnDocumentRow\(String\(est\.id\)\)/);
  assert.match(page, /nextDocumentSequence\(\s*parseInt\(localStorage\.getItem\('estimateCount'\)/);
  assert.match(page, /Another device already saved a document under this number/);
  assert.match(page, /if \(!currentCrew\) \{\s*const sync = await syncDocumentBeforeSave/, 'crew saves unchanged');
  // adopting must not await inside the save chain (would deadlock)
  assert.match(page, /setTimeout\(\(\) => \{\s*void loadSelectedEstimateRef\.current\(row\);/);
});
