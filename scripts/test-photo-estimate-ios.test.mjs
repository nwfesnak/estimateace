// Photo estimate on iOS: scrollable sheet + fixed footer, upload budget, HEIC, timeouts, errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const C = await jiti.import(path.join(root, 'lib/photo-compress.ts'));
const P = await jiti.import(path.join(root, 'lib/photo-estimate.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

test('upload budget keeps 5 photos well under the 4.5 MB Vercel body limit', () => {
  const per = C.perPhotoBudget(P.PHOTO_ESTIMATE_LIMITS.maxPhotos);
  assert.ok(per * P.PHOTO_ESTIMATE_LIMITS.maxPhotos <= C.PHOTO_UPLOAD_BUDGET.totalChars);
  assert.ok(C.PHOTO_UPLOAD_BUDGET.totalChars <= P.PHOTO_ESTIMATE_LIMITS.maxTotalChars);
  assert.ok(P.PHOTO_ESTIMATE_LIMITS.maxTotalChars + 200_000 < 4_500_000);
  assert.ok(per <= P.PHOTO_ESTIMATE_LIMITS.maxPhotoChars);
  assert.equal(C.perPhotoBudget(1), C.PHOTO_UPLOAD_BUDGET.perPhotoChars);
  assert.equal(C.PHOTO_UPLOAD_BUDGET.maxEdges[0], 1600);
  assert.equal(C.PHOTO_UPLOAD_BUDGET.qualities[0], 0.8);
});

test('resize never upscales and keeps aspect ratio', () => {
  assert.deepEqual(C.fitWithin(4032, 3024, 1600), { width: 1600, height: 1200 });
  assert.deepEqual(C.fitWithin(3024, 4032, 1600), { width: 1200, height: 1600 });
  assert.deepEqual(C.fitWithin(800, 600, 1600), { width: 800, height: 600 });
});

test('HEIC and empty-type iPhone picks count as images; documents do not', () => {
  assert.ok(C.isHeicFile({ name: 'IMG_0001.HEIC', type: '' }));
  assert.ok(C.isHeicFile({ name: 'x', type: 'image/heif' }));
  assert.ok(C.looksLikeImageFile({ name: 'IMG_0001.HEIC', type: '' }));
  assert.ok(C.looksLikeImageFile({ name: 'photo.jpg', type: 'image/jpeg' }));
  assert.ok(!C.looksLikeImageFile({ name: 'scope.pdf', type: 'application/pdf' }));
});

test('error messages are explicit for platform failures (413 / 504 / non-JSON)', () => {
  assert.match(P.photoEstimateErrorMessage(413), /too large/);
  assert.match(P.photoEstimateErrorMessage(504), /took too long/);
  assert.match(P.photoEstimateErrorMessage(500), /server had a problem/);
  assert.equal(P.photoEstimateErrorMessage(422, 'Add a note'), 'Add a note');
});

test('API: low reasoning effort, JSON mode, timeout under maxDuration, latency logged', () => {
  const r = src('app/api/photo-estimate/route.ts');
  const maxDuration = Number(r.match(/export const maxDuration = (\d+)/)[1]);
  const aiMs = Number(r.match(/AI_TIMEOUT_MS = ([\d_]+)/)[1].replace(/_/g, ''));
  assert.ok(maxDuration >= 150 && maxDuration <= 300, `maxDuration ${maxDuration}`);
  assert.ok(aiMs >= 120_000 && aiMs / 1000 < maxDuration - 10, 'AI timeout must fire before the function dies');
  assert.match(r, /reasoning_effort: reasoningEffortFor\(model\)/);
  assert.match(r, /response_format: \{ type: 'json_object' \}/);
  assert.match(r, /max_tokens: 8000/);
  assert.match(r, /ms: Date\.now\(\) - started/);
});

test('sheet: portal, flex column with scrollable body and always-visible footer', () => {
  const m = src('components/PhotoEstimateModal.tsx');
  assert.match(m, /createPortal\(sheet, document\.body\)/);
  assert.match(m, /min-h-0 flex-1 overflow-y-auto overscroll-contain/);
  assert.match(m, /WebkitOverflowScrolling: 'touch'/);
  assert.match(m, /data-testid="photo-estimate-footer"/);
  assert.match(m, /safe-area-inset-bottom/);
  assert.match(m, /window\.visualViewport/);
  assert.match(m, /h-\[100dvh\]/);
  assert.doesNotMatch(m, /max-h-\[95vh\]/);
  // Submit + errors live in the footer, after the scroll area.
  const footer = m.indexOf('data-testid="photo-estimate-footer"');
  assert.ok(m.indexOf('onClick={() => void generate()}') > footer);
  assert.ok(m.indexOf('{errorBox}') > footer);
  // Client timeout outlasts the server's AI timeout and is surfaced.
  assert.match(m, /CLIENT_TIMEOUT_MS = 170_000/);
  assert.match(m, /signal: ctrl\.signal/);
  assert.match(m, /No line items came back/);
});
