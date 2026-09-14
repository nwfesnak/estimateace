/**
 * Live voice call sessions (CallSid → transcript + contractor).
 * Stored via service role so Gather webhooks work across serverless instances.
 */
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export type CallTurn = { role: 'agent' | 'caller'; text: string };

export type ReceptionistCallSession = {
  callSid: string;
  userId: string;
  from: string;
  to: string;
  businessName: string;
  transferNumber: string;
  knowledgeBase: string;
  greeting: string;
  urgentKeywords: string;
  languages: string[];
  transcript: CallTurn[];
  leadIds: string[];
  turn: number;
  /** Stashed SpeechResult while we ack Twilio quickly, then /think runs Grok */
  pendingCallerText?: string;
  emptyListenCount?: number;
  createdAt: string;
  updatedAt: string;
};

function sessionRowId(callSid: string) {
  return `CALL-${String(callSid || '').slice(0, 64)}`;
}

export async function loadCallSession(callSid: string): Promise<ReceptionistCallSession | null> {
  const admin = getSupabaseAdmin();
  if (!admin || !callSid) return null;
  const { data } = await admin
    .from('estimates')
    .select('profile')
    .eq('id', sessionRowId(callSid))
    .maybeSingle();
  const p = data?.profile;
  if (!p || typeof p !== 'object') return null;
  return p as ReceptionistCallSession;
}

export async function saveCallSession(session: ReceptionistCallSession): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  const now = new Date().toISOString();
  const next = { ...session, updatedAt: now };
  await admin.from('estimates').upsert({
    id: sessionRowId(session.callSid),
    user_id: session.userId,
    jobName: '__receptionist_call__',
    documentType: 'settings',
    items: [],
    profile: next,
    updated_at: now,
  });
}

export async function deleteCallSession(callSid: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin || !callSid) return;
  await admin.from('estimates').delete().eq('id', sessionRowId(callSid));
}

export function transcriptToText(turns: CallTurn[]): string {
  return (turns || [])
    .map((t) => `${t.role === 'agent' ? 'Receptionist' : 'Caller'}: ${t.text}`)
    .join('\n');
}
