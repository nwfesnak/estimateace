/**
 * Staged voice receptionist for Twilio Gather speech loops.
 * Deterministic stage machine (need → name → phone → anything_else → techs_sms → thanks).
 * Reliability of ORDER matters more than free-form LLM replies.
 */
import { getXaiApiKey, getXaiChatModel } from '@/lib/xai-config';
import { formatPhoneForSpeech } from '@/lib/receptionist-twiml';
import {
  transcriptToText,
  type CallStage,
  type CallTurn,
} from '@/lib/receptionist-call-session';
import {
  fetchWebsiteKnowledgeText,
  warmWebsiteTextCache,
} from '@/lib/receptionist-website-kb';

export type VoiceAgentAction = 'continue' | 'transfer' | 'end';

export type VoiceAgentLead = {
  name?: string;
  phone?: string;
  address?: string;
  notes?: string;
  /** What service / job they want */
  jobType?: string;
  preferredTime?: string;
  urgent?: boolean;
};

export type VoiceAgentResult = {
  say: string;
  action: VoiceAgentAction;
  lead?: VoiceAgentLead | null;
  callStage?: CallStage;
  smsOk?: boolean;
  /** Scraped website text to stash on the call session */
  websiteText?: string;
};

const MAX_SAY = 420;

const NAME_STOP = new Set(
  'yes yeah yep yup no nope ok okay hi hello hey thanks thank you please calling looking need needs wanted want help hiya um uh so well my the a an it is this that'.split(
    ' '
  )
);

