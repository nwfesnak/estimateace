// Run: npm run test:receptionist — AI Receptionist cost caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const C = await jiti.import(path.join(root, 'lib/receptionist-caps.ts'));
const T = await jiti.import(path.join(root, 'lib/receptionist-twiml.ts'));
const U = await jiti.import(path.join(root, 'lib/receptionist-usage.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');
const caps = C.RECEPTIONIST_CAPS;
const usage = (o = {}) => ({ monthAiSeconds: 0, dayAiSeconds: 0, monthForwardSeconds: 0, monthSms: 0, ...o });

test('all caps live in one config constant with sane values', () => {
  assert.equal(caps.maxCallMinutes, 10);
  assert.ok(caps.monthlyAiMinutes > caps.dailyAiMinutes && caps.dailyAiMinutes >= caps.maxCallMinutes);
  assert.ok(caps.callsPerCallerPerHour >= 1);
  assert.ok(caps.monthlyLeadSms > 0 && caps.monthlyForwardMinutes > 0);
  assert.deepEqual([...caps.alertPercents], [80, 100]);
});

test('under the caps → AI answers with a per-call budget ≤ 10 min', () => {
  const d = C.decideInboundCall({ usage: usage(), callerAllowed: true, hasForwardNumber: true });
  assert.deepEqual(d, { action: 'ai', maxCallSeconds: 600 });
  // Close to the monthly cap: the call budget shrinks to what is left.
  const near = C.decideInboundCall({
    usage: usage({ monthAiSeconds: caps.monthlyAiMinutes * 60 - 180 }),
    callerAllowed: true,
    hasForwardNumber: true,
  });
  assert.deepEqual(near, { action: 'ai', maxCallSeconds: 180 });
});

test('monthly / daily cap → forward to the handoff number, never the AI', () => {
  for (const [u, reason] of [
    [usage({ monthAiSeconds: caps.monthlyAiMinutes * 60 }), 'monthly_ai_cap'],
    [usage({ dayAiSeconds: caps.dailyAiMinutes * 60 - 30 }), 'daily_ai_cap'],
  ]) {
    assert.deepEqual(C.decideInboundCall({ usage: u, callerAllowed: true, hasForwardNumber: true }), {
      action: 'forward',
      reason,
    });
    assert.deepEqual(C.decideInboundCall({ usage: u, callerAllowed: true, hasForwardNumber: false }), {
      action: 'call_back',
      reason,
    });
  }
});

test('usage unreadable (e.g. migration not applied) → fail closed: no AI', () => {
  const d = C.decideInboundCall({ usage: null, callerAllowed: true, hasForwardNumber: true });
  assert.equal(d.action, 'forward');
  assert.equal(C.decideInboundCall({ usage: null, callerAllowed: true, hasForwardNumber: false }).action, 'call_back');
});

test('forwarding is capped too; caller rate limit rejects (busy, not billed)', () => {
  const over = usage({ monthAiSeconds: 1e9, monthForwardSeconds: caps.monthlyForwardMinutes * 60 });
  assert.deepEqual(C.decideInboundCall({ usage: over, callerAllowed: true, hasForwardNumber: true }), {
    action: 'call_back',
    reason: 'forward_cap',
  });
  assert.equal(C.forwardOrCallBack('ai_off', over, true).action, 'call_back');
  assert.equal(C.forwardOrCallBack('ai_off', usage(), true).action, 'forward');
  assert.deepEqual(C.decideInboundCall({ usage: usage(), callerAllowed: false, hasForwardNumber: true }), {
    action: 'reject',
    reason: 'caller_rate_limit',
  });
  assert.equal(C.callerBucket('u1', '+1 (555) 010-2000'), 'recv:caller:u1:5550102000');
});

test('per-call time cap: callTimeUp honors the session budget and the hard max', () => {
  const start = Date.parse('2026-11-19T12:00:00Z');
  const s = { createdAt: new Date(start).toISOString(), maxCallSeconds: 180 };
  assert.equal(C.callTimeUp(s, start + 179_000), false);
  assert.equal(C.callTimeUp(s, start + 180_000), true);
  // A bogus larger budget can't exceed the 10-minute hard max.
  assert.equal(C.callTimeUp({ ...s, maxCallSeconds: 99999 }, start + 600_000), true);
  assert.equal(C.callTimeUp({ createdAt: s.createdAt }, start + 599_000), false);
});

test('billing period + billed minutes', () => {
  const now = new Date('2026-11-19T15:00:00Z');
  const p = C.usagePeriod({ currentPeriodEnd: '2026-12-05T10:00:00Z' }, now);
  assert.equal(p.periodStart, '2026-11-05');
  assert.equal(p.day, '2026-11-19');
  assert.equal(C.usagePeriod(null, now).periodStart, '2026-11-01');
  assert.equal(C.usagePeriod({ currentPeriodEnd: '2026-01-01T00:00:00Z' }, now).periodStart, '2026-11-01');
  assert.equal(C.billedSeconds(0), 0);
  assert.equal(C.billedSeconds(1), 60);
  assert.equal(C.billedSeconds(80), 120);
  // Daily bucket is New York time (00:30 UTC on the 20th is still the 19th in NY).
  assert.equal(C.usageDay(new Date('2026-11-20T00:30:00Z')), '2026-11-19');
});

test('every forwarded call carries a Dial timeLimit', () => {
  const x = T.transferTwiml({ transferTo: '+15550102000', say: 'Connecting' });
  assert.match(x, new RegExp(`timeLimit="${caps.forwardCallMaxMinutes * 60}"`));
  assert.match(T.transferTwiml({ transferTo: '+15550102000', silent: true, timeLimitSec: 999999 }), /timeLimit="1800"/);
});

test('alerts: 80% and 100% each once; crossing both at once sends one email', async () => {
  assert.deepEqual(C.alertLevelsReached(caps.monthlyAiMinutes * 60 * 0.79), []);
  assert.deepEqual(C.alertLevelsReached(caps.monthlyAiMinutes * 60 * 0.8), [80]);
  assert.deepEqual(C.alertLevelsReached(caps.monthlyAiMinutes * 60), [80, 100]);

  const claimed = new Set();
  const sent = [];
  const admin = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { profile: { email: 'pro@example.com' } } }) }) }),
    }),
    rpc: async (_fn, a) => {
      const k = `${a.p_period_start}:${a.p_level}`;
      if (claimed.has(k)) return { data: false, error: null };
      claimed.add(k);
      return { data: true, error: null };
    },
  };
  const send = async (to, subject) => void sent.push(`${to}|${subject}`);
  const base = { userId: 'u1', periodStart: '2026-11-05', admin, send };
  assert.deepEqual(await U.maybeSendUsageAlerts({ ...base, monthAiSeconds: 200 * 60 }), [80]);
  assert.deepEqual(await U.maybeSendUsageAlerts({ ...base, monthAiSeconds: 210 * 60 }), []);
  assert.deepEqual(await U.maybeSendUsageAlerts({ ...base, monthAiSeconds: 250 * 60 }), [100]);
  assert.deepEqual(await U.maybeSendUsageAlerts({ ...base, monthAiSeconds: 260 * 60 }), []);
  assert.equal(sent.length, 2);
  // Next period, jump straight past 100%: one email, both levels claimed.
  assert.deepEqual(await U.maybeSendUsageAlerts({ ...base, periodStart: '2026-12-05', monthAiSeconds: 300 * 60 }), [100]);
  assert.equal(sent.length, 3);
  assert.ok(claimed.has('2026-12-05:80'));
});

