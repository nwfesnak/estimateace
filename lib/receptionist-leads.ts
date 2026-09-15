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

export function formatLeadSummary(parts: {
  name?: string;
  phone?: string;
  address?: string;
  notes?: string;
}): string {
  const lines = [
    parts.name ? `Name: ${parts.name}` : null,
    parts.phone ? `Phone: ${parts.phone}` : null,
    parts.address ? `Address: ${parts.address}` : null,
    parts.notes ? `Notes: ${parts.notes}` : null,
  ].filter(Boolean);
  return lines.join('\n') || 'New lead';
}

export async function appendReceptionistLead(input: {
  userId: string;
  callerName?: string;
  callerPhone?: string;
  address?: string;
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

  const name = String(input.callerName || 'Unknown').slice(0, 120);
  const phone = String(input.callerPhone || '').slice(0, 40);
  const address = String(input.address || '').slice(0, 200);
  const summaryBody = String(input.summary || '').trim();
  const summary =
    summaryBody.includes('Name:') || summaryBody.includes('Phone:')
      ? summaryBody.slice(0, 2000)
      : formatLeadSummary({
          name,
          phone,
          address,
          notes: summaryBody,
        }).slice(0, 2000);

  const msg: ReceptionistMessage = {
    id: `lead-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    callerName: name,
    callerPhone: phone,
    summary,
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
