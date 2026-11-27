import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = process.cwd();
function loadTsModule(relPath) {
  const src = fs.readFileSync(path.join(root, relPath), 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out)(() => ({}), mod, mod.exports);
  return mod.exports;
}

const { addClosedJobKey, closedWorkAtMs, estimateCreatedAtMs, tightJobMatchClosesEstimate } =
  loadTsModule('lib/closed-work-match.ts');
const page = fs.readFileSync(path.join(root, 'app/page.tsx'), 'utf8');

// Same shape as jobMatchKeys() in app/page.tsx.
const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
function jobKeys(row) {
  const job = norm(row.jobName);
  if (!job) return [];
  const zip = norm(row.zipCode).slice(0, 5);
  const addr = norm(row.address);
  const keys = [`job:${job}`];
  if (zip) keys.push(`jobzip:${job}|${zip}`);
  if (addr) keys.push(`jobaddr:${job}|${addr}`);
  return keys;
}
function closedIndex(rows) {
  const m = new Map();
  for (const r of rows) for (const k of jobKeys(r)) addClosedJobKey(m, k, closedWorkAtMs(r));
  return m;
}

// Repeat client: a paid invoice for the same client + zip was archived in August.
const paidArchived = {
  id: 'INV-0254',
  jobName: 'Lease Evaluations Inc',
  zipCode: '00000',
  address: '1 Old Job Rd',
  paymentStatus: 'paid',
  archived_at: '2026-08-01 01:06:44.91+00',
};

test('regression: a NEW estimate for a repeat client is not hidden by old closed work', () => {
  const fresh = {
    id: 'EST-4BCF4C-0259',
    jobName: 'Lease Evaluations Inc ', // trailing space, as typed
    zipCode: '00000',
    address: '9 New Job Ave',
    date: '2026-11-27',
    profile: { _jobSettingsSnapshottedAt: '2026-11-27T22:19:37.406Z' },
  };
  assert.equal(tightJobMatchClosesEstimate(fresh, jobKeys(fresh), closedIndex([paidArchived])), false);
});

test('still hides the work-order twin created before the work was closed', () => {
  const twin = {
    id: 'EST-0250',
    jobName: 'Lease Evaluations Inc',
    zipCode: '00000',
    date: '2026-07-20',
    profile: { _jobSettingsSnapshottedAt: '2026-07-20T15:00:00Z' },
  };
  assert.equal(tightJobMatchClosesEstimate(twin, jobKeys(twin), closedIndex([paidArchived])), true);
});

test('legacy rows with no creation time keep the old (hide) behavior', () => {
  const legacy = { id: 'EST-0100', jobName: 'Lease Evaluations Inc', zipCode: '00000' };
  assert.equal(estimateCreatedAtMs(legacy), null);
  assert.equal(tightJobMatchClosesEstimate(legacy, jobKeys(legacy), closedIndex([paidArchived])), true);
});

test('date-only fallback is a local day, and only a newer day counts as new work', () => {
  const sameDay = { id: 'EST-0101', jobName: 'Lease Evaluations Inc', zipCode: '00000', date: '2026-07-31' };
  const later = { ...sameDay, id: 'EST-0102', date: '2026-08-02' };
  const idx = closedIndex([paidArchived]);
  assert.equal(tightJobMatchClosesEstimate(sameDay, jobKeys(sameDay), idx), true);
  assert.equal(tightJobMatchClosesEstimate(later, jobKeys(later), idx), false);
});

test('bare job name alone never hides, and the latest closure time is used', () => {
  const other = { id: 'EST-0300', jobName: 'Lease Evaluations Inc', zipCode: '11111', date: '2026-01-01' };
  assert.equal(tightJobMatchClosesEstimate(other, jobKeys(other), closedIndex([paidArchived])), false);
  const m = new Map();
  addClosedJobKey(m, 'jobzip:a|1', 100);
  addClosedJobKey(m, 'jobzip:a|1', 300);
  assert.equal(m.get('jobzip:a|1'), 300);
  addClosedJobKey(m, 'jobzip:a|1', null);
  assert.equal(m.get('jobzip:a|1'), null);
});

test('wiring: Estimates list and purge both use the time-aware job match', () => {
  assert.match(page, /tightJobMatchClosesEstimate\(est, jobMatchKeys\(est\), closed\.jobKeys\)/);
  assert.match(page, /addClosedJobKey\(jobKeys, k, closedAt\)/);
  assert.doesNotMatch(page, /closed\.jobKeys\.has\(/);
});