test('lead SMS cap: false when over the cap or when usage is unavailable', async () => {
  const mk = (data, error = null) => ({
    rpc: async () => ({ data, error }),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
  });
  assert.equal(await U.takeLeadSms('u1', mk([{ allowed: true, used: 3 }])), true);
  assert.equal(await U.takeLeadSms('u1', mk([{ allowed: false, used: 150 }])), false);
  assert.equal(await U.takeLeadSms('u1', mk(null, { message: 'function does not exist' })), false);
  assert.equal(await U.takeLeadSms('u1', null), false);
});

test('webhooks wire the caps and never loop without a session', () => {
  const voice = src('app/api/webhooks/twilio/voice/route.ts');
  assert.match(voice, /decideInboundCall\(/);
  assert.match(voice, /callerBucket\(tenant\.userId, from\)/);
  assert.match(voice, /maxCallSeconds: decision\.maxCallSeconds/);
  assert.match(voice, /return capped\('session_unavailable'\)/);
  for (const r of ['gather', 'think']) {
    const s = src(`app/api/webhooks/twilio/voice/${r}/route.ts`);
    assert.match(s, /callTimeUp\(session\)/, r);
    assert.match(s, /if \(!session\) \{\s*\/\/ No session[^\n]*\n\s*return twimlXmlResponse\(sayHangupTwiml/, r);
  }
  const status = src('app/api/webhooks/twilio/voice/status/route.ts');
  assert.match(status, /recordReceptionistCall\(/);
  assert.match(status, /maybeSendUsageAlerts\(/);
  assert.match(src('lib/receptionist-leads.ts'), /takeLeadSms\(input\.userId\)/);
  assert.match(src('lib/receptionist-call-session.ts'), /if \(error\) throw new Error\(`save call session/);
  // Migration file shipped (not applied by the app).
  const sql = src('supabase/receptionist-usage-caps-2026-11.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.receptionist_usage/);
  assert.match(sql, /ON CONFLICT \(call_sid\) DO NOTHING/);
  assert.match(sql, /REVOKE ALL ON public\.receptionist_usage FROM PUBLIC, anon, authenticated/);
});

test('settings screen shows minutes used / cap', () => {
  assert.match(src('components/ReceptionistUsageCard.tsx'), /aiMinutesUsed\} \/ \{usage\.aiMinutesCap/);
  assert.match(src('components/AIReceptionist.tsx'), /<ReceptionistUsageCard/);
  assert.match(src('app/api/receptionist/usage/route.ts'), /getUserFromRequest/);
});
