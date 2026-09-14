/**
 * Load / save ReceptionistConfig + secrets via Supabase admin (service role).
 */
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  normalizeReceptionistConfig,
  receptionistSecretsRowId,
  type ReceptionistConfig,
  type ReceptionistTwilioSecrets,
  toPublicReceptionistConfig,
} from '@/lib/receptionist-config';

function settingsId(userId: string) {
  return `SETTINGS-${userId}`;
}

export async function loadReceptionistSecretsRow(userId: string): Promise<{
  secrets: ReceptionistTwilioSecrets | null;
  phoneNumber: string;
  subaccountSid: string;
  numberSid: string;
} | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data } = await admin
    .from('estimates')
    .select('profile')
    .eq('id', receptionistSecretsRowId(userId))
    .maybeSingle();
  const p = (data?.profile || {}) as any;
  const token = String(p.subaccountAuthToken || '').trim();
  return {
    secrets: token ? { subaccountAuthToken: token } : null,
    phoneNumber: String(p.phoneNumber || '').trim(),
    subaccountSid: String(p.subaccountSid || '').trim(),
    numberSid: String(p.numberSid || '').trim(),
  };
}

export async function loadReceptionistConfig(
  userId: string,
  businessName = ''
): Promise<ReceptionistConfig> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return normalizeReceptionistConfig(null, userId, businessName);
  }
  const { data } = await admin
    .from('estimates')
    .select('profile')
    .eq('id', settingsId(userId))
    .maybeSingle();
  const profile = (data?.profile || {}) as any;
  let config = normalizeReceptionistConfig(profile.receptionistConfig, userId, businessName);

  // Recover Twilio line from secrets row if SETTINGS config was wiped by a profile save
  if (!config.twilio?.phoneNumber) {
    const secretsRow = await loadReceptionistSecretsRow(userId);
    if (secretsRow?.phoneNumber) {
      config = normalizeReceptionistConfig(
        {
          ...config,
          status: config.status === 'none' ? 'active' : config.status,
          twilio: {
            subaccountSid: secretsRow.subaccountSid || config.twilio?.subaccountSid || '',
            numberSid: secretsRow.numberSid || config.twilio?.numberSid || '',
            phoneNumber: secretsRow.phoneNumber,
          },
        },
        userId,
        businessName
      );
      // Heal SETTINGS so UI stops asking to enable again
      try {
        await saveReceptionistConfig(userId, { ...config, status: 'active' });
      } catch (e) {
        console.warn('heal receptionistConfig from secrets:', e);
      }
    }
  }

  return config;
}

export async function loadReceptionistSecrets(
  userId: string
): Promise<ReceptionistTwilioSecrets | null> {
  const row = await loadReceptionistSecretsRow(userId);
  return row?.secrets || null;
}

export async function saveReceptionistConfig(
  userId: string,
  config: ReceptionistConfig,
  secrets?: ReceptionistTwilioSecrets | null
): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server missing SUPABASE_SERVICE_ROLE_KEY.');

  const sid = settingsId(userId);
  const { data: existing } = await admin.from('estimates').select('profile').eq('id', sid).maybeSingle();
  const prev = (existing?.profile && typeof existing.profile === 'object' ? existing.profile : {}) as any;

  const nextConfig: ReceptionistConfig = {
    ...config,
    updatedAt: new Date().toISOString(),
  };

  // Public config on SETTINGS (safe for client profile load — no auth token)
  const { error } = await admin.from('estimates').upsert({
    id: sid,
    user_id: userId,
    jobName: '__settings__',
    documentType: 'settings',
    items: [],
    profile: {
      ...prev,
      receptionistConfig: nextConfig,
      // Convenience for dashboard / addon gating
      aiReceptionistAddonActive:
        nextConfig.status === 'active' && nextConfig.enabled
          ? true
          : prev.aiReceptionistAddonActive === true,
    },
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);

  if (secrets?.subaccountAuthToken) {
    const secretsId = receptionistSecretsRowId(userId);
    await admin.from('estimates').upsert({
      id: secretsId,
      user_id: userId,
      jobName: '__receptionist_secrets__',
      documentType: 'settings',
      items: [],
      profile: {
        subaccountAuthToken: secrets.subaccountAuthToken,
        subaccountSid: nextConfig.twilio?.subaccountSid || '',
        numberSid: nextConfig.twilio?.numberSid || '',
        phoneNumber: nextConfig.twilio?.phoneNumber || '',
        updatedAt: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    });
  }
}

/** Resolve contractor by Twilio To number (E.164). Used by webhooks. */
export async function findReceptionistByPhoneNumber(
  toNumber: string
): Promise<{ userId: string; config: ReceptionistConfig } | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const want = String(toNumber || '').replace(/\s/g, '');
  if (!want) return null;

  // Scan SETTINGS rows that have receptionistConfig (bounded — improve with index later)
  const { data, error } = await admin
    .from('estimates')
    .select('id, user_id, profile')
    .like('id', 'SETTINGS-%')
    .limit(2000);
  if (error || !data) return null;

  for (const row of data) {
    const cfg = normalizeReceptionistConfig((row.profile as any)?.receptionistConfig, row.user_id);
    const phone = cfg.twilio?.phoneNumber || '';
    if (phone && (phone === want || phone.replace(/\D/g, '') === want.replace(/\D/g, ''))) {
      return { userId: row.user_id, config: cfg };
    }
  }
  return null;
}

export { toPublicReceptionistConfig };
