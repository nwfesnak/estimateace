/**
 * Pure helpers for AI receptionist spam / silent-call handling.
 * No app imports so they can be unit tested with `node --test`.
 */

export type CallTurnLike = { role: 'agent' | 'caller'; text: string };

/** Fewer caller words than this = silent / empty call → no lead, no notification. */
export const MIN_CALLER_WORDS = 3;

/** Normalize to a +E.164-ish key so "(704) 555-0100" and "+17045550100" match. */
export function normalizeBlockPhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/** Caller speech only, without keypad events like "Pressed 1". */
export function callerSpeech(turns: CallTurnLike[]): string {
  return (turns || [])
    .filter((t) => t && t.role === 'caller')
    .map((t) => String(t.text || '').trim())
    .filter((t) => t && !/^Pressed [0-9*#]+$/i.test(t))
    .join(' ')
    .trim();
}

export function countCallerWords(turns: CallTurnLike[]): number {
  const text = callerSpeech(turns);
  if (!text) return 0;
  return text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;
}

export function isSilentCall(turns: CallTurnLike[], minWords = MIN_CALLER_WORDS): boolean {
  return countCallerWords(turns) < minWords;
}

const SPAM_PATTERNS: { re: RegExp; category: 'robocall' | 'sales' | 'scam'; reason: string }[] = [
  { re: /\b(google|business) (listing|profile)\b|\bgoogle maps\b.*\b(verify|listing)\b/i, category: 'sales', reason: 'Google listing / verification pitch' },
  { re: /\b(merchant services|credit card processing rates?|business (loan|funding|line of credit)|working capital|cash advance)\b/i, category: 'sales', reason: 'Business funding / merchant services pitch' },
  { re: /\b(seo|search engine optimization|rank (you|your business)|more leads for your business|marketing agency|web ?design services)\b/i, category: 'sales', reason: 'Marketing / SEO sales call' },
  { re: /\b(extended|vehicle|car|auto) warranty\b/i, category: 'robocall', reason: 'Warranty robocall' },
  { re: /\b(this is (an? )?(automated|recorded) (message|call)|press (one|1|nine|9) to (speak|be removed|opt out)|to be removed from (our|this) list)\b/i, category: 'robocall', reason: 'Automated / recorded robocall' },
  { re: /\b(social security (number|administration)|irs|arrest warrant|gift cards?|your account (has been|will be) (suspended|locked))\b/i, category: 'scam', reason: 'Scam pattern (government / account threat)' },
  { re: /\b(health insurance|medicare|final expense|student loan forgiveness|lower your (interest )?rate)\b/i, category: 'robocall', reason: 'Insurance / loan robocall' },
];

/** Cheap keyword screen; used as a backstop when the AI classifier is unavailable. */
export function detectSpamHeuristic(turns: CallTurnLike[]): {
  isSpam: boolean;
  category: '' | 'robocall' | 'sales' | 'scam';
  reason: string;
} {
  const text = callerSpeech(turns);
  for (const p of SPAM_PATTERNS) {
    if (p.re.test(text)) return { isSpam: true, category: p.category, reason: p.reason };
  }
  return { isSpam: false, category: '', reason: '' };
}
