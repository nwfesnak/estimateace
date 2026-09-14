/**
 * Live voice turn agent (Grok) for Twilio Gather speech loops.
 * Returns spoken text + optional tools: create lead, transfer, end call.
 */
import { getXaiApiKey, getXaiChatModel } from '@/lib/xai-config';
import { transcriptToText, type CallTurn } from '@/lib/receptionist-call-session';

export type VoiceAgentAction = 'continue' | 'transfer' | 'end';

export type VoiceAgentResult = {
  say: string;
  action: VoiceAgentAction;
  lead?: {
    name?: string;
    notes?: string;
    address?: string;
    urgent?: boolean;
  } | null;
};

const MAX_SAY = 450;

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
}): Promise<VoiceAgentResult> {
  const apiKey = getXaiApiKey();
  if (!apiKey) {
    return {
      say: 'Thanks for calling. Please leave your name and what you need, and we will call you back shortly.',
      action: 'end',
      lead: {
        name: '',
        notes: input.callerMessage,
      },
    };
  }

  const model = getXaiChatModel();
  const company = String(input.businessName || 'the company').slice(0, 120);
  const kb = String(input.knowledgeBase || '').slice(0, 10000);
  const langs = (input.languages || ['en']).join(', ');
  const urgent = String(input.urgentKeywords || 'emergency,urgent,leak,flooding,no heat,no ac').slice(
    0,
    400
  );
  const history = transcriptToText(input.transcript).slice(0, 12000);

  const system = `You are the live phone receptionist for "${company}", a contractor / field-service business.
The caller is on a real phone. Speech-to-text may be imperfect — interpret noisy or partial phrases charitably.
Speak naturally in 1–2 short sentences (phone TTS). No stage directions, no markdown, no bullet lists, no JSON in "say".
Answer ONLY from the knowledge base (plus courtesy). If unsure, take a message and ask one clear follow-up.
Caller phone on this call: ${input.callerPhone || 'unknown'}.
Languages: ${langs}.
Urgent keywords: ${urgent}.
Transfer to a human is ${input.transferAvailable ? 'AVAILABLE' : 'NOT available'}.

Return ONLY valid JSON (no markdown fences):
{
  "say": "words to speak to the caller",
  "action": "continue" | "transfer" | "end",
  "lead": null OR { "name": "", "notes": "", "address": "", "urgent": false }
}

Rules:
- If the caller's words are unclear, ask them to repeat briefly — do not invent details.
- action "continue" = ask a follow-up / keep talking.
- action "transfer" = only if transfer is available AND caller asks for a person / emergency needs human. Pressing 0 also means transfer.
- action "end" = goodbye after message taken or call complete.
- Set lead when you have enough to notify the owner (name and/or clear need).
- Keep "say" under 280 characters.

KNOWLEDGE BASE:
${kb || '(empty — take a message and offer a callback)'}

Greeting style hint: ${input.greetingStyle || 'Friendly professional'}`;

  const userContent = `Conversation so far:
${history || '(call just started)'}

Caller just said (speech-to-text, may be imperfect): "${String(input.callerMessage || 'Hello').slice(0, 1500)}"

Respond with JSON only.`;

  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
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
      return fallbackContinue(input.callerMessage);
    }
    const raw = String(json.choices?.[0]?.message?.content || '').trim();
    const parsed = parseAgentJson(raw);
    if (!parsed) return fallbackContinue(input.callerMessage);

    let action: VoiceAgentAction = parsed.action === 'transfer' || parsed.action === 'end'
      ? parsed.action
      : 'continue';
    if (action === 'transfer' && !input.transferAvailable) {
      action = 'continue';
      parsed.say =
        parsed.say ||
        "I don't have someone available to transfer to right now, but I can take a message.";
    }

    return {
      say: String(parsed.say || "Sorry, I didn't catch that. How can I help?").slice(0, MAX_SAY),
      action,
      lead: parsed.lead && typeof parsed.lead === 'object' ? parsed.lead : null,
    };
  } catch (e) {
    console.error('voice agent error:', e);
    return fallbackContinue(input.callerMessage);
  }
}

export async function summarizeVoiceCall(input: {
  businessName: string;
  transcript: CallTurn[];
  callerPhone: string;
  urgentKeywords?: string;
}): Promise<{
  callerName: string;
  summary: string;
  actionItems: string[];
  urgent: boolean;
  language: string;
}> {
  const apiKey = getXaiApiKey();
  const text = transcriptToText(input.transcript);
  if (!apiKey || !text.trim()) {
    return {
      callerName: 'Unknown',
      summary: text.slice(0, 280) || 'Missed or empty call',
      actionItems: ['Follow up with caller'],
      urgent: false,
      language: 'en',
    };
  }
  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: getXaiChatModel(),
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: `Summarize a contractor receptionist phone call. Return ONLY JSON:
{"callerName":"","summary":"","actionItems":[],"urgent":false,"language":"en"}`,
          },
          {
            role: 'user',
            content: `Company: ${input.businessName}\nCaller phone: ${input.callerPhone}\nUrgent keywords: ${input.urgentKeywords || ''}\n\n${text}`,
          },
        ],
      }),
    });
    const json = await res.json().catch(() => ({}));
    const raw = String(json.choices?.[0]?.message?.content || '');
    const parsed = parseAgentJson(raw) as any;
    if (!parsed) {
      return {
        callerName: 'Unknown',
        summary: text.slice(0, 280),
        actionItems: ['Review call transcript'],
        urgent: false,
        language: 'en',
      };
    }
    return {
      callerName: String(parsed.callerName || 'Unknown').slice(0, 120),
      summary: String(parsed.summary || text.slice(0, 280)).slice(0, 2000),
      actionItems: Array.isArray(parsed.actionItems)
        ? parsed.actionItems.map(String).slice(0, 8)
        : [],
      urgent: Boolean(parsed.urgent),
      language: String(parsed.language || 'en').slice(0, 12),
    };
  } catch {
    return {
      callerName: 'Unknown',
      summary: text.slice(0, 280),
      actionItems: ['Review call transcript'],
      urgent: false,
      language: 'en',
    };
  }
}

function fallbackContinue(callerMessage: string): VoiceAgentResult {
  return {
    say: "Thanks — I'm listening. Could you share your name and what you need help with?",
    action: 'continue',
    lead: callerMessage
      ? { notes: callerMessage.slice(0, 500), urgent: /urgent|emergency|leak|flood/i.test(callerMessage) }
      : null,
  };
}

function parseAgentJson(raw: string): any | null {
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
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
