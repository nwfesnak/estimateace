/**
 * Write voice/SMS leads into the contractor's AI Receptionist inbox
 * (SETTINGS profile.aiReceptionistMessages → dashboard Leads).
 */
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import type { ReceptionistMessage } from '@/lib/ai-receptionist';
import { sendEmailNotification, sendSmsNotification, formatPhoneE164 } from '@/lib/notifications';

function settingsId(userId: string) {
  return `SETTINGS-${userId}`;
}

export async function appendReceptionistLead(input: {
  userId: string;
  callerName?: string;
  callerPhone?: string;
  summary: string;
  actionItems?: string[];
  transcript?: string;
  urgent?: boolean;
  language?: string;
  source?: ReceptionistMessage['source'];
}): Promise<ReceptionistMessage | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const sid = settingsId(input.userId);
  const { data } = await admin.from('estimates').select('profile').eq('id', sid).maybeSingle();
  const profile = (data?.profile && typeof data.profile === 'object' ? data.profile : {}) as any;
  const messages: ReceptionistMessage[] = Array.isArray(profile.aiReceptionistMessages)
    ? profile.aiReceptionistMessages
    : [];

  const msg: ReceptionistMessage = {
    id: `lead-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    callerName: String(input.callerName || 'Unknown').slice(0, 120),
    callerPhone: String(input.callerPhone || '').slice(0, 40),
    summary: String(input.summary || 'New lead').slice(0, 2000),
    actionItems: (input.actionItems || []).map(String).slice(0, 8),
    transcript: String(input.transcript || '').slice(0, 20000),
    urgent: Boolean(input.urgent),
    spam: false,
    language: String(input.language || 'en').slice(0, 12),
    status: 'new',
    source: input.source || 'forwarded',
  };

  await admin.from('estimates').upsert({
    id: sid,
    user_id: input.userId,
    jobName: '__settings__',
    documentType: 'settings',
    items: [],
    profile: {
      ...profile,
      aiReceptionistMessages: [msg, ...messages].slice(0, 200),
    },
    updated_at: new Date().toISOString(),
  });

  // Best-effort owner notify
  try {
    const notifyPhone = String(profile.aiReceptionist?.notifyPhone || profile.phone || '').trim();
    const notifyEmail = String(profile.aiReceptionist?.notifyEmail || profile.email || '').trim();
    const company = String(profile.company || 'EstimateAce');
    const smsBody = `EstimateAce lead${msg.urgent ? ' (URGENT)' : ''}: ${msg.callerName} ${msg.callerPhone} — ${msg.summary}`.slice(
      0,
      320
    );
    if (notifyPhone && formatPhoneE164(notifyPhone)) {
      await sendSmsNotification(notifyPhone, smsBody, { skipOptInCheck: true });
    }
    if (notifyEmail && notifyEmail.includes('@')) {
      await sendEmailNotification(
        notifyEmail,
        `${msg.urgent ? '[URGENT] ' : ''}New AI Receptionist lead — ${company}`,
        `${msg.summary}\n\nCaller: ${msg.callerName}\nPhone: ${msg.callerPhone}\n\n${msg.transcript || ''}`.slice(
          0,
          4000
        ),
        { companyName: company }
      );
    }
  } catch (e) {
    console.warn('appendReceptionistLead notify:', e);
  }

  return msg;
}
