/**
 * Live voice call sessions (CallSid → transcript + contractor).
 * Stored via service role so Gather webhooks work across serverless instances.
 */
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export type CallTurn = { role: 'agent' | 'caller'; text: string };

/** Staged receptionist script order */
export type CallStage =
  | 'need'
  | 'name'
  | 'phone'
  | 'anything_else'
  | 'techs_sms'
  | 'thanks';

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
  /** Contact fields collected during the staged script */
  collectedName?: string;
  collectedPhone?: string;
  collectedAddress?: string;
  collectedNotes?: string;
  /** Current position in the staged call script */
  callStage?: CallStage;
  /** Whether caller consented to SMS (set after techs_sms reply) */
  smsOk?: boolean;
  /** Stashed SpeechResult while we ack Twilio quickly, then /think runs */
  pendingCallerText?: string;
  emptyListenCount?: number;
  createdAt: string;
  updatedAt: string;
};

/** Legacy: name + phone + address (address no longer required to end). */
export function contactComplete(session: {
  collectedName?: string;
  collectedPhone?: string;
  collectedAddress?: string;
}): boolean {
  return Boolean(
    String(session.collectedName || '').trim() &&
      String(session.collectedPhone || '').trim() &&
      String(session.collectedAddress || '').trim()
  );
}

/**
 * Script is complete when we have need + name + phone and have asked/received SMS preference.
 * Address is NOT required to end the call.
 */
export function scriptComplete(session: {
  collectedName?: string;
  collectedPhone?: string;
  collectedNotes?: string;
  smsOk?: boolean;
  callStage?: CallStage | string;
}): boolean {
  const hasNeed = Boolean(String(session.collectedNotes || '').trim());
  const hasName = Boolean(String(session.collectedName || '').trim());
  const hasPhone = Boolean(String(session.collectedPhone || '').trim());
  const smsAsked = session.smsOk === true || session.smsOk === false;
  const atThanks = session.callStage === 'thanks';
  return hasNeed && hasName && hasPhone && (smsAsked || atThanks);
}

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
