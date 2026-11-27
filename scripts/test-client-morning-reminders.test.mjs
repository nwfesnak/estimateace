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


const page = fs.readFileSync(path.join(root, 'app/page.tsx'), 'utf8');
const R = loadTsModule('lib/client-morning-reminders.ts');
const cronRoute = fs.readFileSync(path.join(root, 'app/api/cron/client-appointment-reminders/route.ts'), 'utf8');
const notifyRoute = fs.readFileSync(path.join(root, 'app/api/appointment-notify/route.ts'), 'utf8');
const notifications = fs.readFileSync(path.join(root, 'lib/notifications.ts'), 'utf8');
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));

const notified = (extra = {}) => ({
  at: '2026-11-26T18:00:00.000Z',
  kind: 'scheduled',
  status: 'notified',
  appointmentId: 'a1',
  emails: ['client@example.com'],
  phones: ['(704) 555-0100'],
  timeZone: 'America/New_York',
  ...extra,
});
// 2:00 PM EST on Fri Nov 27 2026
const appt = { id: 'a1', estimateId: 'EST-1', jobName: 'GOFF Test', datetime: '2026-11-27T19:00:00.000Z', notify: notified() };

test('due at 7 AM local on the appointment day, with email and text recipients', () => {
  const due = R.selectDueClientReminders([appt], {}, new Date('2026-11-27T12:05:00.000Z')); // 7:05 AM EST
  assert.equal(due.length, 1);
  assert.equal(due[0].dateKey, '2026-11-27');
  assert.deepEqual(due[0].emails, ['client@example.com']);
  assert.deepEqual(due[0].phones, ['(704) 555-0100']);
});

test('not due before the local reminder hour (6:59 AM EST = 11:59 UTC)', () => {
  assert.equal(R.selectDueClientReminders([appt], {}, new Date('2026-11-27T11:59:00.000Z')).length, 0);
});

test('uses the company time zone, not UTC: Pacific appointment waits for 7 AM Pacific', () => {
  const west = { ...appt, datetime: '2026-11-27T22:00:00.000Z', notify: notified({ timeZone: 'America/Los_Angeles' }) };
  // 12:05 UTC = 4:05 AM PST: too early
  assert.equal(R.selectDueClientReminders([west], {}, new Date('2026-11-27T12:05:00.000Z')).length, 0);
  // 15:05 UTC = 7:05 AM PST: due
  assert.equal(R.selectDueClientReminders([west], {}, new Date('2026-11-27T15:05:00.000Z')).length, 1);
});

test('profile time zone is used when the notify status has none', () => {
  const a = { ...appt, notify: notified({ timeZone: undefined }) };
  assert.equal(R.selectDueClientReminders([a], { timeZone: 'America/Chicago' }, new Date('2026-11-27T12:30:00.000Z')).length, 0); // 6:30 CST
  assert.equal(R.selectDueClientReminders([a], { timeZone: 'America/Chicago' }, new Date('2026-11-27T13:05:00.000Z')).length, 1);
});

test('custom reminder hour and opt-out on the profile', () => {
  const now = new Date('2026-11-27T12:05:00.000Z'); // 7:05 EST
  assert.equal(R.selectDueClientReminders([appt], { clientReminderHour: 8 }, now).length, 0);
  assert.equal(R.selectDueClientReminders([appt], { clientReminderHour: 99 }, now).length, 1); // invalid -> 7
  assert.equal(R.selectDueClientReminders([appt], { clientMorningReminderEnabled: false }, now).length, 0);
});

test('skips other days, past appointments, schedule-only and stale notify', () => {
  const now = new Date('2026-11-27T12:05:00.000Z');
  assert.equal(R.selectDueClientReminders([{ ...appt, datetime: '2026-11-28T19:00:00.000Z' }], {}, now).length, 0);
  assert.equal(R.selectDueClientReminders([{ ...appt, datetime: '2026-11-27T12:00:00.000Z' }], {}, now).length, 0);
  assert.equal(R.selectDueClientReminders([{ ...appt, notify: notified({ status: 'scheduled_only' }) }], {}, now).length, 0);
  assert.equal(R.selectDueClientReminders([{ ...appt, notify: undefined }], {}, now).length, 0);
  assert.equal(R.selectDueClientReminders([{ ...appt, notify: notified({ appointmentId: 'other' }) }], {}, now).length, 0);
  assert.equal(R.selectDueClientReminders([{ ...appt, notify: notified({ emails: [], phones: [] }) }], {}, now).length, 0);
});

test('reminder text names the company, today, the local time and STOP', () => {
  const m = R.buildClientMorningReminderMessages({
    appointmentDateTime: appt.datetime,
    timeZone: 'America/New_York',
    companyName: 'Dogs and Cats',
    companyPhone: '555-0100',
    jobName: 'GOFF Test',
    location: 'Lake Wylie, SC',
    reference: 'EST-1',
  });
  assert.match(m.smsText, /^Dogs and Cats: Reminder, your appointment \(GOFF Test\) is today at 2:00 PM (EST|GMT-5)/);
  assert.match(m.smsText, /Reply STOP to opt out\.$/);
  assert.match(m.subject, /scheduled today at 2:00 PM/);
  assert.match(m.emailText, /Friday, November 27, 2026/);
  assert.match(m.emailHtml, /Lake Wylie, SC/);
});

test('cron is hourly, secured, claims once per appointment per day, and sends text + email', () => {
  const cron = vercel.crons.find((c) => c.path === '/api/cron/client-appointment-reminders');
  assert.ok(cron);
  assert.equal(cron.schedule, '0 * * * *');
  assert.match(cronRoute, /Bearer \$\{cronSecret\}/);
  assert.match(cronRoute, /rateLimit\(`appt-client-reminder:/);
  assert.match(cronRoute, /sendEmailNotification\(/);
  assert.match(cronRoute, /sendSmsNotification\(phone, messages\.smsText, \{ waitForStatus: true \}\)/);
  assert.match(cronRoute, /reserveSendQuota\(ownerId, 'sms'/);
});

test('scheduling notify waits for Twilio delivery status and explains 30034', () => {
  assert.match(notifyRoute, /sendSmsNotification\(phone, messages\.smsText, \{ waitForStatus: true \}\)/);
  assert.match(notifications, /errCode === 30034/);
  assert.match(page, /if \(data\.errors\?\.length\) notificationSummary \+= /);
});
