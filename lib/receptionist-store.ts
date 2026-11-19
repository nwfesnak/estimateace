/**
 * Load / save ReceptionistConfig via Supabase admin (service role).
 *
 * Trust model:
 *   - Business settings (greeting, hours, services, …) live in the user's
 *     SETTINGS-<uid> row (user-editable, that's fine).
 *   - The Twilio line, its secrets and the add-on entitlement live in the
 *     server-only receptionist_accounts table (lib/receptionist-private.ts).
 *     Whatever `twilio` value sits in SETTINGS is display-only and is always
 *     replaced by the server copy when loading.
 */
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  normalizeReceptionistConfig,
  type ReceptionistConfig,
  type ReceptionistTwilioSecrets,
  toPublicReceptionistConfig,
} from '@/lib/receptionist-config';
import {
  findReceptionistUserIdByPhone,
  loadReceptionistPrivate,
  saveReceptionistLinePrivate,
} from '@/lib/receptionist-private';

function settingsId(userId: string) {
  return `SETTINGS-${userId}`;
}

export async function loadReceptionistSecretsRow(userId: string): Promise<{
  secrets: ReceptionistTwilioSecrets | null;
  phoneNumber: string;
  subaccountSid: string;
  numberSid: string;
} | null> {
  const row = await loadReceptionistPrivate(userId);
  if (!row) return null;
  return {
    secrets: row.subaccountAuthToken ? { subaccountAuthToken: row.subaccountAuthToken } : null,
    phoneNumber: row.line?.phoneNumber || '',
    subaccountSid: row.line?.subaccountSid || '',
    numberSid: row.line?.numberSid || '',
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
  const [{ data }, priv] = await Promise.all([
    admin.from('estimates').select('profile').eq('id', settingsId(userId)).maybeSingle(),
    loadReceptionistPrivate(userId),
  ]);
  const profile = (data?.profile || {}) as any;
  const config = normalizeReceptionistConfig(profile.receptionistConfig, userId, businessName);

  // The provisioned line always comes from server-only storage, never from SETTINGS.
  const line = priv?.line || null;
  return normalizeReceptionistConfig(
    {
      ...config,
      status: line ? (config.status === 'none' ? 'active' : config.status) : config.status === 'error' ? 'error' : 'none',
      enabled: line ? config.enabled : false,
      twilio: line
        ? {
            subaccountSid: line.subaccountSid,
            numberSid: line.numberSid,
            phoneNumber: line.phoneNumber,
          }
        : null,
    },
    userId,
    businessName
  );
}

export async function loadReceptionistSecrets(
  userId: string
): Promise<ReceptionistTwilioSecrets | null> {
  const row = await loadReceptionistSecretsRow(userId);
  return row?.secrets || null;
}

/**
 * Save business settings to SETTINGS (display copy).
 *
 * The Twilio line is only written to server-only storage when `secrets` is passed
 * (fresh provisioning) or when `opts.line` is set explicitly (enable/disable/release).
 */
export async function saveReceptionistConfig(
  userId: string,
  config: ReceptionistConfig,
  secrets?: ReceptionistTwilioSecrets | null,
  opts?: { line?: 'set' | 'clear' }
): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server missing SUPABASE_SERVICE_ROLE_KEY.');

  if (secrets?.subaccountAuthToken && config.twilio?.phoneNumber) {
    await saveReceptionistLinePrivate(
      userId,
      {
        phoneNumber: config.twilio.phoneNumber,
        subaccountSid: config.twilio.subaccountSid || '',
        numberSid: config.twilio.numberSid || '',
      },
      secrets.subaccountAuthToken
    );
  } else if (opts?.line === 'clear') {
    await saveReceptionistLinePrivate(userId, null, null);
  } else if (opts?.line === 'set' && config.twilio?.phoneNumber) {
    await saveReceptionistLinePrivate(userId, {
      phoneNumber: config.twilio.phoneNumber,
      subaccountSid: config.twilio.subaccountSid || '',
      numberSid: config.twilio.numberSid || '',
    });
  }

  const sid = settingsId(userId);
  const { data: existing } = await admin.from('estimates').select('profile').eq('id', sid).maybeSingle();
  const prev = (existing?.profile && typeof existing.profile === 'object' ? existing.profile : {}) as any;

  const nextConfig: ReceptionistConfig = {
    ...config,
    updatedAt: new Date().toISOString(),
  };

  // Display copy on SETTINGS (safe for client profile load — never holds a token).
  const { error } = await admin.from('estimates').upsert({
    id: sid,
    user_id: userId,
    jobName: '__settings__',
    documentType: 'settings',
    items: [],
    profile: {
      ...prev,
      receptionistConfig: nextConfig,
    },
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

/** Resolve contractor by Twilio To number (E.164). Used by webhooks. */
export async function findReceptionistByPhoneNumber(
  toNumber: string
): Promise<{ userId: string; config: ReceptionistConfig } | null> {
  const userId = await findReceptionistUserIdByPhone(toNumber);
  if (!userId) return null;
  const config = await loadReceptionistConfig(userId);
  return { userId, config };
}

export { toPublicReceptionistConfig };
