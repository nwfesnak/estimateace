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

export function sayGatherTwiml(opts: {
  say: string;
  gatherActionUrl: string;
  language?: string;
}) {
  const say = escapeXml(opts.say.slice(0, 500));
  const action = escapeXml(opts.gatherActionUrl);
  // Nested Say inside Gather plays prompt then listens
  return twimlResponse(`  <Gather input="speech" speechTimeout="auto" timeout="4" action="${action}" method="POST" enhanced="true" speechModel="phone_call" language="${escapeXml(opts.language || 'en-US')}">
    <Say voice="Polly.Joanna">${say}</Say>
  </Gather>
  <Say voice="Polly.Joanna">Sorry, I did not catch that.</Say>
  <Redirect method="POST">${action}</Redirect>`);
}

export function sayHangupTwiml(say: string) {
  return twimlResponse(
    `  <Say voice="Polly.Joanna">${escapeXml(say.slice(0, 500))}</Say>\n  <Hangup/>`
  );
}

export function transferTwiml(opts: { say: string; transferTo: string; callerId?: string }) {
  const to = escapeXml(opts.transferTo);
  const say = escapeXml(opts.say.slice(0, 300));
  const callerId = opts.callerId ? ` callerId="${escapeXml(opts.callerId)}"` : '';
  return twimlResponse(
    `  <Say voice="Polly.Joanna">${say}</Say>\n  <Dial${callerId}>${to}</Dial>`
  );
}
