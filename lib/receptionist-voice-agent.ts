/**
 * Live voice turn agent (Grok) for Twilio Gather speech loops.
 * Must collect name, phone, and address before ending the call.
 */
import { getXaiApiKey, getXaiChatModel } from '@/lib/xai-config';
import { transcriptToText, type CallTurn } from '@/lib/receptionist-call-session';

export type VoiceAgentAction = 'continue' | 'transfer' | 'end';

export type VoiceAgentLead = {
  name?: string;
  phone?: string;
  address?: string;
  notes?: string;
  urgent?: boolean;
};

export type VoiceAgentResult = {
  say: string;
  action: VoiceAgentAction;
  lead?: VoiceAgentLead | null;
};

const MAX_SAY = 320;

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
  const haveName = Boolean(String(input.collectedName || '').trim());
  const havePhone = Boolean(String(input.collectedPhone || '').trim());
  const haveAddress = Boolean(String(input.collectedAddress || '').trim());
  const missing: string[] = [];
  if (!haveName) missing.push('full name');
  if (!havePhone) missing.push('callback phone number');
  if (!haveAddress) missing.push('job / service address');

  if (!apiKey) {
    const ask = !haveName
      ? 'Thanks for calling. Can I get your full name please?'
      : !havePhone
        ? 'Thanks. What is the best phone number to reach you?'
        : !haveAddress
          ? 'And what is the job site address, including city?'
          : 'Thanks — we have your info and will follow up soon. Goodbye.';
    return {
      say: ask,
      action: missing.length ? 'continue' : 'end',
      lead: {
        name: input.collectedName || '',
        phone: input.collectedPhone || input.callerPhone || '',
        address: input.collectedAddress || '',
        notes: input.callerMessage,
      },
    };
  }

  const model = getXaiChatModel();
  const company = String(input.businessName || 'the company').slice(0, 120);
  const kb = String(input.knowledgeBase || '').slice(0, 8000);
  const langs = (input.languages || ['en']).join(', ');
  const urgent = String(input.urgentKeywords || 'emergency,urgent,leak,flooding,no heat,no ac').slice(
    0,
    400
  );
  const history = transcriptToText(input.transcript).slice(0, 10000);
  const aniPhone = String(input.callerPhone || '').trim();

  const system = `You are the live phone receptionist for "${company}", a contractor / field-service business.
Speak in 1–2 short sentences for phone TTS. No markdown, no JSON in "say".

REQUIRED CONTACT COLLECTION (do this every call before ending):
You MUST collect ALL three:
1) Full name
2) Phone number (callback number)
3) Service / job address (street + city at minimum)

Already collected:
- name: ${haveName ? input.collectedName : 'MISSING'}
- phone: ${havePhone ? input.collectedPhone : 'MISSING'}
- address: ${haveAddress ? input.collectedAddress : 'MISSING'}
Still need: ${missing.length ? missing.join(', ') : 'none — all three collected'}.

Caller ID on this line (may or may not be their callback number): ${aniPhone || 'unknown'}.
If phone is MISSING, ask for their best callback number. You may confirm: "Is ${aniPhone || 'the number you are calling from'} the best number to reach you?" If they say yes, set phone to that number.
Ask for ONLY ONE missing field per turn (the next missing in order: name, then phone, then address), unless they volunteer more.
Do NOT invent name, phone, or address.

After all three are collected, briefly confirm what they need, then you may end.
You may still answer simple questions from the knowledge base, but keep steering back to missing contact fields.

Languages: ${langs}.
Urgent keywords: ${urgent}.
Transfer available: ${input.transferAvailable ? 'YES' : 'NO'}.

Return ONLY valid JSON:
{
  "say": "spoken reply",
  "action": "continue" | "transfer" | "end",
  "lead": {
    "name": "full name or empty",
    "phone": "callback phone or empty",
    "address": "job address or empty",
    "notes": "what they need",
    "urgent": false
  }
}

Rules:
- action "end" ONLY if name, phone, AND address are all present in lead (or already collected).
- If anything is missing, action MUST be "continue" and "say" must ask for the next missing field.
- action "transfer" only if they ask for a person / press 0 and transfer is available.
- Always return lead with the best known name/phone/address so far (merge with already collected).
- Keep "say" under 240 characters.

KNOWLEDGE BASE:
${kb || '(empty — take a message)'}
`;

  const userContent = `Conversation so far:
${history || '(just started)'}

Caller just said (speech-to-text may be imperfect): "${String(input.callerMessage || '').slice(0, 1500)}"

Update lead fields from what they said. Respond with JSON only.`;

  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      // Twilio webhooks time out ~15s — fail soft before that
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        model,
        temperature: 0.35,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('voice agent grok:', json);
      return fallbackAskNext(missing, input);
    }
    const raw = String(json.choices?.[0]?.message?.content || '').trim();
    const parsed = parseAgentJson(raw);
    if (!parsed) return fallbackAskNext(missing, input);

    const lead: VoiceAgentLead = {
      name: String(parsed.lead?.name || input.collectedName || '').trim().slice(0, 120),
      phone: String(parsed.lead?.phone || input.collectedPhone || '')
        .trim()
        .slice(0, 40),
      address: String(parsed.lead?.address || input.collectedAddress || '')
        .trim()
        .slice(0, 200),
      notes: String(parsed.lead?.notes || input.collectedNotes || input.callerMessage || '')
        .trim()
        .slice(0, 1000),
      urgent: Boolean(parsed.lead?.urgent),
    };

    // If they confirmed calling number as callback
    if (
      !lead.phone &&
      aniPhone &&
      /\b(yes|yeah|yep|correct|that's me|that is me|this number|this one)\b/i.test(
        input.callerMessage || ''
      ) &&
      !havePhone
    ) {
      lead.phone = aniPhone;
    }

    const stillMissing: string[] = [];
    if (!lead.name) stillMissing.push('full name');
    if (!lead.phone) stillMissing.push('callback phone number');
    if (!lead.address) stillMissing.push('job address');

    let action: VoiceAgentAction =
      parsed.action === 'transfer' || parsed.action === 'end' ? parsed.action : 'continue';

    if (action === 'transfer' && !input.transferAvailable) {
      action = 'continue';
    }

    // Hard gate: cannot end without all three
    if (action === 'end' && stillMissing.length) {
      action = 'continue';
    }

    let say = String(parsed.say || '').trim();
    if (!say || say.startsWith('{')) {
      say = fallbackAskNext(stillMissing, input).say;
    }
    if (action === 'continue' && stillMissing.length && !/\?/.test(say)) {
      // Ensure we actually ask for the missing field
      say = fallbackAskNext(stillMissing, input).say;
    }

    return {
      say: say.slice(0, MAX_SAY),
      action,
      lead,
    };
  } catch (e) {
    console.error('voice agent error:', e);
    return fallbackAskNext(missing, input);
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
      signal: AbortSignal.timeout(8000),
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

function fallbackAskNext(
  missing: string[],
  input: { collectedName?: string; collectedPhone?: string; collectedAddress?: string; callerMessage?: string; callerPhone?: string }
): VoiceAgentResult {
  const next = missing[0] || '';
  let say = 'Thanks. How can I help you today?';
  if (next.includes('name')) say = 'Thanks for calling. Can I get your full name please?';
  else if (next.includes('phone'))
    say = input.callerPhone
      ? `Thanks. Is ${input.callerPhone} the best number to call you back?`
      : 'Thanks. What is the best phone number to reach you?';
  else if (next.includes('address'))
    say = 'Got it. What is the job site address, including the city?';
  else say = 'Perfect — we have your name, phone, and address. We will follow up soon. Goodbye.';

  return {
    say,
    action: missing.length ? 'continue' : 'end',
    lead: {
      name: input.collectedName || '',
      phone: input.collectedPhone || '',
      address: input.collectedAddress || '',
      notes: input.callerMessage || '',
    },
  };
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
