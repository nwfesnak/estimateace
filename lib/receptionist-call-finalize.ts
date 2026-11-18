/**
 * End-of-call processing for the AI receptionist.
 *
 * Exactly one lead (and at most one owner SMS/email) per CallSid, created when the
 * call ends — from the Twilio status callback, or right after the final goodbye turn.
 * Silent / near-silent calls and calls that never passed the press-1 gate create
 * nothing. With Spam screening on, the AI labels spam/sales/robocalls; those leads are
 * stored as spam and the owner is not notified.
 */
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  loadCallSession,
  saveCallSession,
  transcriptToText,
} from '@/lib/receptionist-call-session';
import { summarizeVoiceCall } from '@/lib/receptionist-voice-agent';
import { appendReceptionistLead } from '@/lib/receptionist-leads';
import { countCallerWords, detectSpamHeuristic, MIN_CALLER_WORDS } from '@/lib/receptionist-spam';

const LEDGER = 'receptionist_call_finalizations';

export type FinalizeOutcome =
  | 'no_session'
  | 'already_finalized'
  | 'gate_not_passed'
  | 'silent'
  | 'lead'
  | 'spam'
  | 'error';

export function callLeadId(callSid: string) {
  return `call-${String(callSid || '').slice(0, 64)}`;
}

/** Claim the CallSid. false = someone else already finalized (or is finalizing) it. */
async function claimCall(callSid: string, userId: string, trigger: string): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) return true;
  const { error } = await admin
    .from(LEDGER)
    .insert({ call_sid: callSid, user_id: userId || null, outcome: 'pending', trigger });
  if (!error) return true;
  if (error.code === '23505') return false; // duplicate key → already claimed
  // Ledger missing (migration not applied yet) or transient error: fall back to the
  // session flag + stable lead id, which still prevent duplicate leads.
  console.warn('receptionist finalize claim (fallback):', error.code, error.message);
  return true;
}

async function recordOutcome(callSid: string, patch: Record<string, unknown>) {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  try {
    await admin
      .from(LEDGER)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('call_sid', callSid);
  } catch (e) {
    console.warn('receptionist finalize record:', e);
  }
}

export async function finalizeReceptionistCall(
  callSid: string,
  trigger: 'status_callback' | 'final_turn'
): Promise<FinalizeOutcome> {
  const sid = String(callSid || '').trim();
  if (!sid) return 'no_session';
  const session = await loadCallSession(sid);
  if (!session) return 'no_session';
  if (session.finalizedAt) return 'already_finalized';

  const claimed = await claimCall(sid, session.userId, trigger);
  if (!claimed) return 'already_finalized';

  // Mark early so a concurrent trigger without the ledger also stops here.
  session.finalizedAt = new Date().toISOString();
  try {
    await saveCallSession(session);
  } catch (e) {
    console.warn('receptionist finalize mark session:', e);
  }

  const words = countCallerWords(session.transcript || []);

  if (session.gateRequired && !session.gatePassed) {
    await recordOutcome(sid, { outcome: 'gate_not_passed', caller_words: words });
    console.info('receptionist call finalized', { callSid: sid, outcome: 'gate_not_passed' });
    return 'gate_not_passed';
  }

  if (words < MIN_CALLER_WORDS) {
    await recordOutcome(sid, { outcome: 'silent', caller_words: words });
    console.info('receptionist call finalized', { callSid: sid, outcome: 'silent', words });
    return 'silent';
  }

  try {
    const screening = session.spamScreening !== false;
    const summary = await summarizeVoiceCall({
      businessName: session.businessName,
      transcript: session.transcript,
      callerPhone: session.from,
      urgentKeywords: session.urgentKeywords,
      collectedName: session.collectedName,
      collectedPhone: session.collectedPhone,
      collectedAddress: session.collectedAddress,
      classifySpam: screening,
    });

    let isSpam = false;
    let spamReason = '';
    if (screening) {
      if (summary.isSpam === null) {
        // AI unavailable → keyword backstop only
        const h = detectSpamHeuristic(session.transcript);
        isSpam = h.isSpam;
        spamReason = h.reason;
      } else {
        isSpam = summary.isSpam;
        spamReason = summary.spamReason;
      }
    }

    const name = summary.callerName || session.collectedName || 'Unknown';
    const phone = summary.callerPhone || session.collectedPhone || session.from;
    const address = summary.address || session.collectedAddress || '';
    const notes = [
      summary.summary || session.collectedNotes || '',
      session.smsOk === true ? 'SMS OK: yes' : session.smsOk === false ? 'SMS OK: no' : '',
    ]
      .filter(Boolean)
      .join(' | ');

    const lead = await appendReceptionistLead({
      id: callLeadId(sid),
      callSid: sid,
      fromNumber: session.from,
      userId: session.userId,
      callerName: name,
      callerPhone: phone,
      address,
      summary: [
        `Name: ${name}`,
        `Phone: ${phone}`,
        address ? `Address: ${address}` : null,
        notes ? `Notes: ${notes}` : null,
        isSpam ? `Spam: ${spamReason || 'flagged by spam screening'}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      actionItems: isSpam
        ? ['Likely spam — no follow-up needed. Use “Mark as spam” to block this number.']
        : summary.actionItems?.length
          ? summary.actionItems
          : ['Follow up with caller'],
      transcript: transcriptToText(session.transcript),
      urgent: isSpam ? false : summary.urgent,
      language: summary.language,
      source: 'voice',
      spam: isSpam,
      spamReason,
      notify: !isSpam,
    });

    const outcome: FinalizeOutcome = isSpam ? 'spam' : 'lead';
    await recordOutcome(sid, {
      outcome,
      lead_id: lead?.id || null,
      is_spam: isSpam,
      spam_reason: spamReason || null,
      caller_words: words,
      notified: Boolean(lead?.notified),
    });
    console.info('receptionist call finalized', { callSid: sid, outcome, words, trigger });
    return outcome;
  } catch (e) {
    console.warn('receptionist finalize:', e);
    await recordOutcome(sid, { outcome: 'error', caller_words: words });
    return 'error';
  }
}
