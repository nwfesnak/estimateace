// Run: npm run test:photo-estimate — photo estimate, upsells, renderings labels, LiDAR scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const P = await jiti.import(path.join(root, 'lib/photo-estimate.ts'));
const R = await jiti.import(path.join(root, 'lib/room-scan.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

const tiny = 'data:image/jpeg;base64,' + 'A'.repeat(100);
const sumParts = (l) =>
  Math.round((l.materialsList.reduce((s, m) => s + m.total, 0) + (l.laborBreakdown?.total || 0)) * 100) / 100;

const AI = {
  scopeSummary: 'Repaint living room walls and replace baseboard',
  trade: 'painting',
  confidence: 'high',
  lines: [
    {
      description: 'Prep and paint walls, 2 coats',
      qty: 400,
      unit: 'sf',
      laborHours: 10,
      materials: [
        { description: 'Interior paint (gal)', qty: 3, unit: 'gal', unitCost: 40 },
        { description: 'Tape, plastic, patch', qty: 1, unit: 'kit', unitCost: 25 },
      ],
    },
    { description: 'x', qty: 1, unit: 'EA', laborHours: 1, materials: [] }, // too short → dropped
    { description: 'Nothing priced', qty: 1, unit: 'EA', laborHours: 0, materials: [] }, // $0 → dropped
  ],
  upsells: [{ description: 'Paint ceiling', reason: 'Ceiling looks stained', qty: 200, unit: 'SF', laborHours: 4, materials: [{ description: 'Ceiling paint', qty: 2, unit: 'gal', unitCost: 35 }] }],
  assumptions: ['Wall area estimated from photos'],
  questions: ['Same color?'],
};

test('photo limits: 1-5 images, image types only, size caps', () => {
  assert.equal(P.validatePhotos([]).status, 400);
  assert.equal(P.validatePhotos(Array(6).fill(tiny)).status, 400);
  assert.equal(P.validatePhotos(['https://evil.example/x.jpg']).status, 400);
  assert.equal(P.validatePhotos(['data:image/svg+xml;base64,AAAA']).status, 400);
  assert.equal(P.validatePhotos(['data:image/jpeg;base64,' + 'A'.repeat(1_600_000)]).status, 413);
  assert.equal(P.validatePhotos(Array(5).fill('data:image/jpeg;base64,' + 'A'.repeat(900_000))).status, 413);
  assert.deepEqual(P.validatePhotos([tiny, tiny]), { photos: [tiny, tiny] });
});

test('pricing: trade defaults, markup on materials, labor rate, region, materials + labor = total', () => {
  const e = P.buildPhotoEstimate(AI, { tradeId: 'painting', regional: { materialMultiplier: 1, laborMultiplier: 1 } });
  assert.equal(e.lines.length, 1);
  assert.equal(e.laborRate, 55);
  assert.equal(e.markupPercent, 20);
  const l = e.lines[0];
  assert.equal(l.unit, 'SF');
  assert.equal(l.materialsList[0].unitPrice, 48); // 40 + 20%
  assert.equal(l.materialsList[1].total, 30);
  assert.equal(l.laborBreakdown.total, 550);
  assert.equal(l.total, 144 + 30 + 550);
  assert.equal(sumParts(l), l.total);
  assert.equal(l.unitPrice, Math.round((l.total / 400) * 100) / 100);
  assert.equal(e.subtotal, l.total);
  assert.equal(e.upsells.length, 1);
  assert.equal(e.upsells[0].reason, 'Ceiling looks stained');
  assert.deepEqual(e.questions, ['Same color?']);

  const custom = P.buildPhotoEstimate(AI, {
    tradeId: 'painting',
    markupPercent: 35,
    regional: { materialMultiplier: 1.2, laborMultiplier: 1.5 },
  });
  assert.equal(custom.laborRate, 82.5);
  assert.equal(custom.lines[0].materialsList[0].unitPrice, 64.8); // 40 × 1.2 × 1.35
  assert.equal(sumParts(custom.lines[0]), custom.lines[0].total);
});

test("contractor's remembered prices win; silly AI numbers are capped", () => {
  const mem = { materials: [{ key: 'interior paint gal', label: 'Interior paint (gal)', unitPrice: 55, updatedAt: 'x' }], laborRate: 70 };
  const e = P.buildPhotoEstimate(AI, { tradeId: 'painting', priceMemory: mem });
  assert.equal(e.laborRate, 70);
  assert.equal(e.lines[0].laborBreakdown.rate, 70);
  assert.equal(sumParts(e.lines[0]), e.lines[0].total);

  const wild = P.buildPhotoEstimate(
    { lines: [{ description: 'Huge job', qty: 1e12, unit: '<script>', laborHours: 1e9, materials: [{ description: 'Gold', qty: 1, unit: 'ea', unitCost: 1e9 }] }] },
    { tradeId: 'general' }
  );
  const w = wild.lines[0];
  assert.equal(w.qty, P.PHOTO_ESTIMATE_LIMITS.maxQty);
  assert.equal(w.unit, 'LS');
  assert.equal(w.laborBreakdown.hours, P.PHOTO_ESTIMATE_LIMITS.maxLaborHours);
  assert.ok(w.materialsList[0].unitPrice <= P.PHOTO_ESTIMATE_LIMITS.maxUnitCost * 1.2 + 0.01);
  assert.equal(P.buildPhotoEstimate({ lines: Array(40).fill(AI.lines[0]) }, {}).lines.length, P.PHOTO_ESTIMATE_LIMITS.maxLines);
  assert.equal(P.parseAiJson('```json\n{"a":1}\n```').a, 1);
  assert.equal(P.parseAiJson('no json'), null);
});

test('edits before saving keep materials + labor = line total', () => {
  const l = P.buildPhotoEstimate(AI, { tradeId: 'painting' }).lines[0];
  const edited = P.applyLineEdit(l, { qty: 450, unitPrice: 2.15, description: 'Walls (2 coats)' });
  assert.equal(edited.total, 967.5);
  assert.equal(sumParts(edited), edited.total);
  assert.equal(edited.description, 'Walls (2 coats)');
  const zero = P.applyLineEdit(l, { unitPrice: 0 });
  assert.equal(zero.total, 0);
  assert.equal(sumParts(zero), 0);
});

test('lines become normal estimate rows; upsells can be customer options', () => {
  const e = P.buildPhotoEstimate(AI, { tradeId: 'painting' });
  const row = P.toEstimateItem(e.lines[0], { id: 1 });
  assert.equal(row.price, e.lines[0].unitPrice);
  assert.equal(row.total, e.lines[0].total);
  assert.ok(Array.isArray(row.materialsList) && row.laborBreakdown);
  assert.equal(row.optional, undefined);
  assert.equal(P.toEstimateItem(e.upsells[0], { id: 2, optional: true }).optional, true);
});

test('measurements: LiDAR result and manual fallback', () => {
  const m = R.scanToMeasurements({ floorSqft: 182.44, wallSqft: 389.9, perimeterLf: 54.2, ceilingFt: 8.1, doors: 1, windows: 2 });
  assert.deepEqual(m, { floorSqft: 182.4, wallSqft: 389.9, perimeterLf: 54.2, ceilingFt: 8.1, doors: 1, windows: 2, source: 'lidar' });
  const man = R.manualMeasurements({ lengthFt: 12, widthFt: 15, ceilingFt: 8, doors: 1, windows: 2 });
  assert.equal(man.floorSqft, 180);
  assert.equal(man.perimeterLf, 54);
  assert.equal(man.wallSqft, 54 * 8 - 21 - 30);
  assert.equal(R.manualMeasurements({ lengthFt: 0, widthFt: 10 }), null);
  assert.equal(P.sanitizeMeasurements({ floorSqft: -5, ceilingFt: 999 }), null);
  assert.deepEqual(P.sanitizeMeasurements({ floorSqft: '200', source: 'lidar' }).floorSqft, 200);
  assert.match(P.buildPhotoEstimatePrompt({ tradeLabel: 'painting', photoCount: 2, measurements: m }), /LiDAR room scan/);
});

test('room scan is hidden off iOS (web / Android / node)', async () => {
  assert.equal(await R.isRoomScanAvailable(), false);
});

test('API route: auth, paywall, per-minute limit, one AI quota unit per photo', () => {
  const r = src('app/api/photo-estimate/route.ts');
  assert.match(r, /getUserFromRequest\(request\)/);
  assert.match(r, /enforceAppAccess\(user\.id\)/);
  assert.match(r, /rateLimit\(`photo-estimate:\$\{user\.id\}`/);
  assert.match(r, /reserveAiQuota\(await workspaceOwnerId\(user\.id\), 'ai', photos\.length\)/);
  assert.ok(r.indexOf('validatePhotos((') > 0 && r.indexOf('validatePhotos((') < r.indexOf('await reserveAiQuota('), 'bad input never burns quota');
});

test('native LiDAR plugin is wired into the iOS project', () => {
  const swift = src('ios/App/App/RoomScanPlugin.swift');
  assert.match(swift, /jsName = "RoomScan"/);
  assert.match(swift, /RoomCaptureSession\.isSupported/);
  assert.match(swift, /@available\(iOS 16\.0, \*\)/);
  assert.match(src('ios/App/App/EstimateAceBridgeViewController.swift'), /registerPluginInstance\(RoomScanPlugin\(\)\)/);
  assert.match(src('ios/App/App/SceneDelegate.swift'), /EstimateAceBridgeViewController\(\)/);
  const pbx = src('ios/App/App.xcodeproj/project.pbxproj');
  assert.equal((pbx.match(/RoomScanPlugin\.swift in Sources/g) || []).length, 2);
  assert.equal((pbx.match(/EstimateAceBridgeViewController\.swift in Sources/g) || []).length, 2);
  assert.equal((pbx.match(/"-weak_framework",\s*RoomPlan,/g) || []).length, 2);
  assert.match(src('ios/App/App/Info.plist'), /NSCameraUsageDescription<\/key>\s*<string>[^<]*LiDAR room scanner/);
  assert.match(src('docs/MOBILE_RELEASE.md'), /LiDAR room scan/);
  assert.match(src('lib/room-scan.ts'), /registerPlugin<RoomScanPlugin>\('RoomScan'\)/);
});

test('renderings say "concept rendering" in the app, PDF preview and email', () => {
  const page = src('app/page.tsx');
  assert.match(page, /After \(concept rendering\)/);
  assert.match(page, /Concept rendering — an AI illustration/);
  assert.match(page, /RENDER_FINISH_PRESETS\.map/);
  assert.match(src('app/api/documents/send/route.ts'), /concept renderings/i);
  assert.match(page, /<PhotoEstimateModal/);
});
