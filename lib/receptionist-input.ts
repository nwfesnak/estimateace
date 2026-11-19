/**
 * Input caps for the AI receptionist "test reply" / call summary endpoint
 * (POST /api/receptionist). Keeps each AI call small and predictable in cost.
 */
export const RECEPTIONIST_MAX_CHARS = 4000;
export const RECEPTIONIST_MAX_CALLER_MESSAGE = 1000;
export const RECEPTIONIST_MAX_TOKENS = { reply: 300, summarize: 800 } as const;

export type ReceptionistInput = {
  mode: 'reply' | 'summarize';
  company: string;
  knowledgeBase: string;
  greeting: string;
  languages: string[];
  transcript: string;
  callerMessage: string;
  urgentKeywords: string;
};

/** Keep the most recent part of a long transcript (that is what the AI replies to). */
function tail(value: string, max: number): string {
  return value.length > max ? value.slice(value.length - max) : value;
}

export function normalizeReceptionistInput(body: unknown): ReceptionistInput {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const languages = Array.isArray(b.languages)
    ? b.languages.map((l) => String(l).slice(0, 12)).slice(0, 8)
    : ['en'];
  return {
    mode: b.mode === 'summarize' ? 'summarize' : 'reply',
    company: String(b.company || 'the company').slice(0, 120),
    knowledgeBase: String(b.knowledgeBase || '').slice(0, RECEPTIONIST_MAX_CHARS),
    greeting: String(b.greeting || '').slice(0, 500),
    languages: languages.length ? languages : ['en'],
    transcript: tail(String(b.transcript || ''), RECEPTIONIST_MAX_CHARS),
    callerMessage: String(b.callerMessage || '').slice(0, RECEPTIONIST_MAX_CALLER_MESSAGE),
    urgentKeywords: String(b.urgentKeywords || 'emergency,urgent,leak,flooding').slice(0, 500),
  };
}
