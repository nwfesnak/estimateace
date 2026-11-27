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

const M = loadTsModule('lib/appointment-notify.ts');
const C = loadTsModule('lib/appointment-confirm.ts');
const page = fs.readFileSync(path.join(root, 'app/page.tsx'), 'utf8');
const route = fs.readFileSync(path.join(root, 'app/api/appointment-notify/route.ts'), 'utf8');
const confirmRoute = fs.readFileSync(path.join(root, 'app/api/appointment-confirm/route.ts'), 'utf8');
const confirmPage = fs.readFileSync(path.join(root, 'app/appointment/confirm/page.tsx'), 'utf8');
const confirmClient = fs.readFileSync(path.join(root, 'app/appointment/confirm/ConfirmClient.tsx'), 'utf8');

const whenIso = '2026-11-20T19:00:00.000Z'; // 2:00 PM EST

test('formats the appointment in the owner timezone with a readable zone name', () => {
  const when = M.formatAppointmentWhen(whenIso, 'America/New_York');
  assert.match(when, /Friday, November 20, 2026/);
  assert.match(when, /at 2:00 PM/);
  assert.match(when, /EST|EDT|GMT-5|GMT-4/);
  assert.equal(M.resolveNotifyTimeZone('Not/AZone'), 'America/New_York');
  assert.equal(M.resolveNotifyTimeZone('America/Chicago'), 'America/Chicago');
});

