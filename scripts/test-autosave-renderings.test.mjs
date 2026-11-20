import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const page = fs.readFileSync(path.join(root, 'app/page.tsx'), 'utf8');

function sliceAfter(src, startNeedle, length = 2500) {
  const i = src.indexOf(startNeedle);
  assert.notEqual(i, -1, `missing ${startNeedle}`);
  return src.slice(i, i + length);
}

test('generate / refine / remove persist _jobRenderings immediately and update the latest-state ref first', () => {
  const generate = sliceAfter(page, 'const entry: JobRendering = {', 1800);
  assert.match(generate, /jobRenderingsRef\.current = next;/);
  assert.match(generate, /setJobRenderings\(next\)/);
  assert.match(generate, /await saveToDB\(\{\s*jobRenderings: next,\s*quiet: false\s*\}\)/);

  const remove = sliceAfter(page, 'const removeJobRendering = (id: string)', 900);
  assert.match(remove, /jobRenderingsRef\.current = next;/);
  assert.match(remove, /void saveToDB\(\{\s*jobRenderings: next,\s*quiet: true\s*\}\)/);

  const refine = sliceAfter(page, 'const refineJobRendering = async', 4500);
  assert.match(refine, /jobRenderingsRef\.current = next;/);
  assert.match(refine, /await saveToDB\(\{\s*jobRenderings: next,\s*quiet: false\s*\}\)/);
});

test('per-job rendering toggle saves jobSettings immediately without waiting for the debounce', () => {
  assert.equal((page.match(/data-testid="job-rendering-toggle"/g) || []).length, 2);
  assert.equal((page.match(/jobSettingsRef\.current = nextJobSettings;/g) || []).length, 2);
  assert.equal(
    (page.match(/await saveToDB\(\{\s*jobSettings: nextJobSettings,\s*quiet: true\s*\}\)/g) || []).length,
    2
  );
});

test('saveToDB always writes the job settings snapshot and latest _jobRenderings / items', () => {
  const snapshot = sliceAfter(page, 'const getDocumentProfileSnapshot =', 1800);
  assert.match(snapshot, /jobSettingsOverride \?\? jobSettingsRef\.current/);
  assert.match(snapshot, /_jobSettingsSnapshottedAt:/);
  assert.match(snapshot, /_jobRenderings: jobRenderingsRef\.current/);

  const save = sliceAfter(page, 'const saveToDB = async', 16000);
  assert.match(save, /renderingsToSave = options\?\.jobRenderings \?\? jobRenderingsRef\.current/);
  assert.match(save, /itemsToSave = itemsRef\.current/);
  assert.match(save, /_jobRenderings: renderingsToSave/);
  assert.match(save, /options\?\.jobSettings/);
  assert.match(save, /documentSaveChainRef\.current\.then\(runSave, runSave\)/);
});

test('auto-save debounce is 1s, uses saveToDBRef, and watches renderings, jobSettings, and items', () => {
  const debounce = sliceAfter(page, 'const debouncedSave = () => {', 4500);
  assert.match(debounce, /if \(profileRef\.current\?\.autoSaveEnabled === false\) return;/);
  assert.match(debounce, /autosavePendingRef\.current = true;/);
  assert.match(debounce, /,\s*1000\s*\)/);
  assert.match(debounce, /void saveToDBRef\.current\(/);
  assert.match(debounce, /jobRenderingsRef\.current/);
  assert.match(debounce, /itemsRef\.current/);

  // Dependency list includes translations (items), renderings, and the job settings snapshot
  const depsStart = debounce.indexOf('if (view === \'editor\') debouncedSave();');
  assert.notEqual(depsStart, -1);
  const deps = debounce.slice(depsStart, depsStart + 1200);
  assert.match(deps, /^\s*items,$/m);
  assert.match(deps, /^\s*jobRenderings,$/m);
  assert.match(deps, /^\s*jobSettings,$/m);
});

test('pending auto-save is flushed when leaving the editor, switching jobs, or hiding the page', () => {
  assert.match(page, /const leavingEditor = prevEditorViewRef\.current === 'editor' && view !== 'editor'/);
  assert.match(page, /if \(leavingEditor\) \{\s*void flushPendingAutosaveRef\.current\(\);/s);

  const load = sliceAfter(page, 'const loadSelectedEstimate = async', 600);
  assert.match(load, /await flushPendingAutosaveRef\.current\(\);/);
  assert.ok(
    load.indexOf('await flushPendingAutosaveRef.current()') < load.indexOf('loadedDocNumberRef.current'),
    'must flush the open job before changing the document id'
  );

  const fresh = sliceAfter(page, 'const newEstimate = async', 900);
  assert.match(fresh, /await flushPendingAutosaveRef.current\(\);/);
  assert.ok(
    fresh.indexOf('await flushPendingAutosaveRef.current()') < fresh.indexOf('skipAutosaveUntilRef.current'),
    'must flush the previous job before blocking autosave for a new blank form'
  );

  const hide = sliceAfter(page, 'const flushIfHidden = () => {', 900);
  assert.match(hide, /addEventListener\('pagehide'/);
  assert.match(hide, /addEventListener\('beforeunload'/);
  assert.match(hide, /addEventListener\('visibilitychange'/);
  assert.match(hide, /flushPendingAutosaveRef\.current\(\)/);
});

test('translations from PR #50 ride auto-save: items are updated, watched, and flushed with the latest ref', () => {
  const translate = sliceAfter(page, 'const translateDescription = async', 2200);
  assert.match(translate, /withItemTranslation\(it, translated, translateTo, text\)/);
  assert.match(translate, /itemsRef\.current = next;/);
  // Translate does not require a manual Save when auto-save is on:
  // items is an auto-save dependency and leaving the editor flushes.
  const debounce = sliceAfter(page, 'const debouncedSave = () => {', 4500);
  const depsStart = debounce.indexOf('if (view === \'editor\') debouncedSave();');
  const deps = debounce.slice(depsStart, depsStart + 1200);
  assert.match(deps, /^\s*items,$/m);
  assert.match(page, /itemsToSave = itemsRef\.current/);
});
