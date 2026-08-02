/** AI Receptionist — settings & call messages stored on SETTINGS profile */

export type ReceptionistSettings = {
  enabled: boolean;
  greeting: string;
  afterHoursGreeting: string;
  businessHoursStart: string;
  businessHoursEnd: string;
  /** 0=Sun … 6=Sat */
  businessDays: number[];
  notifyPhone: string;
  notifyEmail: string;
  languages: string[];
  knowledgeBase: string;
  websiteUrl: string;
  spamScreening: boolean;
  bookAppointments: boolean;
  urgentKeywords: string;
  customVoicemail: string;
};

export type ReceptionistMessage = {
  id: string;
  createdAt: string;
  callerName: string;
  callerPhone: string;
  summary: string;
  actionItems: string[];
  transcript: string;
  urgent: boolean;
  spam: boolean;
  language: string;
  status: 'new' | 'read' | 'handled';
  source: 'test' | 'forwarded' | 'manual';
};

export const DEFAULT_RECEPTIONIST_SETTINGS: ReceptionistSettings = {
  enabled: false,
  greeting:
    'Thanks for calling {company}. This is the AI receptionist. How can I help you today?',
  afterHoursGreeting:
    "You've reached {company} after hours. I'm the AI receptionist — I can take a message, answer common questions, or help schedule a callback.",
  businessHoursStart: '08:00',
  businessHoursEnd: '17:00',
  businessDays: [1, 2, 3, 4, 5],
  notifyPhone: '',
  notifyEmail: '',
  languages: ['en', 'es'],
  knowledgeBase: '',
  websiteUrl: '',
  spamScreening: true,
  bookAppointments: true,
  urgentKeywords: 'emergency, leak, no heat, no ac, flooding, urgent, asap, fire, smoke',
  customVoicemail: '',
};

export function normalizeReceptionistSettings(raw: unknown): ReceptionistSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const base = { ...DEFAULT_RECEPTIONIST_SETTINGS };
  return {
    ...base,
    enabled: r.enabled === true,
    greeting: String(r.greeting ?? base.greeting),
    afterHoursGreeting: String(r.afterHoursGreeting ?? base.afterHoursGreeting),
    businessHoursStart: String(r.businessHoursStart ?? base.businessHoursStart),
    businessHoursEnd: String(r.businessHoursEnd ?? base.businessHoursEnd),
    businessDays: Array.isArray(r.businessDays)
      ? (r.businessDays as number[]).map(Number).filter((n) => n >= 0 && n <= 6)
      : base.businessDays,
    notifyPhone: String(r.notifyPhone ?? ''),
    notifyEmail: String(r.notifyEmail ?? ''),
    languages: Array.isArray(r.languages)
      ? (r.languages as string[]).map(String)
      : base.languages,
    knowledgeBase: String(r.knowledgeBase ?? ''),
    websiteUrl: String(r.websiteUrl ?? ''),
    spamScreening: r.spamScreening !== false,
    bookAppointments: r.bookAppointments !== false,
    urgentKeywords: String(r.urgentKeywords ?? base.urgentKeywords),
    customVoicemail: String(r.customVoicemail ?? ''),
  };
}

export function normalizeReceptionistMessages(raw: unknown): ReceptionistMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row: any, i: number) => {
      if (!row || typeof row !== 'object') return null;
      return {
        id: String(row.id || `msg-${i}`),
        createdAt: String(row.createdAt || new Date().toISOString()),
        callerName: String(row.callerName || 'Unknown'),
        callerPhone: String(row.callerPhone || ''),
        summary: String(row.summary || ''),
        actionItems: Array.isArray(row.actionItems)
          ? row.actionItems.map(String)
          : [],
        transcript: String(row.transcript || ''),
        urgent: !!row.urgent,
        spam: !!row.spam,
        language: String(row.language || 'en'),
        status: (['new', 'read', 'handled'].includes(row.status)
          ? row.status
          : 'new') as ReceptionistMessage['status'],
        source: (['test', 'forwarded', 'manual'].includes(row.source)
          ? row.source
          : 'manual') as ReceptionistMessage['source'],
      } as ReceptionistMessage;
    })
    .filter(Boolean) as ReceptionistMessage[];
}

export function fillGreeting(template: string, company: string): string {
  return (template || '').replace(/\{company\}/gi, company || 'our company');
}

export function isWithinBusinessHours(settings: ReceptionistSettings, now = new Date()): boolean {
  const day = now.getDay();
  if (!settings.businessDays.includes(day)) return false;
  const [sh, sm] = settings.businessHoursStart.split(':').map(Number);
  const [eh, em] = settings.businessHoursEnd.split(':').map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  const start = (sh || 0) * 60 + (sm || 0);
  const end = (eh || 17) * 60 + (em || 0);
  return mins >= start && mins < end;
}
