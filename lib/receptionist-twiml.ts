/** Small TwiML helpers for AI receptionist voice. */

export function escapeXml(s: string) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}


/** Format a phone so Twilio <Say> reads digits, not "nine million…". */
export function formatPhoneForSpeech(phone: string): string {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return 'this number';
  // US/CA: drop leading country 1 for speaking, keep last 10
  let d = digits;
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length > 10) d = d.slice(-10);
  // Spaces force digit-by-digit TTS ("nine eight zero…")
  const parts: string[] = [];
  if (d.length === 10) {
    parts.push(d.slice(0, 3).split('').join(' '));
    parts.push(d.slice(3, 6).split('').join(' '));
    parts.push(d.slice(6).split('').join(' '));
    return parts.join(', ');
  }
  return d.split('').join(' ');
}

export function twimlResponse(inner: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${inner}\n</Response>`;
}

/** Prefer relative webhook paths — Twilio resolves them against the current call webhook host. */
export const VOICE_GATHER_PATH = '/api/webhooks/twilio/voice/gather';
export const VOICE_THINK_PATH = '/api/webhooks/twilio/voice/think';

/**
 * Speak a prompt, then listen for speech.
 * Keep attributes conservative — invalid Gather attrs cause Twilio "application error".
 * input MUST be exactly: dtmf | speech | "dtmf speech" (not "speech dtmf").
 */
export function sayGatherTwiml(opts: {
  say: string;
  gatherActionUrl?: string;
  language?: string;
  hints?: string;
}) {
  const say = escapeXml(String(opts.say || 'How can I help you?').slice(0, 400));
  const action = escapeXml(opts.gatherActionUrl || VOICE_GATHER_PATH);
  const lang = escapeXml(opts.language || 'en-US');
  const hints = escapeXml(
    opts.hints ||
      'yes, no, estimate, quote, appointment, schedule, price, service, address, name, phone, callback, transfer'
  );

  return twimlResponse(
    [
      `  <Gather input="dtmf speech" language="${lang}" timeout="8" speechTimeout="3" action="${action}" method="POST" actionOnEmptyResult="true" hints="${hints}">`,
      `    <Say voice="alice">${say}</Say>`,
      `  </Gather>`,
      `  <Say voice="alice">Sorry, I did not catch that.</Say>`,
      `  <Redirect method="POST">${action}</Redirect>`,
    ].join('\n')
  );
}

export function sayThenRedirectTwiml(opts: { say: string; redirectUrl: string }) {
  return twimlResponse(
    [
      `  <Say voice="alice">${escapeXml(String(opts.say || '').slice(0, 200))}</Say>`,
      `  <Redirect method="POST">${escapeXml(opts.redirectUrl)}</Redirect>`,
    ].join('\n')
  );
}

export function sayHangupTwiml(say: string) {
  return twimlResponse(
    `  <Say voice="alice">${escapeXml(String(say || 'Goodbye.').slice(0, 400))}</Say>\n  <Hangup/>`
  );
}

export function transferTwiml(opts: {
  say?: string;
  transferTo: string;
  callerId?: string;
  silent?: boolean;
  timeoutSec?: number;
}) {
  const to = escapeXml(opts.transferTo);
  const callerId = opts.callerId ? ` callerId="${escapeXml(opts.callerId)}"` : '';
  const timeout = Math.min(60, Math.max(10, Number(opts.timeoutSec) || 30));
  const dial = `  <Dial${callerId} timeout="${timeout}">${to}</Dial>`;
  if (opts.silent || !opts.say) {
    return twimlResponse(dial);
  }
  const say = escapeXml(opts.say.slice(0, 300));
  return twimlResponse(`  <Say voice="alice">${say}</Say>\n${dial}`);
}

export function twimlXmlResponse(twiml: string) {
  return new Response(twiml, {
    status: 200,
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