test('new schedule message names the job, date, and time — not the job title as the greeting', () => {
  const msg = M.buildAppointmentNotifyMessages({
    jobName: 'Kitchen remodel',
    invoiceNumber: 'EST-1042',
    customerName: '',
    address: '123 Main St',
    city: 'Tampa',
    state: 'FL',
    zipCode: '33602',
    appointmentDateTime: whenIso,
    timeZone: 'America/New_York',
    companyName: 'Ace Painting',
    companyPhone: '(813) 555-0100',
    kind: 'scheduled',
  });
  assert.equal(msg.subject, 'Your appointment with Ace Painting is scheduled');
  assert.match(msg.emailText, /^Hello,/m);
  assert.doesNotMatch(msg.emailText, /Hello Kitchen remodel/);
  assert.match(msg.emailText, /Ace Painting has scheduled your appointment/);
  assert.match(msg.emailText, /Job: Kitchen remodel/);
  assert.match(msg.emailText, /Date & time: Friday, November 20, 2026 at 2:00 PM/);
  assert.match(msg.emailText, /Location: 123 Main St, Tampa, FL 33602/);
  assert.match(msg.emailText, /Reference: EST-1042/);
  assert.match(msg.emailText, /Questions\? Call \(813\) 555-0100/);
  assert.match(msg.emailHtml, /Your appointment is scheduled/);
  assert.match(msg.emailHtml, /#10b981/);
  assert.match(msg.smsText, /^Ace Painting: Your appointment \(Kitchen remodel\) is scheduled for Friday, November 20, 2026 at 2:00 PM/);
  assert.match(msg.smsText, /Reply STOP to opt out/);
});

test('reschedule wording uses updated time in email, SMS, and subject', () => {
  const msg = M.buildAppointmentNotifyMessages({
    jobName: 'Kitchen remodel',
    invoiceNumber: 'EST-1042',
    appointmentDateTime: whenIso,
    timeZone: 'America/New_York',
    companyName: 'Ace Painting',
    kind: 'updated',
  });
  assert.equal(msg.subject, 'Your appointment with Ace Painting has been updated');
  assert.match(msg.emailText, /has updated the date and time/);
  assert.match(msg.emailText, /Date & time \(updated\): Friday, November 20, 2026 at 2:00 PM/);
  assert.match(msg.smsText, /has been updated to Friday, November 20, 2026 at 2:00 PM/);
  assert.match(msg.emailHtml, /Your appointment has been updated/);
});

test('collects emails and phones, and never treats the job title as the customer name', () => {
  const est = {
    jobName: 'Kitchen remodel',
    emails: ['  pat@example.com ', 'bad', 'pat@example.com'],
    phones: ['(813) 555-0100', ''],
  };
  assert.deepEqual(M.collectEstimateEmails(est), ['pat@example.com']);
  assert.deepEqual(M.collectEstimatePhones(est), ['(813) 555-0100']);
  assert.equal(M.customerNameFromEstimate(est), '');
  assert.equal(M.customerNameFromEstimate({ clientName: 'Pat Rivera', jobName: 'Kitchen remodel' }), 'Pat Rivera');
});

test('Twilio / Resend configuration helpers', () => {
  assert.equal(M.isTwilioConfigured({}), false);
  assert.equal(
    M.isTwilioConfigured({
      TWILIO_ACCOUNT_SID: 'ACxx',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_PHONE_NUMBER: '+15551234567',
    }),
    true
  );
  assert.equal(M.isResendConfigured({}), false);
  assert.equal(M.isResendConfigured({ RESEND_API_KEY: 're_123' }), true);
});

test('API route previews without sending, honors channel flags, records status, and requires the calendar tab', () => {
  assert.match(route, /requireTab:\s*'calendar'/);
  assert.match(route, /preview === true/);
  assert.match(route, /scheduleOnly === true/);
  assert.match(route, /sendEmail === true/);
  assert.match(route, /sendSms === true/);
  assert.match(route, /getSmsOptIn/);
  assert.match(route, /consent\?\.optedOut/);
  assert.match(route, /sendEmailNotification/);
  assert.match(route, /sendSmsNotification/);
  assert.match(route, /companyName:/);
  assert.match(route, /html: messages\.emailHtml/);
  assert.match(route, /_appointmentNotify/);
  assert.match(route, /status: 'scheduled_only'/);
  assert.doesNotMatch(route, /api\.resend\.com\/emails/);
});

test('calendar Save opens the confirm dialog instead of sending immediately', () => {
  assert.match(page, /data-testid="schedule-notify-dialog"/);
  assert.match(page, /data-testid="notify-text-checkbox"/);
  assert.match(page, /data-testid="notify-email-checkbox"/);
  assert.match(page, /data-testid="schedule-and-notify"/);
  assert.match(page, /data-testid="schedule-only"/);
  assert.match(page, /data-testid="schedule-notify-cancel"/);
  assert.match(page, /data-testid="schedule-notify-preview"/);
  assert.match(page, /openScheduleConfirm/);
  assert.match(page, /confirmScheduleAppointment\('notify'\)/);
  assert.match(page, /confirmScheduleAppointment\('only'\)/);
  assert.match(page, /Review & schedule/);
  assert.match(page, /Schedule & notify/);
  assert.match(page, /Schedule only/);
  assert.match(page, /Text customer/);
  assert.match(page, /Email customer/);
  assert.match(page, /Shown in your timezone/);
  assert.match(page, /Confirm updated appointment/);
  assert.match(page, /hasCrewTab\('calendar'\)/);
  // Must not auto-notify from the calendar Save buttons anymore
  assert.equal((page.match(/onClick=\{\(\) => void scheduleAppointment\(\)\}/g) || []).length, 0);
  assert.match(page, /preview: true/);
  assert.match(page, /notify\?\.status === 'scheduled_only'/);
});

test('messages include a Confirm link in SMS and a Confirm appointment button in email', () => {
  const confirmUrl = 'https://app.estimateace.com/appointment/confirm?t=abc.secret-token-value';
  const msg = M.buildAppointmentNotifyMessages({
    jobName: 'Kitchen remodel',
    invoiceNumber: 'EST-1042',
    appointmentDateTime: whenIso,
    timeZone: 'America/New_York',
    companyName: 'Ace Painting',
    kind: 'scheduled',
    confirmUrl,
  });
  assert.match(msg.emailText, /Please confirm that you can make this appointment:/);
  assert.match(msg.emailText, /appointment\/confirm\?t=/);
  assert.match(msg.emailHtml, />Confirm appointment</);
  assert.ok(msg.emailHtml.includes(confirmUrl));
  assert.match(msg.smsText, /Confirm: https:\/\/app\.estimateace\.com\/appointment\/confirm\?t=/);
  assert.match(msg.smsText, /Reply STOP to opt out/);
});

test('confirm tokens are unguessable, expire after the appointment, and reschedule invalidates the old token', () => {
  const first = C.issueAppointmentConfirm('EST-3F9A1C-0001', whenIso);
  const parsed = C.parseConfirmToken(first.token);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.estimateId, 'EST-3F9A1C-0001');
  assert.equal(first.hash, C.hashConfirmToken(first.token));
  assert.equal(C.confirmHashMatches(first.token, first.hash), true);
  assert.doesNotMatch(first.hash, /EST-3F9A1C-0001/);
  assert.notEqual(first.token, first.hash);
  assert.equal(first.expiresAt, whenIso);
  assert.equal(C.isConfirmExpired(whenIso, new Date('2026-11-20T18:59:59.000Z')), false);
  assert.equal(C.isConfirmExpired(whenIso, new Date('2026-11-20T19:00:00.001Z')), true);

  const second = C.issueAppointmentConfirm('EST-3F9A1C-0001', '2026-11-21T19:00:00.000Z');
  assert.notEqual(second.token, first.token);
  assert.notEqual(second.hash, first.hash);
  assert.equal(C.confirmHashMatches(first.token, second.hash), false);
  assert.equal(C.parseConfirmToken('not-a-token').ok, false);
  assert.equal(C.parseConfirmToken('').ok, false);

  const url = C.appointmentConfirmUrl(first.token, 'https://app.estimateace.com');
  assert.match(url, /^https:\/\/app\.estimateace\.com\/appointment\/confirm\?t=/);
});

