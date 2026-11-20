import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

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
        if (fs.existsSync(c)) {
          return loadTsModule(path.relative(root, c), mocks);
        }
      }
    }
    return require(spec);
  };
  const fn = new Function('require', 'module', 'exports', transpiled);
  fn(localRequire, mod, mod.exports);
  return mod.exports;
}

const jobSettingsMod = loadTsModule('lib/job-settings-snapshot.ts');
const clientMediaMod = loadTsModule('lib/client-media.ts');

test('Job 1 keeps AI renderings and setting when global or Job 2 turns rendering off', () => {
  // Step 1: Global has aiJobRenderingEnabled: true when Job 1 is created
  const globalWhenJob1Created = {
    aiJobRenderingEnabled: true,
    taxesEnabled: true,
    showDiscountOnEstimate: true,
    termsDisplayMode: 'printed',
    chargeCCFee: true,
    ccFeePercentage: 3.5,
    depositPercentage: 25,
    showDepositOnApproval: true,
    depositMinimumAmount: 500,
    thirdPartyEscrowEnabled: true,
    escrowMinimumAmount: 2500,
    paymentSettings: {
      venmo: { enabled: true, connected: true, handle: '@job1-venmo' },
      stripe: { enabled: true, connected: true },
    },
    tradeId: 'painting',
    hourlyRate: 95,
    laborType: 'hourly',
  };

  const job1Snapshot = jobSettingsMod.buildNewJobSettingsSnapshot(globalWhenJob1Created);
  const job1Row = {
    id: 'est-job-1',
    user_id: 'user-1',
    photoUrls: ['user-1/job1/photo1.jpg'],
    profile: {
      ...job1Snapshot,
      _jobSettingsSnapshottedAt: '2026-11-20T12:00:00.000Z',
      _jobRenderings: [
        {
          id: 'render-1',
          sourcePath: 'user-1/job1/photo1.jpg',
          resultPath: 'user-1/job1/render1.png',
          lineDescription: 'Paint exterior siding',
          createdAt: '2026-11-20T12:01:00.000Z',
        },
      ],
    },
  };

  // Step 2: Contractor turns AI rendering OFF globally (and/or on Job 2) and changes other globals
  const globalLater = {
    aiJobRenderingEnabled: false,
    taxesEnabled: false,
    showDiscountOnEstimate: false,
    termsDisplayMode: 'link',
    chargeCCFee: false,
    ccFeePercentage: 2.9,
    depositPercentage: 10,
    showDepositOnApproval: false,
    depositMinimumAmount: 1000,
    thirdPartyEscrowEnabled: false,
    escrowMinimumAmount: 5000,
    paymentSettings: {
      venmo: { enabled: false, connected: false, handle: '' },
      stripe: { enabled: false, connected: false },
    },
    tradeId: 'plumbing',
    hourlyRate: 120,
    laborType: 'fixed',
  };

  const job2Snapshot = jobSettingsMod.buildNewJobSettingsSnapshot(globalLater);
  const job2Row = {
    id: 'est-job-2',
    user_id: 'user-1',
    photoUrls: ['user-1/job2/photo1.jpg'],
    profile: {
      ...job2Snapshot,
      _jobSettingsSnapshottedAt: '2026-11-20T13:00:00.000Z',
      _jobRenderings: [],
    },
  };

  // Job 1 MUST keep aiJobRenderingEnabled === true and its saved rendering on client view
  assert.equal(jobSettingsMod.resolveAiJobRenderingEnabled(job1Row.profile, globalLater), true);
  const job1Plan = clientMediaMod.planClientMedia(job1Row, 'user-1', globalLater);
  assert.equal(job1Plan.renderings.length, 1);
  assert.equal(job1Plan.renderings[0].afterPath, 'user-1/job1/render1.png');

  // Job 2 MUST have aiJobRenderingEnabled === false and no renderings
  assert.equal(jobSettingsMod.resolveAiJobRenderingEnabled(job2Row.profile, globalLater), false);
  const job2Plan = clientMediaMod.planClientMedia(job2Row, 'user-1', globalLater);
  assert.equal(job2Plan.renderings.length, 0);

  // Job 1 MUST keep all its other snapshotted settings
  const resolvedJob1 = jobSettingsMod.resolveJobSettingsFromDoc(job1Row.profile, globalLater);
  assert.equal(resolvedJob1.taxesEnabled, true);
  assert.equal(resolvedJob1.showDiscountOnEstimate, true);
  assert.equal(resolvedJob1.termsDisplayMode, 'printed');
  assert.equal(resolvedJob1.chargeCCFee, true);
  assert.equal(resolvedJob1.ccFeePercentage, 3.5);
  assert.equal(resolvedJob1.depositPercentage, 25);
  assert.equal(resolvedJob1.showDepositOnApproval, true);
  assert.equal(resolvedJob1.depositMinimumAmount, 500);
  assert.equal(resolvedJob1.thirdPartyEscrowEnabled, true);
  assert.equal(resolvedJob1.escrowMinimumAmount, 2500);
  assert.equal(resolvedJob1.paymentSettings.venmo.handle, '@job1-venmo');
  assert.equal(resolvedJob1.paymentSettings.venmo.enabled, true);
  assert.equal(resolvedJob1.tradeId, 'painting');
});

