// Run: npm run test:item-translations — persist line-item translations for crew, strip from clients.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const T = await jiti.import(path.join(root, 'lib/item-translations.ts'));
const R = await jiti.import(path.join(root, 'lib/crew-redaction.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

const item = {
  id: 7,
  description: 'Replace fascia boards',
  qty: 1,
  unit: 'LS',
  price: 400,
  total: 400,
};

test('withItemTranslation stores translation, lang, timestamp, and source description', () => {
  const next = T.withItemTranslation(item, '  Reemplazar tableros de fascia  ', 'es', item.description, '2026-11-20T21:00:00.000Z');
  assert.equal(next.description, 'Replace fascia boards');
  assert.equal(next.translation, 'Reemplazar tableros de fascia');
  assert.equal(next.translationLang, 'es');
  assert.equal(next.translatedAt, '2026-11-20T21:00:00.000Z');
  assert.equal(next.translationSource, 'Replace fascia boards');
  assert.equal(T.itemHasTranslation(next), true);
  assert.equal(T.isItemTranslationStale(next), false);
});

test('empty translate text clears existing translation fields', () => {
  const saved = T.withItemTranslation(item, 'Hola', 'es');
  const cleared = T.withItemTranslation(saved, '   ', 'es');
  for (const key of T.ITEM_TRANSLATION_KEYS) assert.equal(key in cleared, false);
  assert.equal(cleared.description, item.description);
});

test('withoutItemTranslation clears saved fields; edited description is marked stale', () => {
  const saved = T.withItemTranslation(item, 'Reemplazar tableros de fascia', 'es', item.description);
  const edited = { ...saved, description: 'Replace fascia and soffit' };
  assert.equal(T.isItemTranslationStale(edited), true);
  assert.equal(T.itemTranslationText(edited), 'Reemplazar tableros de fascia');
  const cleared = T.withoutItemTranslation(edited);
  assert.equal(T.itemHasTranslation(cleared), false);
  assert.equal(T.isItemTranslationStale(cleared), false);
  assert.equal(cleared.description, 'Replace fascia and soffit');
  for (const key of T.ITEM_TRANSLATION_KEYS) assert.equal(key in cleared, false);
});

test('stripItemTranslations and stripTranslationsFromDocument drop internal fields only', () => {
  const saved = T.withItemTranslation(item, 'Reemplazar tableros de fascia', 'es');
  const stripped = T.stripItemTranslations([saved, { id: 8, description: 'Paint' }]);
  assert.equal('translation' in stripped[0], false);
  assert.equal(stripped[0].description, 'Replace fascia boards');
  assert.equal(stripped[0].price, 400);
  assert.equal(stripped[1].description, 'Paint');

  const doc = T.stripTranslationsFromDocument({
    id: 'EST-1',
    items: [saved],
    jobName: 'Smith',
  });
  assert.equal(doc.jobName, 'Smith');
  assert.equal('translation' in doc.items[0], false);

  const asString = T.stripTranslationsFromDocument({
    id: 'EST-2',
    items: JSON.stringify([saved]),
  });
  const parsed = JSON.parse(asString.items);
  assert.equal('translation' in parsed[0], false);
  assert.equal(parsed[0].description, 'Replace fascia boards');
});

test('clientSafeLineItem never includes translation keys', () => {
  const saved = T.withItemTranslation(item, 'Reemplazar tableros de fascia', 'es');
  const safe = T.clientSafeLineItem(saved, 0);
  for (const key of T.ITEM_TRANSLATION_KEYS) assert.equal(key in safe, false);
  assert.equal(safe.description, 'Replace fascia boards');
  assert.equal(safe.total, 400);
});

test('page persists translations on items, loads them, and shows a stale note', () => {
  const page = src('app/page.tsx');
  assert.match(page, /from '@\/lib\/item-translations'/);
  assert.match(page, /itemsToSave = itemsRef\.current \|\| items \|\| \[\]/);
  assert.match(page, /items: itemsToSave,/);
  assert.match(page, /normalizeLoadedLineItem/);
  assert.match(page, /return \{ \.\.\.item, qty, price, total \}/);
  assert.match(page, /withItemTranslation\(it, translated, translateTo, text\)/);
  assert.match(page, /withoutItemTranslation\(it\)/);
  assert.match(page, /itemHasTranslation\(item\)/);
  assert.match(page, /Description changed since this translation/);
  assert.match(page, /data-testid="item-translation-box"/);
  assert.match(page, /data-testid="clear-item-translation"/);
  assert.match(page, /Internal team use only — not sent to client/);
  assert.doesNotMatch(page, /itemTranslations/);
  assert.match(page, /stripItemTranslations\(\(items \|\| \[\]\)\.slice\(0, 40\)\)/);
});

test('print / PDF preview and client preview render description only, never translation', () => {
  const page = src('app/page.tsx');
  const previewBlocks = [...page.matchAll(/id="preview-document"[\s\S]*?<\/table>/g)];
  // There is one print/PDF preview; a second table may use the same item.description pattern.
  const tables = [...page.matchAll(/<span className="text-xs text-gray-500">Line \{i \+ 1\}: <\/span>\{item\.description\}/g)];
  assert.ok(tables.length >= 2, 'expected both editor preview and print preview to show description');
  assert.doesNotMatch(page, /item\.translation/);
  assert.match(page, /id="preview-document"/);
});

test('client document API and send-email API strip translation fields', () => {
  const documentApi = src('app/api/client/document/route.ts');
  assert.match(documentApi, /stripItemTranslations\(items\)/);
  assert.match(documentApi, /ITEM_TRANSLATION_KEYS/);
  assert.match(documentApi, /never forward internal translation fields/);
  assert.doesNotMatch(documentApi, /translation:/);

  const sendApi = src('app/api/documents/send/route.ts');
  assert.match(sendApi, /stripItemTranslations\(Array\.isArray\(body\.items\) \? body\.items : \[\]\)/);
  // Email HTML/plain text uses description, not translation.
  assert.match(sendApi, /it\.description \|\| 'Line item'/);
  assert.doesNotMatch(sendApi, /it\.translation/);
});

test('crew data redaction keeps translation fields (not treated as money)', () => {
  const redaction = src('lib/crew-redaction.ts');
  assert.match(redaction, /translation, translationLang, translatedAt, and translationSource intact/);
  for (const key of T.ITEM_TRANSLATION_KEYS) {
    assert.equal(R.isMoneyKey(key), false, key);
  }
  const masked = R.maskMoneyDeep({
    description: 'Boards',
    price: 12.5,
    translation: 'Tablones',
    translationLang: 'es',
    translatedAt: '2026-11-20T16:00:00.000Z',
    translationSource: 'Boards',
  });
  assert.equal(masked.price, 0);
  assert.equal(masked.translation, 'Tablones');
  assert.equal(masked.translationLang, 'es');
  assert.equal(masked.translationSource, 'Boards');
});