test('confirmation badge is pending until confirmed, then shows time', () => {
  const awaiting = {
    at: whenIso,
    kind: 'scheduled',
    status: 'notified',
    confirmedAt: null,
  };
  const badgeA = C.confirmationBadge(awaiting, 'America/New_York');
  assert.equal(badgeA.kind, 'awaiting');
  assert.equal(badgeA.text, 'Awaiting confirmation');

  const confirmed = { ...awaiting, confirmedAt: '2026-11-19T20:15:00.000Z' };
  const badgeC = C.confirmationBadge(confirmed, 'America/New_York');
  assert.equal(badgeC.kind, 'confirmed');
  assert.match(badgeC.text, /Confirmed by customer/);
  assert.match(badgeC.text, /Nov 19, 2026/);
  assert.equal(C.confirmationBadge({ status: 'scheduled_only' }, 'America/New_York').kind, 'none');
  assert.equal(C.publicNotifyStatus({ ...confirmed, confirmTokenHash: 'abc' }).confirmTokenHash, undefined);
});

test('public confirm route never confirms on GET, confirms on POST, and is rate limited', () => {
  assert.match(confirmRoute, /export async function GET/);
  assert.match(confirmRoute, /export async function POST/);
  assert.match(confirmRoute, /rateLimit\(/);
  assert.match(confirmRoute, /clientIp/);
  assert.match(confirmRoute, /Never confirm on GET/);
  assert.match(confirmRoute, /confirmHashMatches/);
  assert.match(confirmRoute, /isConfirmExpired/);
  assert.match(confirmRoute, /confirmedAt/);
  assert.match(confirmRoute, /sendEmailNotification/);
  assert.match(confirmRoute, /settingsDocId/);
  // GET handler must not write confirmedAt
  const getFn = confirmRoute.split('export async function GET')[1].split('export async function POST')[0];
  assert.doesNotMatch(getFn, /confirmedAt:\s*now/);
  assert.doesNotMatch(getFn, /\.update\(/);
  const postFn = confirmRoute.split('export async function POST')[1];
  assert.match(postFn, /confirmedAt/);
  assert.match(postFn, /\.update\(/);
});

test('confirm page is public, mobile-friendly, and only confirms via POST', () => {
  assert.match(confirmPage, /appointment-confirm-page|AppointmentConfirmClient/);
  assert.match(confirmPage, /robots/);
  assert.match(confirmClient, /data-testid="appointment-confirm-page"/);
  assert.match(confirmClient, /data-testid="appointment-confirm-button"/);
  assert.match(confirmClient, /Confirm appointment/);
  assert.match(confirmClient, /method: 'GET'/);
  assert.match(confirmClient, /method: 'POST'/);
  assert.match(confirmClient, /JSON.stringify\(\{ token \}\)/);
  assert.doesNotMatch(confirmClient, /method: 'GET'[\s\S]{0,200}confirm appointment/i);
  assert.match(confirmClient, /max-w-md/);
});

test('contractor UI shows a green check or awaiting confirmation, and notify issues a token', () => {
  assert.match(page, /data-testid="appointment-confirmed-badge"/);
  assert.match(page, /data-testid="appointment-awaiting-badge"/);
  assert.match(page, /data-testid="job-appointment-confirmed-badge"/);
  assert.match(page, /Awaiting confirmation/);
  assert.match(page, /Confirmed by customer/);
  assert.match(page, /unique Confirm link/);
  assert.match(page, /appointmentConfirmUrl\(/);
  assert.match(page, /refreshAppointmentConfirmations/);
  assert.match(route, /issueAppointmentConfirm/);
  assert.match(route, /confirmTokenHash/);
  assert.match(route, /confirmedAt: null/);
  assert.match(route, /publicNotifyStatus/);
});
