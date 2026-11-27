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

const setupSrc = fs.readFileSync(path.join(root, 'lib/crew-setup-link.ts'), 'utf8');
const billingSrc = fs.readFileSync(path.join(root, 'lib/crew-billing.ts'), 'utf8');
const webhookSrc = fs.readFileSync(path.join(root, 'app/api/billing/webhook/route.ts'), 'utf8');
const resetSrc = fs.readFileSync(path.join(root, 'app/reset-password/page.tsx'), 'utf8');
const notifySrc = fs.readFileSync(path.join(root, 'lib/notifications.ts'), 'utf8');

const M = loadTsModule('lib/crew-setup-link.ts', {
  '@/lib/notifications': { sendEmailNotification: async () => ({ ok: true, id: 'em_test' }) },
  '@/lib/rate-limit': { rateLimit: async () => ({ allowed: true, used: 1, resetAt: Date.now() + 1000 }) },
  '@/lib/stripe-server': { getAppUrl: () => 'https://app.estimateace.com' },
});

test('password setup URL stays on the app domain and never uses supabase.co', () => {
  const url = M.buildCrewPasswordSetupUrl('https://app.estimateace.com/', {
    hashed_token: 'abc123TOKEN',
    action_link:
      'https://jiujzujkednnkjymawdk.supabase.co/auth/v1/verify?token=secret&type=recovery&redirect_to=https://app.estimateace.com/reset-password',
  });
  assert.equal(
    url,
    'https://app.estimateace.com/reset-password?token_hash=abc123TOKEN&type=recovery'
  );
  assert.equal(M.isEstimateAceAppUrl(url), true);
  assert.equal(M.isEstimateAceAppUrl('https://jiujzujkednnkjymawdk.supabase.co/auth/v1/verify'), false);
  assert.equal(M.buildCrewPasswordSetupUrl('https://app.estimateace.com', { action_link: 'https://x.supabase.co/a' }), null);
  assert.equal(M.buildCrewPasswordSetupUrl('https://app.estimateace.com', { hashed_token: '' }), null);
});

test('crew setup email includes plain text, the app URL, and no supabase or shortener hosts', () => {
  const setupUrl =
    'https://app.estimateace.com/reset-password?token_hash=abc123TOKEN&type=recovery';
  const email = M.buildCrewSetupEmail({
    company: 'Dogs and Cats',
    appUrl: 'https://app.estimateace.com',
    setupUrl,
  });
  assert.equal(email.subject, 'Dogs and Cats added you to their EstimateAce crew');
  assert.match(email.text, /Dogs and Cats added you as a crew member/);
  assert.match(email.text, /Set your password/);
  assert.match(email.text, /token_hash=abc123TOKEN/);
  assert.match(email.html, /href="https:\/\/app\.estimateace\.com\/reset-password\?token_hash=abc123TOKEN&amp;type=recovery"/);
  assert.match(email.html, /https:\/\/app\.estimateace\.com/);
  assert.doesNotMatch(email.text, /supabase\.co|bit\.ly|tinyurl|ow\.ly/i);
  assert.doesNotMatch(email.html, /supabase\.co|bit\.ly|tinyurl|ow\.ly/i);
  assert.doesNotMatch(email.subject, /FREE|URGENT|ACT NOW|!!!/i);
});

test('first-activation claim bucket and idempotency key prevent a same-second double send', () => {
  const id = 'crew-user-123';
  assert.equal(M.crewSetupActivatedBucket(id), 'crew-setup-activated:crew-user-123');
  assert.equal(M.crewSetupIdempotencyKey('activated', id), 'crew-setup-activated:crew-user-123');
  const at = new Date('2026-11-27T16:13:02.130Z');
  assert.equal(M.crewSetupIdempotencyKey('resend', id, at), 'crew-setup-resend:crew-user-123:2026-11-27T16');
  // Same hour → same key (a double click is collapsed). Next hour can resend.
  const laterSameHour = new Date('2026-11-27T16:59:59.000Z');
  assert.equal(
    M.crewSetupIdempotencyKey('resend', id, laterSameHour),
    M.crewSetupIdempotencyKey('resend', id, at)
  );
});

