/** Small TwiML helpers for AI receptionist voice. */

export function escapeXml(s: string) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function twimlResponse(inner: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${inner}\n</Response>`;
}

/**
 * Speak a prompt, then listen for speech.
 * Tuned for phone calls: longer listen window, always POST back (even if silent).
 */
export function sayGatherTwiml(opts: {
  say: string;
  gatherActionUrl: string;
  language?: string;
  /** Extra recognition hints (comma-separated phrases) */
  hints?: string;
}) {
  const say = escapeXml(opts.say.slice(0, 500));
  const action = escapeXml(opts.gatherActionUrl);
  const lang = escapeXml(opts.language || 'en-US');
  const hints = escapeXml(
    opts.hints ||
      'yes, no, estimate, quote, appointment, schedule, price, pricing, service, address, name, phone, callback, transfer, speak to someone, human, owner'
  );

  // speechTimeout = silence after caller stops talking (seconds)
  // timeout = max wait for them to start speaking
  // actionOnEmptyResult = always hit action URL so we can re-prompt
  // phone_call + enhanced = most reliable on Twilio voice
  return twimlResponse(`  <Gather input="speech dtmf" language="${lang}" speechTimeout="auto" timeout="10" action="${action}" method="POST" actionOnEmptyResult="true" enhanced="true" speechModel="phone_call" hints="${hints}" bargeIn="true" numDigits="1">
    <Say voice="Polly.Joanna">${say}</Say>
    <Pause length="1"/>
  </Gather>
  <Say voice="Polly.Joanna">I am still here. Please say that again.</Say>
  <Redirect method="POST">${action}</Redirect>`);
}

export function sayThenRedirectTwiml(opts: { say: string; redirectUrl: string }) {
  return twimlResponse(
    `  <Say voice="Polly.Joanna">${escapeXml(opts.say.slice(0, 300))}</Say>\n  <Redirect method="POST">${escapeXml(opts.redirectUrl)}</Redirect>`
  );
}

export function sayHangupTwiml(say: string) {
  return twimlResponse(
    `  <Say voice="Polly.Joanna">${escapeXml(say.slice(0, 500))}</Say>\n  <Hangup/>`
  );
}

export function transferTwiml(opts: {
  say?: string;
  transferTo: string;
  callerId?: string;
  /** Silent connect — no prompt (used when AI is Off) */
  silent?: boolean;
  timeoutSec?: number;
}) {
  const to = escapeXml(opts.transferTo);
  const callerId = opts.callerId ? ` callerId="${escapeXml(opts.callerId)}"` : '';
  const timeout = Math.min(60, Math.max(10, Number(opts.timeoutSec) || 30));
  const dial = `  <Dial${callerId} timeout="${timeout}" answerOnBridge="true">${to}</Dial>`;
  if (opts.silent || !opts.say) {
    return twimlResponse(dial);
  }
  const say = escapeXml(opts.say.slice(0, 300));
  return twimlResponse(`  <Say voice="Polly.Joanna">${say}</Say>\n${dial}`);
}
