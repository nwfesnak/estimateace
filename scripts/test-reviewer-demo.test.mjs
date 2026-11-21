// Run: npm run test:reviewer-demo — store-reviewer Turnstile allowlist + login route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const D = await jiti.import(path.join(root, 'lib/reviewer-demo.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

test('only the published reviewer email is allowlisted by default', () => {
  assert.equal(D.DEFAULT_REVIEWER_DEMO_EMAIL, 'appreview@estimateace.com');
  assert.equal(D.isReviewerDemoEmail('appreview@estimateace.com'), true);
  assert.equal(D.isReviewerDemoEmail('  AppReview@EstimateAce.com  '), true);
  assert.equal(D.isReviewerDemoEmail('owner@example.com'), false);
  assert.equal(D.isReviewerDemoEmail(''), false);
  assert.equal(D.isReviewerDemoEmail(null), false);
});

test('login uses the server allowlist route only for the demo email', () => {
  const page = src('app/page.tsx');
  assert.match(page, /isReviewerDemoEmail\(trimmedEmail\)/);
  assert.match(page, /\/api\/auth\/reviewer-login/);
  assert.match(page, /supabase\.auth\.setSession/);
  // Regular logins still require Turnstile when it is enabled.
  assert.match(page, /turnstileEnabled && !authCaptchaToken/);
});

test('reviewer-login route is locked down', () => {
  const route = src('app/api/auth/reviewer-login/route.ts');
  assert.match(route, /isReviewerDemoEmail\(email\)/);
  assert.match(route, /rateLimit\(`reviewer-login:/);
  assert.match(route, /REVIEWER_DEMO_PASSWORD/);
  assert.match(route, /reviewer_demo_password_ok/);
  assert.match(route, /generateLink/);
  assert.match(route, /verifyOtp/);
  assert.doesNotMatch(route, /captchaOption|captchaToken|TURNSTILE_SITE_KEY/);
});

test('SQL helper is service-role only and email-scoped', () => {
  const sql = src('supabase/reviewer-demo-login-2026-11.sql');
  assert.match(sql, /appreview@estimateace\.com/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.reviewer_demo_password_ok/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.reviewer_demo_password_ok\(text, text\) TO service_role/);
  assert.match(sql, /FROM anon/);
  assert.match(sql, /FROM authenticated/);
  assert.match(sql, /extensions\.crypt/);
});
