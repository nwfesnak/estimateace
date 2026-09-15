/**
 * Live voice turn agent (Grok) for Twilio Gather speech loops.
 * Casual conversation that still captures a solid contractor lead:
 * name, phone, address, what they need, urgency, preferred callback.
 */
import { getXaiApiKey, getXaiChatModel } from '@/lib/xai-config';
import { transcriptToText, type CallTurn } from '@/lib/receptionist-call-session';

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
};

const MAX_SAY = 320;

/** Pull contact + job hints from messy speech-to-text when Grok is down or incomplete. */
export function extractLeadHintsFromSpeech(
  text: string,
  aniPhone = ''
): VoiceAgentLead {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return {};

  const lead: VoiceAgentLead = {};

  // Phone numbers in speech
  const phoneMatch = raw.match(
    /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/
  );
  if (phoneMatch) {
    lead.phone = phoneMatch[0].replace(/[^\d+]/g, '');
  } else if (
    aniPhone &&
    /\b(yes|yeah|yep|correct|that's (me|right|fine)|that is|this (number|one)|calling from)\b/i.test(
      raw
    )
  ) {
    lead.phone = aniPhone;
  }

  // "my name is X" / "this is X" / "I am X"
  const namePatterns = [
    /(?:my name is|this is|i am|i'm|it's|it is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/i,
    /(?:name'?s)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/i,
  ];
  for (const re of namePatterns) {
    const m = raw.match(re);
    if (m?.[1]) {
      const n = m[1].trim();
      if (!/^(yes|yeah|no|okay|ok|hi|hello|calling|looking)$/i.test(n)) {
        lead.name = n;
        break;
      }
    }
  }
  // Bare "First Last" as whole utterance
  if (!lead.name) {
    const bare = raw.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\.?$/);
    if (bare) lead.name = bare[1];
  }

  // Address-ish: number + street word, or "in City"
  const addr = raw.match(
    /\b(\d{1,6}\s+[A-Za-z0-9 .'-]{3,40}\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|way|circle|cir|hwy|highway)\.?(?:\s*,?\s*[A-Za-z .']+)?)(?:\b|$)/i
  );
  if (addr) {
    lead.address = addr[1].replace(/\s+/g, ' ').trim();
  } else {
    const city = raw.match(
      /\b(?:in|at|near|around)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\b/
    );
    if (city && !lead.address) lead.address = city[1];
  }

  // Job / need keywords → notes
  const jobBits: string[] = [];
  const jobRe =
    /\b(pressure\s*wash(?:ing)?|roof(?:ing)?|paint(?:ing)?|plumb(?:ing|er)?|hvac|ac|air\s*condition(?:ing|er)?|electric(?:al|ian)?|landscap(?:e|ing)|lawn|mow(?:ing)?|fence|concrete|driveway|sidewalk|gutters?|windows?|clean(?:ing)?|repair|install|estimate|quote|remodel|leak|flood)\b/gi;
  let jm: RegExpExecArray | null;
  while ((jm = jobRe.exec(raw))) {
    jobBits.push(jm[1].toLowerCase());
  }
  if (jobBits.length) {
    lead.jobType = [...new Set(jobBits)].join(', ');
    lead.notes = raw.slice(0, 500);
  } else if (raw.length > 12) {
    lead.notes = raw.slice(0, 500);
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

function missingFields(lead: VoiceAgentLead): string[] {
  const m: string[] = [];
  if (!String(lead.name || '').trim()) m.push('name');
  if (!String(lead.phone || '').trim()) m.push('phone');
  if (!String(lead.address || '').trim()) m.push('address');
  if (!String(lead.notes || lead.jobType || '').trim()) m.push('need');
  return m;
}

function casualAskNext(
  missing: string[],
  lead: VoiceAgentLead,
  aniPhone: string,
  company: string
): string {
  const next = missing[0] || '';
  const first = (lead.name || '').split(/\s+/)[0];
  const hi = first ? `${first}, ` : '';

  if (next === 'need') {
    return `${hi}what can we help you with today?`;
  }
  if (next === 'name') {
    return lead.jobType || lead.notes
      ? `Happy to help with that — who am I speaking with?`
      : `Thanks for calling ${company}. Who am I speaking with?`;
  }
  if (next === 'phone') {
    if (aniPhone) {
      return `${hi}is ${aniPhone} the best number to call you back on?`;
    }
    return `${hi}what's the best number to reach you?`;
  }
  if (next === 'address') {
    return `${hi}what's the job address, including the city?`;
  }
  // All set — wrap up casually
  const job = lead.jobType ? ` about the ${lead.jobType}` : '';
  return `${hi}got it${job}. We'll follow up soon — thanks for calling ${company}!`;
}

export async function runReceptionistVoiceTurn(input: {
  businessName: string;
  knowledgeBase: string;
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
}): Promise<VoiceAgentResult> {
  const apiKey = getXaiApiKey();
  const company = String(input.businessName || 'our company').slice(0, 120);
  const aniPhone = String(input.callerPhone || '').trim();
  const speechHints = extractLeadHintsFromSpeech(input.callerMessage, aniPhone);

  const prior: VoiceAgentLead = {
    name: input.collectedName || '',
    phone: input.collectedPhone || '',
    address: input.collectedAddress || '',
    notes: input.collectedNotes || '',
  };

  // Seed phone from caller ID early so we usually only confirm it
  if (!prior.phone && aniPhone && /^\+?\d{10,15}$/.test(aniPhone.replace(/[^\d+]/g, ''))) {
    // don't auto-commit ANI as final until confirmed OR used as fallback at end
  }

  let lead = mergeLead(prior, speechHints, {});

  const buildResult = (
    say: string,
    action: VoiceAgentAction,
    L: VoiceAgentLead
  ): VoiceAgentResult => ({
    say: say.slice(0, MAX_SAY),
    action,
    lead: L,
  });

  if (!apiKey) {
    // Progress without Grok using speech heuristics + casual prompts
    const miss = missingFields(lead);
    // If still missing phone at wrap-up time, use ANI
    if (!lead.phone && aniPhone && miss.filter((x) => x !== 'phone').length === 0) {
      lead = { ...lead, phone: aniPhone };
    }
    const miss2 = missingFields(lead);
    if (!miss2.length) {
      return buildResult(casualAskNext([], lead, aniPhone, company), 'end', lead);
    }
    return buildResult(casualAskNext(miss2, lead, aniPhone, company), 'continue', lead);
  }

  const model = getXaiChatModel();
  const kb = String(input.knowledgeBase || '').slice(0, 8000);
  const langs = (input.languages || ['en']).join(', ');
  const urgent = String(
    input.urgentKeywords || 'emergency,urgent,leak,flooding,no heat,no ac'
  ).slice(0, 400);
  const history = transcriptToText(input.transcript).slice(0, 10000);
  const missNow = missingFields(lead);

  const system = `You are the friendly phone receptionist for "${company}" (contractor / field service).
Sound like a helpful person on the phone — warm, casual, brief (1–2 short sentences). No markdown. Never put JSON in "say".

GOAL: Capture a solid lead through natural conversation, not an interrogation.
Ideal lead fields:
1) Full name
2) Callback phone (caller ID is ${aniPhone || 'unknown'} — confirm it casually when phone is missing)
3) Job / service address (street + city)
4) What they need (job type / problem) — put in notes + jobType
5) Urgency and preferred time if they mention it

Already collected:
- name: ${lead.name || 'MISSING'}
- phone: ${lead.phone || 'MISSING'}
- address: ${lead.address || 'MISSING'}
- need/notes: ${lead.notes || lead.jobType || 'MISSING'}
Still need: ${missNow.length ? missNow.join(', ') : 'none — you may wrap up'}.

Style:
- Acknowledge what they just said first ("got it", "sounds good", "happy to help with the driveway").
- Ask for at most ONE missing thing per turn, woven in casually.
- If they volunteer several fields at once, accept them all.
- Do NOT invent name, phone, or address.
- If they ask for a human / press 0 and transfer is ${input.transferAvailable ? 'available' : 'NOT available'}, use action "transfer" only when available.

Languages: ${langs}.
Urgent keywords: ${urgent}.

Return ONLY valid JSON:
{
  "say": "spoken reply under 220 chars",
  "action": "continue" | "transfer" | "end",
  "lead": {
    "name": "",
    "phone": "",
    "address": "",
    "notes": "what they need",
    "jobType": "",
    "preferredTime": "",
    "urgent": false
  }
}

Rules:
- Merge lead with already-collected values; never wipe known fields with empty strings.
- action "end" ONLY when name, phone, address, AND what they need are all known.
- Keep "say" under 220 characters.

KNOWLEDGE BASE:
${kb || '(empty — take a message and promise a callback)'}
`;

  const userContent = `Conversation so far:
${history || '(just started)'}

Caller just said (speech-to-text may be imperfect): "${String(input.callerMessage || '').slice(0, 1500)}"

Speech hints already parsed: ${JSON.stringify(speechHints)}
Update lead fields from what they said. Respond with JSON only.`;

  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      // Twilio webhooks ~15s — leave headroom
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        model,
        temperature: 0.45,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('voice agent grok:', json);
      const miss = missingFields(lead);
      return buildResult(
        casualAskNext(miss, lead, aniPhone, company),
        miss.length ? 'continue' : 'end',
        lead
      );
    }
    const raw = String(json.choices?.[0]?.message?.content || '').trim();
    const parsed = parseAgentJson(raw);
    if (!parsed) {
      const miss = missingFields(lead);
      return buildResult(
        casualAskNext(miss, lead, aniPhone, company),
        miss.length ? 'continue' : 'end',
        lead
      );
    }

    const fromModel: VoiceAgentLead = {
      name: String(parsed.lead?.name || '').trim().slice(0, 120),
      phone: String(parsed.lead?.phone || '').trim().slice(0, 40),
      address: String(parsed.lead?.address || '').trim().slice(0, 200),
      notes: String(parsed.lead?.notes || '').trim().slice(0, 1000),
      jobType: String(parsed.lead?.jobType || '').trim().slice(0, 120),
      preferredTime: String(parsed.lead?.preferredTime || '').trim().slice(0, 80),
      urgent: Boolean(parsed.lead?.urgent),
    };

    lead = mergeLead(lead, fromModel, speechHints);

    // Confirm ANI as phone on yes
    if (
      !lead.phone &&
      aniPhone &&
      /\b(yes|yeah|yep|correct|that's (me|right|fine)|that is|this (number|one))\b/i.test(
        input.callerMessage || ''
      )
    ) {
      lead.phone = aniPhone;
    }

    let action: VoiceAgentAction =
      parsed.action === 'transfer' || parsed.action === 'end' ? parsed.action : 'continue';
    if (action === 'transfer' && !input.transferAvailable) action = 'continue';

    const still = missingFields(lead);
    if (action === 'end' && still.length) action = 'continue';

    let say = String(parsed.say || '').trim();
    if (!say || say.startsWith('{') || say.includes('"action"')) {
      say = casualAskNext(still, lead, aniPhone, company);
    }
    // Do NOT replace a good casual reply just because it lacks "?".
    // Only fill in if the model ignored a still-missing critical field entirely
    // and gave an ending-style goodbye too early.
    if (
      action === 'continue' &&
      still.length &&
      /\b(goodbye|good bye|talk soon|we'll (be in )?touch)\b/i.test(say)
    ) {
      say = casualAskNext(still, lead, aniPhone, company);
    }

    if (!still.length && action === 'continue') {
      // Model forgot to end — wrap politely
      action = 'end';
      if (!/\b(thanks|thank you|follow up|talk soon|goodbye)\b/i.test(say)) {
        say = casualAskNext([], lead, aniPhone, company);
      }
    }

    return buildResult(say, action, lead);
  } catch (e) {
    console.error('voice agent error:', e);
    const miss = missingFields(lead);
    return buildResult(
      casualAskNext(miss, lead, aniPhone, company),
      miss.length ? 'continue' : 'end',
      lead
    );
  }
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