test('Legacy jobs without snapshot keys fall back to current global settings', () => {
  const legacyJob = {
    id: 'est-legacy',
    user_id: 'user-1',
    profile: {
      company: 'Legacy Co',
      _jobRenderings: [
        {
          id: 'r-legacy',
          sourcePath: 'user-1/a.jpg',
          resultPath: 'user-1/r.png',
          lineDescription: 'Deck stain',
        },
      ],
    },
  };

  assert.equal(
    jobSettingsMod.resolveAiJobRenderingEnabled(legacyJob.profile, { aiJobRenderingEnabled: false }),
    false
  );
  assert.equal(
    jobSettingsMod.resolveAiJobRenderingEnabled(legacyJob.profile, { aiJobRenderingEnabled: true }),
    true
  );
  assert.equal(jobSettingsMod.resolveDocTaxesEnabled(legacyJob, false), false);
  assert.equal(jobSettingsMod.resolveDocTaxesEnabled(legacyJob, true), true);

  const planOff = clientMediaMod.planClientMedia(legacyJob, 'user-1', { aiJobRenderingEnabled: false });
  assert.equal(planOff.renderings.length, 0);
  const planOn = clientMediaMod.planClientMedia(legacyJob, 'user-1', { aiJobRenderingEnabled: true });
  assert.equal(planOn.renderings.length, 1);
});

test('Explicitly disabling payment methods on a snapshotted job is NOT overwritten by global settings', () => {
  const jobWithVenmoDisabled = {
    _jobSettingsSnapshottedAt: '2026-11-20T14:00:00.000Z',
    chargeCCFee: false,
    paymentSettings: {
      venmo: { enabled: false, connected: false, handle: '' },
      stripe: { enabled: true, connected: true },
    },
  };
  const globalLater = {
    chargeCCFee: true,
    ccFeePercentage: 4,
    paymentSettings: {
      venmo: { enabled: true, connected: true, handle: '@new-venmo' },
      stripe: { enabled: true, connected: true },
    },
  };

  const resolved = jobSettingsMod.resolveJobSettingsFromDoc(jobWithVenmoDisabled, globalLater);
  assert.equal(resolved.chargeCCFee, false);
  assert.equal(resolved.paymentSettings.venmo.enabled, false);
  assert.equal(resolved.paymentSettings.venmo.handle, '');
});

test('Source wiring guarantees profile edits never overwrite saved jobs and API routes use snapshot', () => {
  const pageSrc = fs.readFileSync(path.join(root, 'app/page.tsx'), 'utf8');
  // saveProfileSettings must NOT call saveToDB
  const saveProfileIdx = pageSrc.indexOf('const saveProfileSettings = async');
  assert.notEqual(saveProfileIdx, -1);
  const saveProfileBlock = pageSrc.slice(saveProfileIdx, saveProfileIdx + 1200);
  assert.equal(saveProfileBlock.includes('saveToDB('), false);

  // Per-job rendering toggle exists and saves only to the active job
  assert.ok(pageSrc.includes('data-testid="job-rendering-toggle"'));
  assert.ok(pageSrc.includes('resolveDocTaxesEnabled(doc, getGlobalTaxesEnabled())'));
  assert.ok(pageSrc.includes('jobTaxRateSnapshotRef'));

  const docRoute = fs.readFileSync(path.join(root, 'app/api/client/document/route.ts'), 'utf8');
  assert.ok(docRoute.includes('resolveJobSettingsFromDoc'));

  const checkoutRoute = fs.readFileSync(path.join(root, 'app/api/client/checkout/route.ts'), 'utf8');
  assert.ok(checkoutRoute.includes('resolveJobSettingsFromDoc'));

  const approveRoute = fs.readFileSync(path.join(root, 'app/api/client/approve/route.ts'), 'utf8');
  assert.ok(approveRoute.includes('resolveDocTaxesEnabled'));
});
