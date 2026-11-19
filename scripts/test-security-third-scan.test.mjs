// Run: npm run test:crew  (also runs scripts/test-crew-redaction.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const Q = await jiti.import(path.join(root, 'lib/crew-query.ts'));
const P = await jiti.import(path.join(root, 'lib/storage-paths.ts'));
const U = await jiti.import(path.join(root, 'lib/upload-names.ts'));

const qs = (s) => new URLSearchParams(s);
const ok = (s, mode = 'read') => {
  const r = Q.sanitizeCrewQuery(qs(s), mode);
  assert.equal(r.ok, true, `expected ok: ${s} (${r.error || ''})`);
  return r.params;
};
const bad = (s, mode = 'read') => {
  const r = Q.sanitizeCrewQuery(qs(s), mode);
  assert.equal(r.ok, false, `expected rejection: ${s}`);
};

test('crew query: normal app queries still work and always select whole rows', () => {
  assert.equal(ok('select=*&user_id=eq.abc&order=updated_at.desc').get('select'), '*');
  assert.equal(ok('select=profile&id=eq.SETTINGS-abc').get('select'), '*');
  assert.equal(ok('select=profile,%20id,%20jobName,%20documentType&user_id=eq.x').get('select'), '*');
  ok('select=*&or=(documentType.eq.recurring_plan,documenttype.eq.recurring_plan)');
  ok('select=*&id=like.REC-%25&limit=1');
  ok('select=*&id=not.like.SETTINGS-%25');
  ok('select=*&id=in.(%22EST-1%22,%22EST-2%22)');
  ok('select=*&invoiceNumber=eq.INV-0003');
  ok('select=*&order=archived_at.desc.nullslast&offset=20&limit=20');
  ok('select=*&updated_at=gt.2026-01-01T00:00:00Z');
  const p = ok('on_conflict=id&columns=%22id%22,%22user_id%22,%22items%22', 'write');
  assert.equal(p.get('on_conflict'), 'id');
  assert.equal(ok('').get('select'), '*');
});

test('crew query: aliases, JSON paths, casts and embeds are refused', () => {
  bad('select=x:items');
  bad('select=p:items->0->>price');
  bad('select=x:profile');
  bad('select=items->0');
  bad('select=amountPaid::text');
  bad('select=*,owner:users(*)');
  bad('select=*,estimates(*)');
  bad('select=id,receipts!inner(*)');
});

test('crew query: filters and sorting on hidden values are refused', () => {
  bad('items->0->>price=gt.100');
  bad('amountPaid=gt.0');
  bad('taxAmount=eq.5');
  bad('profile->>company=eq.x');
  bad('laborRate=gte.50');
  bad('order=amountPaid.desc');
  bad('order=items->0->>price.desc');
  bad('or=(amountPaid.gt.0,id.eq.x)');
  bad('or=(id.eq.x,and(amountPaid.gt.0))');
  bad('or=(id.eq.x)&and=(user_id.eq.other)');
  bad('and=(user_id.eq.other)');
  bad('id=fts.secret');
  bad('id=cs.{1}');
  bad('limit=abc');
  bad('on_conflict=user_id', 'write');
  bad('on_conflict=id', 'read');
  bad('columns=id', 'read');
  bad('columns=id,items-%3E0', 'write');
});

test('storage paths: owner folder only, no traversal or foreign schemes', () => {
  const O = '11111111-1111-1111-1111-111111111111';
  const X = '66666666-6666-6666-6666-666666666666';
  assert.equal(P.ownedMediaPath(`${O}/certificate/a.pdf`, [O]), `${O}/certificate/a.pdf`);
  assert.equal(P.ownedMediaPath(`/${O}/photo/a.jpg`, [O]), `${O}/photo/a.jpg`);
  assert.equal(
    P.ownedMediaPath(`https://p.supabase.co/storage/v1/object/sign/media/${O}/photo/a.jpg?token=t`, [O]),
    `${O}/photo/a.jpg`
  );
  assert.equal(P.ownedMediaPath(`${X}/photo/a.jpg`, [O]), null);
  assert.equal(P.ownedMediaPath(`${O}/../${X}/photo/a.jpg`, [O]), null);
  assert.equal(P.ownedMediaPath(`${O}/%2e%2e/${X}/a.jpg`, [O]), null);
  assert.equal(P.ownedMediaPath(`${O}%2f..%2f${X}/a.jpg`, [O]), null);
  assert.equal(P.ownedMediaPath(`${O}//a.jpg`, [O]), null);
  assert.equal(P.ownedMediaPath(`${O}\\..\\${X}`, [O]), null);
  assert.equal(P.ownedMediaPath('https://evil.example/x.jpg', [O]), null);
  assert.equal(P.ownedMediaPath('http://169.254.169.254/latest/meta-data', [O]), null);
  assert.equal(P.ownedMediaPath('javascript:alert(1)', [O]), null);
  assert.equal(P.ownedMediaPath('', [O]), null);
  // crew: owner folder or their own legacy folder
  assert.equal(P.ownedMediaPath(`${X}/render/r.jpg`, [O, X]), `${X}/render/r.jpg`);
});

test('upload names are unguessable and storage-safe', () => {
  const a = U.randomUploadId();
  const b = U.randomUploadId();
  assert.notEqual(a, b);
  assert.ok(a.length >= 24);
  assert.equal(U.safeUploadName('My COI (2026).pdf'), 'My_COI__2026_.pdf');
  assert.ok(!U.safeUploadName('../../x').includes('..'));
  assert.ok(!U.safeUploadName('a/b\\c').includes('/'));
});

test('crew seat rule matches public.is_crew_of (pending / expired seats refused)', async () => {
  const W = await jiti.import(path.join(root, 'lib/workspace.ts'));
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  for (const s of ['active', 'trialing', 'past_due', 'canceling', null]) {
    assert.equal(W.crewSeatIsActive({ seat_status: s }), true, String(s));
  }
  assert.equal(W.crewSeatIsActive({ seat_status: 'canceled', seat_period_end: future }), true);
  assert.equal(W.crewSeatIsActive({ seat_status: 'canceled', seat_period_end: past }), false);
  assert.equal(W.crewSeatIsActive({ seat_status: 'unpaid', seat_period_end: null }), false);
  for (const s of ['pending_payment', 'expired', 'incomplete', 'incomplete_expired']) {
    assert.equal(W.crewSeatIsActive({ seat_status: s }), false, s);
  }
});

test('resolveWorkspace: owners, active crew, inactive crew', async () => {
  const W = await jiti.import(path.join(root, 'lib/workspace.ts'));
  const fake = (row) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
  });
  const owner = await W.resolveWorkspace('u1', fake(null));
  assert.deepEqual([owner.ok, owner.ownerUserId, owner.isCrew], [true, 'u1', false]);
  const crew = await W.resolveWorkspace('c1', fake({ owner_user_id: 'o1', seat_status: 'active' }));
  assert.deepEqual([crew.ok, crew.ownerUserId, crew.isCrew], [true, 'o1', true]);
  const pending = await W.resolveWorkspace('c2', fake({ owner_user_id: 'o1', seat_status: 'pending_payment' }));
  assert.equal(pending.ok, false);
  assert.equal(pending.ownerUserId, null);
});
