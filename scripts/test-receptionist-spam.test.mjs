// Run: npm run test:receptionist   (Node 22.18+/24 strips TypeScript types natively)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTwilioSignature,
  validateTwilioSignature,
  validateTwilioAgainstCandidates,
  twilioCandidateUrls,
} from '../lib/twilio-signature.ts';
import {
  callerSpeech,
  countCallerWords,
  detectSpamHeuristic,
  isSilentCall,
  normalizeBlockPhone,
} from '../lib/receptionist-spam.ts';

// Vectors produced by twilio@5 getExpectedTwilioSignature / validateRequest.
const DOC_URL = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const DOC_PARAMS = {
  CallSid: 'CA1234567890ABCDE',
  Caller: '+12349013030',
  Digits: '1234',
  From: '+12349013030',
  To: '+18005551212',
};

test('signature matches Twilio (HMAC-SHA1) published example', () => {
  assert.equal(computeTwilioSignature('12345', DOC_URL, DOC_PARAMS), '0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  assert.equal(
    validateTwilioSignature({ authToken: '12345', signature: '0/KCTR6DLpKmkAf8muzZqo1nDgQ=', url: DOC_URL, params: DOC_PARAMS }),
    true
  );
});

test('signature rejects tampered params, wrong token, missing header', () => {
  const sig = '0/KCTR6DLpKmkAf8muzZqo1nDgQ=';
  assert.equal(validateTwilioSignature({ authToken: '12345', signature: sig, url: DOC_URL, params: { ...DOC_PARAMS, Digits: '9' } }), false);
  assert.equal(validateTwilioSignature({ authToken: 'nope', signature: sig, url: DOC_URL, params: DOC_PARAMS }), false);
  assert.equal(validateTwilioSignature({ authToken: '12345', signature: null, url: DOC_URL, params: DOC_PARAMS }), false);
});

test('subaccount token + query string URL (think redirect) validates against candidates', () => {
  const url = 'https://app.estimateace.com/api/webhooks/twilio/voice/think?CallSid=CA0123456789abcdef0123456789abcdef';
  const params = {
    AccountSid: 'AC00000000000000000000000000000000',
    CallSid: 'CA0123456789abcdef0123456789abcdef',
    From: '+17045550100',
    To: '+19805550199',
    CallStatus: 'in-progress',
  };
  const sig = '9IAsSY4+Q4gvjKtnCkY0esFuzgw=';
  // Function sees an internal URL behind Vercel; forwarded headers rebuild the public one.
  const req = new Request(
    'http://localhost:3000/api/webhooks/twilio/voice/think?CallSid=CA0123456789abcdef0123456789abcdef',
    { method: 'POST', headers: { 'x-forwarded-host': 'app.estimateace.com', 'x-forwarded-proto': 'https' } }
  );
  const urls = twilioCandidateUrls(req);
  assert.ok(urls.includes(url));
  assert.equal(validateTwilioAgainstCandidates({ tokens: ['master_x', 'subtoken_abc'], urls, signature: sig, params }), true);
  assert.equal(validateTwilioAgainstCandidates({ tokens: ['master_x'], urls, signature: sig, params }), false);
});

test('silent / near-silent calls are detected', () => {
  assert.equal(countCallerWords([{ role: 'agent', text: 'Thanks for calling. What are you calling about?' }]), 0);
  assert.equal(isSilentCall([]), true);
  assert.equal(isSilentCall([{ role: 'caller', text: 'Pressed 1' }, { role: 'caller', text: 'hello' }]), true);
  assert.equal(isSilentCall([{ role: 'caller', text: 'I need a quote for a roof leak' }]), false);
  assert.equal(callerSpeech([{ role: 'caller', text: 'Pressed 0' }, { role: 'caller', text: 'yes' }]), 'yes');
});

test('keyword spam backstop', () => {
  assert.equal(detectSpamHeuristic([{ role: 'caller', text: 'Hi, this is about your Google business listing, we need to verify it' }]).isSpam, true);
  assert.equal(detectSpamHeuristic([{ role: 'caller', text: 'This is a recorded message about your extended warranty' }]).category, 'robocall');
  assert.equal(detectSpamHeuristic([{ role: 'caller', text: 'Water is coming through my ceiling, I need someone today. Insurance claim is open.' }]).isSpam, false);
});

test('blocklist phone normalization', () => {
  assert.equal(normalizeBlockPhone('(704) 555-0100'), '+17045550100');
  assert.equal(normalizeBlockPhone('+1 704 555 0100'), '+17045550100');
  assert.equal(normalizeBlockPhone('17045550100'), '+17045550100');
  assert.equal(normalizeBlockPhone(''), '');
});