test('sendCrewSetupLink claims activation once, then skips a parallel second call', async () => {
  const hits = [];
  const sends = [];
  const links = [];
  let sentAtWrites = 0;

  const hooks = {
    '@/lib/rate-limit': {
      rateLimit: async (bucket, windowSec, max) => {
        hits.push({ bucket, windowSec, max });
        const used = hits.filter((h) => h.bucket === bucket).length;
        return { allowed: used <= max, used, resetAt: Date.now() + windowSec * 1000 };
      },
    },
    '@/lib/notifications': {
      sendEmailNotification: async (to, subject, text, options) => {
        sends.push({ to, subject, text, options });
        return { ok: true, id: `em_${sends.length}` };
      },
    },
    '@/lib/stripe-server': { getAppUrl: () => 'https://app.estimateace.com' },
  };

  // Reload with these mocks (fresh module each time via transpile is fine / we need one load)
  const { sendCrewSetupLink } = loadTsModule('lib/crew-setup-link.ts', hooks);

  const admin = {
    auth: {
      admin: {
        generateLink: async () => {
          links.push(true);
          return {
            data: {
              properties: {
                hashed_token: `tok_${links.length}`,
                action_link: `https://jiujzujkednnkjymawdk.supabase.co/auth/v1/verify?token=secret${links.length}`,
              },
            },
            error: null,
          };
        },
        getUserById: async () => ({ data: { user: { app_metadata: { crew_invite_mode: 'link' } } } }),
        updateUserById: async () => {
          sentAtWrites += 1;
          return { data: {}, error: null };
        },
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { profile: { company: 'Dogs and Cats' } }, error: null }),
          }),
        }),
      }),
    }),
  };

  const input = {
    crewUserId: 'crew-abc',
    email: 'nwfesnak@outlook.com',
    ownerUserId: 'owner-1',
    reason: 'activated',
  };
  const first = await sendCrewSetupLink(admin, input);
  const second = await sendCrewSetupLink(admin, input);
  assert.equal(first.ok, true);
  assert.equal(first.skipped, undefined);
  assert.equal(second.ok, true);
  assert.equal(second.skipped, 'already-sent');
  assert.equal(sends.length, 1);
  assert.equal(links.length, 1);
  assert.equal(sentAtWrites, 1);
  assert.equal(sends[0].options.idempotencyKey, 'crew-setup-activated:crew-abc');
  assert.match(sends[0].text, /https:\/\/app\.estimateace\.com\/reset-password\?token_hash=tok_1/);
  assert.doesNotMatch(sends[0].text, /supabase\.co/);
  assert.equal(
    hits.filter((h) => h.bucket === 'crew-setup-activated:crew-abc' && h.max === 1 && h.windowSec === 365 * 24 * 60 * 60)
      .length,
    2
  );
});

test('source: first-activation send is claimed + idempotent, and all seat webhooks share one helper', () => {
  assert.match(setupSrc, /reason === 'activated'/);
  assert.match(setupSrc, /crew-setup-activated:/);
  assert.match(setupSrc, /idempotencyKey: crewSetupIdempotencyKey/);
  assert.match(setupSrc, /hashed_token/);
  assert.match(setupSrc, /token_hash/);
  assert.doesNotMatch(setupSrc, /action_link(?![\s\S]*hashed_token)/);
  // Must not email the raw Supabase verify URL.
  assert.match(setupSrc, /Never fall back to the Supabase action_link|never fall back to the Supabase action_link/i);
  assert.match(notifySrc, /Idempotency-Key/);
  assert.match(billingSrc, /sendCrewSetupLink/);
  for (const ev of [
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'invoice.paid',
  ]) {
    assert.equal(webhookSrc.includes(ev), true, ev);
  }
  assert.equal((webhookSrc.match(/upsertCrewSeatFromStripe/g) || []).length >= 3, true);
  assert.match(resetSrc, /verifyOtp/);
  assert.match(resetSrc, /token_hash/);
  const confirmSrc = fs.readFileSync(path.join(root, 'app/auth/confirm/page.tsx'), 'utf8');
  assert.match(confirmSrc, /verifyOtp/);
  assert.match(confirmSrc, /token_hash/);
});
