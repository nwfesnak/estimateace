// Run: npm run test:crew  (fourth security scan: crew client links + receptionist AI cap)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const W = await jiti.import(path.join(root, 'lib/workspace.ts'));
const R = await jiti.import(path.join(root, 'lib/receptionist-input.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

const OWNER = '11111111-1111-4111-8111-111111111111';
const CREW = '22222222-2222-4222-8222-222222222222';

/** Minimal stand-in for the service-role client: crew_members lookup only. */
function fakeAdmin(row) {
  return {
    from(table) {
      assert.equal(table, 'crew_members');
      return {
        select() {
          return {
            eq() {
              return { maybeSingle: async () => ({ data: row, error: null }) };
            },
          };
        },
      };
    },
  };
}
const crewRow = (pricing, financials, extra = {}) => ({
  owner_user_id: OWNER,
  role: pricing && financials ? 'full' : 'limited',
  can_see_pricing: pricing,
  can_see_estimates_and_financials: financials,
  seat_status: 'active',
  seat_period_end: null,
  ...extra,
});

test('client links: owner and full-access crew are allowed', async () => {
  const owner = await W.requireWorkspaceOwner(OWNER, fakeAdmin(null), { requireFinancials: true });
  assert.equal(owner.denied, undefined);
  assert.equal(owner.ownerUserId, OWNER);
  assert.equal(owner.isCrew, false);

  const full = await W.requireWorkspaceOwner(CREW, fakeAdmin(crewRow(true, true)), {
    requireFinancials: true,
  });
  assert.equal(full.denied, undefined);
  assert.equal(full.ownerUserId, OWNER);
  assert.equal(full.isCrew, true);
});

test('client links: restricted crew get a generic 403', async () => {
  for (const [pricing, financials] of [
    [false, false],
    [true, false],
    [false, true],
  ]) {
    const r = await W.requireWorkspaceOwner(CREW, fakeAdmin(crewRow(pricing, financials)), {
      requireFinancials: true,
    });
    assert.ok(r.denied, `pricing=${pricing} financials=${financials} must be refused`);
    assert.equal(r.denied.status, 403);
    const body = await r.denied.json();
    assert.equal(body.code, 'crew_permission_denied');
    assert.doesNotMatch(body.error, /pricing|financial|estimate/i);
  }
});

test('client links: restricted crew still work where the option is not asked for', async () => {
  const r = await W.requireWorkspaceOwner(CREW, fakeAdmin(crewRow(false, false)));
  assert.equal(r.denied, undefined);
  assert.equal(r.ownerUserId, OWNER);
});

test('client links: inactive seats are still refused first (seat message)', async () => {
  const r = await W.requireWorkspaceOwner(
    CREW,
    fakeAdmin(crewRow(true, true, { seat_status: 'pending_payment' })),
    { requireFinancials: true }
  );
  assert.equal(r.denied.status, 403);
  assert.equal((await r.denied.json()).code, 'crew_seat_inactive');
});

test('client links: every link-creating route asks for the financials check', () => {
  for (const f of [
    'app/api/documents/terms-link/route.ts',
    'app/api/documents/send/route.ts',
    'app/api/recurring/send/route.ts',
    'app/api/recurring/checkout/route.ts',
    'app/api/payments/job-checkout/route.ts',
  ]) {
    assert.match(
      src(f),
      /requireWorkspaceOwner\(user\.id, admin, \{ requireFinancials: true \}\)/,
      `${f} must refuse restricted crew`
    );
  }
  const plans = src('app/api/recurring/plans/route.ts');
  assert.match(plans, /if \(restricted\) return NextResponse\.json\(\{ ok: true, plan: maskMoneyDeep\(result\.plan\), clientLink: null \}\)/);
});

test('receptionist: input is capped (4000 chars, newest transcript kept)', () => {
  const big = 'x'.repeat(20000);
  const transcript = 'OLD'.repeat(3000) + 'Caller: my basement is flooding';
  const r = R.normalizeReceptionistInput({
    mode: 'reply',
    knowledgeBase: big,
    transcript,
    callerMessage: big,
    greeting: big,
    company: big,
    languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'zh'],
    urgentKeywords: big,
  });
  assert.equal(r.knowledgeBase.length, 4000);
  assert.equal(r.transcript.length, 4000);
  assert.ok(r.transcript.endsWith('my basement is flooding'));
  assert.equal(r.callerMessage.length, R.RECEPTIONIST_MAX_CALLER_MESSAGE);
  assert.equal(r.greeting.length, 500);
  assert.equal(r.company.length, 120);
  assert.equal(r.languages.length, 8);
  assert.equal(r.urgentKeywords.length, 500);
  const total = r.knowledgeBase.length + r.transcript.length + r.callerMessage.length + r.greeting.length;
  assert.ok(total <= 10000);
});

test('receptionist: defaults and modes', () => {
  const d = R.normalizeReceptionistInput(null);
  assert.equal(d.mode, 'reply');
  assert.deepEqual(d.languages, ['en']);
  assert.equal(d.company, 'the company');
  assert.equal(R.normalizeReceptionistInput({ mode: 'summarize' }).mode, 'summarize');
  assert.equal(R.normalizeReceptionistInput({ mode: 'other' }).mode, 'reply');
  assert.ok(R.RECEPTIONIST_MAX_TOKENS.reply > 0 && R.RECEPTIONIST_MAX_TOKENS.summarize > 0);
});

test('receptionist: POST checks paywall and daily AI quota before calling the AI', () => {
  const s = src('app/api/receptionist/route.ts');
  const post = s.slice(s.indexOf('export async function POST'));
  const iPaywall = post.indexOf('await enforceAppAccess(user.id)');
  const iQuota = post.indexOf("reserveAiQuota(await workspaceOwnerId(user.id), 'ai')");
  const iFetch = post.indexOf("fetch('https://api.x.ai/v1/chat/completions'");
  assert.ok(iPaywall > 0, 'paywall check missing');
  assert.ok(iQuota > iPaywall, 'quota must follow the paywall');
  assert.ok(iFetch > iQuota, 'AI call must come after both checks');
  assert.match(post, /normalizeReceptionistInput\(body\)/);
  assert.match(post, /max_tokens: RECEPTIONIST_MAX_TOKENS\[mode\]/);
});
