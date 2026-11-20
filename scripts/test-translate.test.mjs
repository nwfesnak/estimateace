// Run: npm run test:translate — estimate line-item translation (grok-4.6 reasoning, errors, UI wiring).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const cfg = await jiti.import(path.join(root, 'lib/xai-config.ts'));
const chat = await jiti.import(path.join(root, 'lib/xai-chat.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

test('grok-4.x uses low reasoning; other models omit the field', () => {
  assert.equal(cfg.reasoningEffortFor('grok-4.6'), 'low');
  assert.equal(cfg.reasoningEffortFor('grok-4.5'), 'low');
  assert.equal(cfg.reasoningEffortFor('GROK-4.6'), 'low');
  assert.equal(cfg.reasoningEffortFor('grok-3'), null);
  assert.equal(cfg.reasoningEffortFor(''), null);
  const body = chat.buildXaiChatBody({
    model: 'grok-4.6',
    systemPrompt: 'sys',
    userContent: 'Paint the trim.',
    maxTokens: 4000,
  });
  assert.equal(body.model, 'grok-4.6');
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.max_tokens, 4000);
  const other = chat.buildXaiChatBody({
    model: 'grok-3',
    systemPrompt: 'sys',
    userContent: 'hi',
    maxTokens: 100,
  });
  assert.equal('reasoning_effort' in other, false);
});

test('extractChatText and empty-content errors', () => {
  assert.deepEqual(chat.extractChatText({ choices: [{ message: { content: '  Hola  ' }, finish_reason: 'stop' }] }), {
    text: 'Hola',
    finish: 'stop',
  });
  assert.equal(chat.extractChatText({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }).text, '');
  assert.match(chat.translationFromEmptyContent('length'), /cut off/i);
  assert.match(chat.translationFromEmptyContent('stop'), /try again/i);
});

test('client failure messages: timeout, 401, empty body, generic', () => {
  assert.match(chat.translateFailureMessage({ err: Object.assign(new Error('aborted'), { name: 'TimeoutError' }) }), /timed out/i);
  assert.match(chat.translateFailureMessage({ ok: false, status: 401, data: { error: 'Unauthorized' } }), /sign in/i);
  assert.match(chat.translateFailureMessage({ ok: false, status: 504, data: { error: 'Translation timed out. Please try again.' } }), /timed out/i);
  assert.match(chat.translateFailureMessage({ ok: false, status: 500, data: { error: 'Could not generate a translation. Please try again.' } }), /Could not generate/);
  assert.match(chat.translateFailureMessage({ ok: true, status: 200, data: { translatedText: '   ' } }), /No translation came back/);
  assert.equal(chat.translateFailureMessage({ ok: true, status: 200, data: { translatedText: 'Hola' } }), '');
  assert.ok(!/GROK_API_KEY/.test(chat.translateFailureMessage({ ok: false, status: 500, data: { error: 'Translation failed. Please try again.' } })));
});

test('translate route sends reasoning_effort, times out, and logs without the source text', () => {
  const route = src('app/api/translate/route.ts');
  assert.match(route, /export const maxDuration = 60/);
  assert.match(route, /AbortSignal\.timeout\(TRANSLATE_AI_TIMEOUT_MS\)/);
  assert.match(route, /buildXaiChatBody\(/);
  assert.match(route, /translationFromEmptyContent\(result\.finish\)/);
  assert.match(route, /status: timeout \? 504 : 500/);
  assert.match(route, /console\.info\(\s*'translate:'/);
  const logBlock = route.slice(route.indexOf("console.info"), route.indexOf('return extracted'));
  assert.match(logBlock, /reasoningTokens/);
  assert.doesNotMatch(logBlock, /userContent|systemPrompt|body\.text/);
});

test('photo-estimate shares reasoningEffortFor; estimate page has loading + error state', () => {
  const photo = src('app/api/photo-estimate/route.ts');
  assert.match(photo, /reasoningEffortFor/);
  assert.doesNotMatch(photo, /function reasoningEffortFor/);
  const page = src('app/page.tsx');
  assert.match(page, /translatingItemId === item\.id \? '⏳ Translating\.\.\.' : '🔄 Translate'/);
  assert.match(page, /data-testid="translate-error"/);
  assert.match(page, /type="button"/);
  assert.match(page, /AbortSignal\.timeout\(30000\)/);
  assert.match(page, /translateFailureMessage/);
  assert.doesNotMatch(page, /GROK_API_KEY required/);
});