function titleCaseName(s: string): string {
  return String(s || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .slice(0, 120);
}

/** True if utterance is plausibly just a person name (Twilio STT is often lowercase). */
export function looksLikePersonName(text: string): boolean {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw || raw.length > 60) return false;
  if (/\d/.test(raw)) return false;
  if (/[@#/\\]|https?:/i.test(raw)) return false;
  const words = raw.replace(/[.,!?']/g, '').split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 4) return false;
  if (words.every((w) => NAME_STOP.has(w.toLowerCase()))) return false;
  if (
    /\b(pressure\s*wash|roof|paint|plumb|hvac|estimate|quote|address|street|avenue|phone|number|call me)\b/i.test(
      raw
    )
  ) {
    return false;
  }
  return words.every((w) => /^[A-Za-z][A-Za-z'-]*$/.test(w));
}

/** Pull contact + job hints from messy speech-to-text. */
export function extractLeadHintsFromSpeech(
  text: string,
  aniPhone = '',
  opts?: { expectName?: boolean; expectPhone?: boolean; expectAddress?: boolean }
): VoiceAgentLead {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return {};

  const lead: VoiceAgentLead = {};
  const expectName = Boolean(opts?.expectName);

  const phoneMatch = raw.match(
    /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/
  );
  if (phoneMatch) {
    lead.phone = phoneMatch[0].replace(/[^\d+]/g, '');
  } else if (
    aniPhone &&
    /\b(yes|yeah|yep|yup|correct|that's (me|right|fine)|that is|this (number|one)|calling from)\b/i.test(
      raw
    )
  ) {
    lead.phone = aniPhone;
  }

  const namePatterns = [
    /(?:my name is|my name's|name is|this is|i am|i'm|it's|it is)\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3})/i,
    /(?:name'?s)\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3})/i,
  ];
  for (const re of namePatterns) {
    const m = raw.match(re);
    if (m?.[1]) {
      const n = titleCaseName(m[1]);
      if (n && !NAME_STOP.has(n.toLowerCase())) {
        lead.name = n;
        break;
      }
    }
  }

  if (!lead.name && (expectName || looksLikePersonName(raw))) {
    if (looksLikePersonName(raw) || expectName) {
      const cleaned = raw.replace(/[.,!?]/g, '').trim();
      const words = cleaned.split(/\s+/).filter(Boolean);
      const okExpect =
        expectName &&
        words.length >= 1 &&
        words.length <= 4 &&
        words.every((w) => /^[A-Za-z][A-Za-z'-]*$/.test(w)) &&
        !words.every((w) => NAME_STOP.has(w.toLowerCase()));
      if (looksLikePersonName(raw) || okExpect) {
        lead.name = titleCaseName(cleaned);
      }
    }
  }

  const addr = raw.match(
    /\b(\d{1,6}\s+[A-Za-z0-9 .'-]{3,40}\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|way|circle|cir|hwy|highway)\.?(?:\s*,?\s*[A-Za-z .']+)?)(?:\b|$)/i
  );
  if (addr) {
    lead.address = addr[1].replace(/\s+/g, ' ').trim();
  } else if (opts?.expectAddress) {
    if (raw.length >= 5 && raw.length <= 120 && !looksLikePersonName(raw)) {
      lead.address = raw;
    }
  } else {
    const city = raw.match(
      /\b(?:in|at|near|around)\s+([A-Za-z][A-Za-z]+(?:\s+[A-Za-z][A-Za-z]+){0,2})\b/i
    );
    if (city && !lead.address) lead.address = titleCaseName(city[1]);
  }

  const jobBits: string[] = [];
  const jobRe =
    /\b(pressure\s*wash(?:ing|ed)?|roof(?:ing)?|paint(?:ing)?|plumb(?:ing|er)?|hvac|ac|air\s*condition(?:ing|er)?|electric(?:al|ian)?|landscap(?:e|ing)|lawn|mow(?:ing)?|fence|concrete|driveway|sidewalk|gutters?|windows?|clean(?:ing)?|repair|install|estimate|quote|remodel|leak|flood)\b/gi;
  let jm: RegExpExecArray | null;
  while ((jm = jobRe.exec(raw))) {
    jobBits.push(jm[1].toLowerCase());
  }
  if (!lead.name || jobBits.length || raw.length > 20) {
    if (jobBits.length) {
      const normalized = [...new Set(jobBits)].map((b) =>
        /^pressure\s*washed$/i.test(b) ? 'pressure washing' : b
      );
      // Prefer longer / more specific phrases first for recap
      normalized.sort((a, b) => b.length - a.length);
      lead.jobType = normalized.join(', ');
      lead.notes = raw.slice(0, 500);
    } else if (raw.length > 12 && !looksLikePersonName(raw) && !expectName) {
      lead.notes = raw.slice(0, 500);
    }
  }

  if (/\b(emergency|urgent|asap|right away|flooding|no heat|no ac|leak)\b/i.test(raw)) {
    lead.urgent = true;
  }

  const when = raw.match(
    /\b((?:today|tomorrow|this (?:week|weekend|morning|afternoon|evening)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week)(?:\s+(?:morning|afternoon|evening|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?)/i
  );
  if (when) lead.preferredTime = when[1];

  return lead;
}

function mergeLead(
  base: VoiceAgentLead,
  extra: VoiceAgentLead,
  prior: VoiceAgentLead
): VoiceAgentLead {
  const pick = (a?: string, b?: string, c?: string) =>
    String(a || b || c || '').trim();
  return {
    name: pick(extra.name, base.name, prior.name),
    phone: pick(extra.phone, base.phone, prior.phone),
    address: pick(extra.address, base.address, prior.address),
    notes: pick(extra.notes, base.notes, prior.notes),
    jobType: pick(extra.jobType, base.jobType, prior.jobType),
    preferredTime: pick(extra.preferredTime, base.preferredTime, prior.preferredTime),
    urgent: Boolean(extra.urgent || base.urgent || prior.urgent),
  };
}

function firstName(name?: string): string {
  return String(name || '')
    .trim()
    .split(/\s+/)[0] || '';
}

function cleanNeedPhrase(s: string): string {
  return String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(i need|i want|i'?m (calling|looking) (for|about)|need|want)\s+/i, '')
    .trim();
}

/** Short single-segment reason (first job / first note). */
function shortReason(lead: VoiceAgentLead): string {
  return fullReason(lead, 80);
}

/**
 * Full accumulated need for recap — all job types and | -joined note extras.
 * Keeps under maxChars for TTS; summarizes as "X, and also Y" when long.
 */
export function fullReason(lead: VoiceAgentLead, maxChars = 120): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const c = cleanNeedPhrase(raw);
    if (!c || c === 'that') return;
    const key = c.toLowerCase();
    if (seen.has(key)) return;
    // Skip near-duplicates
    for (const k of seen) {
      if (k.includes(key) || key.includes(k)) return;
    }
    seen.add(key);
    parts.push(c);
  };

  const jt = String(lead.jobType || '').trim();
  if (jt) {
    for (const bit of jt.split(/[,|]/).map((s) => s.trim()).filter(Boolean)) {
      push(bit);
    }
  }

  const notes = String(lead.notes || '').trim().replace(/\s+/g, ' ');
  if (notes) {
    for (const seg of notes.split(' | ').map((s) => s.trim()).filter(Boolean)) {
      // Prefer compact job-like segments; skip huge dumps
      const cleaned = cleanNeedPhrase(seg);
      if (!cleaned) continue;
      if (cleaned.length > 90) {
        push(cleaned.slice(0, 87) + '...');
      } else {
        push(cleaned);
      }
    }
  }

  if (!parts.length) return 'that';

  let out = parts[0];
  if (parts.length === 1) {
    return out.length <= maxChars ? out : `${out.slice(0, maxChars - 3)}...`;
  }

  // "X, and also Y" (or X, Y, and also Z condensed)
  if (parts.length === 2) {
    out = `${parts[0]}, and also ${parts[1]}`;
  } else {
    const rest = parts.slice(1);
    const restJoined = rest.length <= 2 ? rest.join(' and ') : `${rest[0]} and more`;
    out = `${parts[0]}, and also ${restJoined}`;
  }
  if (out.length <= maxChars) return out;
  // Tighten: first + last
  const tight = `${parts[0]}, and also ${parts[parts.length - 1]}`;
  if (tight.length <= maxChars) return tight;
  return `${tight.slice(0, maxChars - 3)}...`;
}

function isSubstantiveNeed(text: string, hints: VoiceAgentLead): boolean {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return false;
  if (hints.notes || hints.jobType) return true;
  // Any non-empty utterance that isn't pure filler
  if (raw.length >= 3 && !/^(um+|uh+|hm+|hello|hi|hey|thanks|thank you)\.?$/i.test(raw)) {
    return true;
  }
  return false;
}

function isClearNo(text: string): boolean {
  return /\b(no|nope|nah|nothing|not really|that's all|that is all|i'm good|im good|no thanks)\b/i.test(
    text || ''
  );
}

/** Parse yes/no for SMS consent. Unclear → true (opt-in bias for callback texts). */
function parseSmsOk(text: string): boolean {
  const raw = String(text || '');
  if (/\b(no|nope|nah|don't|do not|negative|prefer not|no text|no sms)\b/i.test(raw)) {
    return false;
  }
  if (/\b(yes|yeah|yep|yup|sure|ok|okay|fine|absolutely|please|go ahead|sounds good)\b/i.test(raw)) {
    return true;
  }
  // Default: treat any other reply as okay with texts so we don't stall
  return true;
}

function wantsHuman(text: string): boolean {
  return /\b(operator|human|real person|press 0|transfer|speak to (someone|a person|rep))\b/i.test(
    text || ''
  );
}

function appendNotes(existing: string, extra: string): string {
  const prev = String(existing || '').trim();
  const add = String(extra || '').trim();
  if (!add) return prev;
  if (!prev) return add.slice(0, 1500);
  if (prev.includes(add)) return prev.slice(0, 1500);
  return `${prev} | ${add}`.slice(0, 1500);
}

/** Detect caller questions (FAQ / website Q&A path). */
export function isCallerQuestion(text: string): boolean {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return false;
  if (raw.includes('?')) return true;
  // Strong openers
  if (
    /^(how|what|when|where|why|who|do|does|are|can|could|is|will|would)\b/i.test(raw)
  ) {
    return true;
  }
  // Clear question phrases (avoid bare "price"/"when" so job descriptions stay on-script)
  return /\b(how much|how long|how (?:do|does|can|are|is)|what(?:'s| is| are)|when(?:'s| is| are)|where(?:'s| is| are)|why(?:'s| is| are)|who(?:'s| is| are)|do you|are you|can you|could you|will you|would you|is there|are there|what are your|what is your|are you (?:open|closed)|what(?:'s| is) your (?:hours|price|pricing|rate)|service area|do you (?:guys )?(?:cover|serve)|are you (?:insured|licensed))\b/i.test(
    raw
  );
}

function stageBridgePrompt(stage: CallStage, lead: VoiceAgentLead, company: string): string {
  const first = firstName(lead.name);
  const hi = first ? `${first}, ` : '';
  const reason = fullReason(lead);
  switch (stage) {
    case 'need':
      return 'What are you calling about today?';
    case 'name':
      return 'Who am I speaking with?';
    case 'phone':
      return `${hi}is this the best number to call you back on?`.replace(/^, /, '');
    case 'anything_else':
      return `So I've got ${reason}. Anything else you'd like to add, or anything else we can help with today?`;
    case 'techs_sms':
      return `All of our technicians are helping other customers right now, so we'll call you back as soon as we can. Are you okay with us texting you as well?`;
    case 'thanks':
      return `Thanks so much for calling ${company}. We'll be in contact with you as soon as possible. Goodbye!`;
    default:
      return 'How can I help you?';
  }
}

function keywordFaqAnswer(question: string, knowledgeBase: string): string | null {
  const kb = String(knowledgeBase || '').trim();
  if (!kb) return null;
  const q = question.toLowerCase();
  const qWords = q
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !['the', 'and', 'you', 'for', 'are', 'can', 'how', 'what', 'when', 'where', 'does', 'about', 'your', 'with'].includes(w));
  const lines = kb
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 8);
  let best: { line: string; score: number } | null = null;
  for (const line of lines) {
    const ll = line.toLowerCase();
    let score = 0;
    for (const w of qWords) {
      if (ll.includes(w)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { line, score };
    }
  }
  if (!best || best.score < 1) return null;
  // Strip leading "Q:" / "A:" labels
  let say = best.line.replace(/^(q|a|faq)\s*[:.\-]\s*/i, '').trim();
  // If line looks like "question — answer", take after dash
  const dash = say.split(/\s+[—–-]\s+/);
  if (dash.length >= 2 && dash[1].length > 10) say = dash.slice(1).join(' — ');
  const colon = say.match(/^[^?]{0,80}\?\s*(.+)$/);
  if (colon?.[1] && colon[1].length > 10) say = colon[1].trim();
  return say.slice(0, 220);
}

async function answerCallerQuestion(input: {
  question: string;
  knowledgeBase: string;
  websiteText: string;
  businessName: string;
}): Promise<{ say: string; answered: boolean }> {
  const soft =
    "I don't have that detail handy, but the team can confirm when they call you back.";
  const faq = String(input.knowledgeBase || '').trim().slice(0, 6000);
  const web = String(input.websiteText || '').trim().slice(0, 6000);
  if (!faq && !web) {
    return { say: soft, answered: false };
  }

  const apiKey = getXaiApiKey();
  if (apiKey) {
    try {
      const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(4500),
        body: JSON.stringify({
          model: getXaiChatModel(),
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content: `You are a warm, casual phone receptionist for ${input.businessName || 'a local contractor'}.
Answer ONLY from the provided Business FAQs and Website excerpt. Do NOT invent prices, policies, hours, or coverage.
If the answer is not clearly in the sources, set answered=false and give a brief soft deferral.
Return ONLY JSON: {"say":"...","answered":true|false}
"say" must be under 220 characters, spoken TTS-friendly, no markdown.`,
            },
            {
              role: 'user',
              content: `Caller question: ${input.question}

Business FAQs:
${faq || '(none)'}

Website excerpt:
${web || '(none)'}`,
            },
          ],
        }),
      });
      const json = await res.json().catch(() => ({}));
      const parsed = parseAgentJson(String(json.choices?.[0]?.message?.content || '')) as {
        say?: string;
        answered?: boolean;
      } | null;
      if (parsed && typeof parsed.say === 'string' && parsed.say.trim()) {
        return {
          say: String(parsed.say).trim().slice(0, 220),
          answered: parsed.answered !== false,
        };
      }
    } catch {
      /* fall through */
    }
  }

  const fromFaq = keywordFaqAnswer(input.question, faq);
  if (fromFaq) return { say: fromFaq, answered: true };

  // Crude website keyword hit: pick a sentence containing a query word
  if (web) {
    const qWords = input.question
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3);
    const sentences = web.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 20 && s.length < 200);
    for (const w of qWords) {
      const hit = sentences.find((s) => s.toLowerCase().includes(w));
      if (hit) return { say: hit.slice(0, 220), answered: true };
    }
  }

  return { say: soft, answered: false };
}

function isRealAnythingElseAdd(text: string, hints: VoiceAgentLead): boolean {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw || isClearNo(raw)) return false;
  if (hints.jobType || hints.address || hints.preferredTime || hints.urgent) return true;
  if (hints.notes && hints.notes.length >= 8) return true;
  // Substantive utterance that isn't pure filler / affirmation
  if (
    /\b(yes|yeah|yep|yup|sure|ok|okay|please|thanks|thank you|um+|uh+|hmm+)\b/i.test(raw) &&
    raw.length < 16
  ) {
    return false;
  }
  return isSubstantiveNeed(raw, hints) && raw.length >= 8;
}

/**
 * Deterministic staged turn. Skips free-form Grok so script ORDER stays reliable.
 */
export async function runReceptionistVoiceTurn(input: {
  businessName: string;
  knowledgeBase: string;
  websiteUrl?: string;
  websiteText?: string;
  greetingStyle?: string;
  languages?: string[];
  urgentKeywords?: string;
  callerPhone: string;
  transcript: CallTurn[];
  callerMessage: string;
  transferAvailable: boolean;
  collectedName?: string;
  collectedPhone?: string;
  collectedAddress?: string;
  collectedNotes?: string;
  callStage?: CallStage;
  smsOk?: boolean;
}): Promise<VoiceAgentResult> {
  const company = String(input.businessName || 'our company').slice(0, 120);
  const aniPhone = String(input.callerPhone || '').trim();
  const msg = String(input.callerMessage || '').trim();
  let stage: CallStage = input.callStage || 'need';

  // Re-derive jobType from stored notes so recap can stay short/natural
  const priorNotes = String(input.collectedNotes || '').trim();
  const priorFromNotes = priorNotes
    ? extractLeadHintsFromSpeech(priorNotes, '')
    : {};
  let lead: VoiceAgentLead = {
    name: input.collectedName || '',
    phone: input.collectedPhone || '',
    address: input.collectedAddress || '',
    notes: priorNotes,
    jobType: priorFromNotes.jobType || '',
    urgent: Boolean(priorFromNotes.urgent),
  };

  let smsOk = input.smsOk;
  let action: VoiceAgentAction = 'continue';
  let websiteText = String(input.websiteText || '').trim();
  const websiteUrl = String(input.websiteUrl || '').trim();

  const build = (say: string, nextStage: CallStage): VoiceAgentResult => ({
    say: say.slice(0, MAX_SAY),
    action,
    lead,
    callStage: nextStage,
    smsOk,
    websiteText: websiteText || undefined,
  });

  // Transfer escape hatch — always wins over Q&A
  if (wantsHuman(msg) && input.transferAvailable) {
    action = 'transfer';
    return build('Connecting you now.', stage);
  }

  // FAQ / website Q&A at any stage (then bridge back to same stage)
  if (msg && isCallerQuestion(msg) && stage !== 'thanks') {
    // Prefer script capture when caller is clearly giving their need (no ? / opener)
    const looksLikeNeedDump =
      stage === 'need' &&
      !msg.includes('?') &&
      !/^(how|what|when|where|why|who|do|does|are|can|could|is|will)\b/i.test(msg) &&
      isSubstantiveNeed(msg, extractLeadHintsFromSpeech(msg, aniPhone));
    if (!looksLikeNeedDump) {
      try {
        if (websiteText && websiteUrl) {
          warmWebsiteTextCache(websiteUrl, websiteText);
        } else if (!websiteText && websiteUrl) {
          websiteText = await fetchWebsiteKnowledgeText(websiteUrl, { budgetMs: 3500 });
        }
      } catch {
        /* soft-fail — FAQs only */
      }

      const qa = await answerCallerQuestion({
        question: msg,
        knowledgeBase: input.knowledgeBase || '',
        websiteText,
        businessName: company,
      });
      const bridge = stageBridgePrompt(stage, lead, company);
      const combined = `${qa.say} ${bridge}`.replace(/\s+/g, ' ').trim();
      return build(combined, stage);
    }
  }

  // --- Stage machine ---
  if (stage === 'need') {
    const hints = extractLeadHintsFromSpeech(msg, aniPhone, { expectName: false });
    if (!isSubstantiveNeed(msg, hints)) {
      return build(
        `Sorry, I didn't quite catch that. What are you calling about today?`,
        'need'
      );
    }
    lead = mergeLead(lead, hints, {});
    if (!lead.notes && !lead.jobType) {
      lead.notes = msg.slice(0, 500);
    }
    return build(`Happy to help with that — who am I speaking with?`, 'name');
  }

  if (stage === 'name') {
    const hints = extractLeadHintsFromSpeech(msg, aniPhone, { expectName: true });
    lead = mergeLead(lead, hints, {});
    if (!lead.name && looksLikePersonName(msg)) {
      lead.name = titleCaseName(msg.replace(/[.,!?]/g, ''));
    }
    if (!lead.name) {
      // Accept short alphabetic answers when we asked for a name
      const cleaned = msg.replace(/[.,!?]/g, '').trim();
      const words = cleaned.split(/\s+/).filter(Boolean);
      if (
        words.length >= 1 &&
        words.length <= 4 &&
        words.every((w) => /^[A-Za-z][A-Za-z'-]*$/.test(w)) &&
        !words.every((w) => NAME_STOP.has(w.toLowerCase()))
      ) {
        lead.name = titleCaseName(cleaned);
      }
    }
    if (!lead.name) {
      return build(`I want to make sure I get it right — who am I speaking with?`, 'name');
    }
    const first = firstName(lead.name);
    const hi = first ? `${first}, ` : '';
    if (aniPhone) {
      return build(
        `${hi}is ${formatPhoneForSpeech(aniPhone)} the best number to call you back on?`,
        'phone'
      );
    }
    return build(`${hi}what's the best number to reach you?`, 'phone');
  }

  if (stage === 'phone') {
    const hints = extractLeadHintsFromSpeech(msg, aniPhone, { expectPhone: true });
    lead = mergeLead(lead, hints, {});
    if (
      !lead.phone &&
      aniPhone &&
      /\b(yes|yeah|yep|yup|correct|that's (me|right|fine)|that is|this (number|one)|sure|ok|okay)\b/i.test(
        msg
      )
    ) {
      lead.phone = aniPhone;
    }
    if (!lead.phone && aniPhone && !/\b(no|nope|different|other|new)\b/i.test(msg)) {
      // Soft fallback: if they didn't reject, use ANI when no spoken number
      if (!hints.phone) lead.phone = aniPhone;
    }
    if (!lead.phone) {
      const first = firstName(lead.name);
      const hi = first ? `${first}, ` : '';
      return build(
        `${hi}I didn't catch a number — what's the best number to call you back on?`,
        'phone'
      );
    }
    // Combined recap + anything_else ask; wait for reply on anything_else
    const reason = fullReason(lead);
    return build(
      `So I've got ${reason}. Anything else you'd like to add, or anything else we can help with today?`,
      'anything_else'
    );
  }

  if (stage === 'anything_else') {
    if (isClearNo(msg)) {
      return build(
        `All of our technicians are helping other customers right now, so we'll call you back as soon as we can. Are you okay with us texting you as well?`,
        'techs_sms'
      );
    }

    const hints = extractLeadHintsFromSpeech(msg, aniPhone);
    if (isRealAnythingElseAdd(msg, hints)) {
      if (hints.jobType) {
        const bits = [lead.jobType, hints.jobType].filter(Boolean).join(', ');
        lead.jobType = [...new Set(bits.split(/,\s*/).map((s) => s.trim()).filter(Boolean))].join(
          ', '
        );
      }
      if (hints.address && !lead.address) lead.address = hints.address;
      if (hints.urgent) lead.urgent = true;
      if (hints.preferredTime) lead.preferredTime = hints.preferredTime;
      const extra = hints.notes || msg;
      lead.notes = appendNotes(lead.notes || '', extra);
      const reason = fullReason(lead);
      return build(
        `So I've got ${reason}. Anything else you'd like to add, or anything else we can help with today?`,
        'anything_else'
      );
    }

    // Unclear / empty — gently re-ask without inventing notes
    const reason = fullReason(lead);
    return build(
      `Sorry, I didn't quite catch that. So I've got ${reason}. Anything else you'd like to add, or anything else we can help with today?`,
      'anything_else'
    );
  }

  if (stage === 'techs_sms') {
    smsOk = parseSmsOk(msg);
    action = 'end';
    return build(
      `Thanks so much for calling ${company}. We'll be in contact with you as soon as possible. Goodbye!`,
      'thanks'
    );
  }

  // thanks / unknown — end politely
  action = 'end';
  smsOk = smsOk === true || smsOk === false ? smsOk : true;
  return build(
    `Thanks so much for calling ${company}. We'll be in contact with you as soon as possible. Goodbye!`,
    'thanks'
  );
}

export async function summarizeVoiceCall(input: {
  businessName: string;
  transcript: CallTurn[];
  callerPhone: string;
  urgentKeywords?: string;
  collectedName?: string;
  collectedPhone?: string;
  collectedAddress?: string;
}): Promise<{
  callerName: string;
  callerPhone: string;
  address: string;
  summary: string;
  actionItems: string[];
  urgent: boolean;
  language: string;
}> {
  const apiKey = getXaiApiKey();
  const text = transcriptToText(input.transcript);
  const fallback = {
    callerName: String(input.collectedName || 'Unknown').slice(0, 120),
    callerPhone: String(input.collectedPhone || input.callerPhone || '').slice(0, 40),
    address: String(input.collectedAddress || '').slice(0, 200),
    summary: text.slice(0, 280) || 'Missed or empty call',
    actionItems: ['Follow up with caller'],
    urgent: false,
    language: 'en',
  };
  if (!apiKey || !text.trim()) return fallback;

  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        model: getXaiChatModel(),
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: `Extract contact + summary from a contractor receptionist call. Return ONLY JSON:
{"callerName":"","callerPhone":"","address":"","summary":"","actionItems":[],"urgent":false,"language":"en"}
Prefer known values if provided. Never invent an address or phone.`,
          },
          {
            role: 'user',
            content: `Company: ${input.businessName}
Known name: ${input.collectedName || ''}
Known phone: ${input.collectedPhone || input.callerPhone || ''}
Known address: ${input.collectedAddress || ''}
ANI: ${input.callerPhone}

${text}`,
          },
        ],
      }),
    });
    const json = await res.json().catch(() => ({}));
    const parsed = parseAgentJson(String(json.choices?.[0]?.message?.content || '')) as any;
    if (!parsed) return fallback;
    return {
      callerName: String(parsed.callerName || fallback.callerName).slice(0, 120),
      callerPhone: String(parsed.callerPhone || fallback.callerPhone).slice(0, 40),
      address: String(parsed.address || fallback.address).slice(0, 200),
      summary: String(parsed.summary || fallback.summary).slice(0, 2000),
      actionItems: Array.isArray(parsed.actionItems)
        ? parsed.actionItems.map(String).slice(0, 8)
        : fallback.actionItems,
      urgent: Boolean(parsed.urgent),
      language: String(parsed.language || 'en').slice(0, 12),
    };
  } catch {
    return fallback;
  }
}

function parseAgentJson(raw: string): any | null {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
