/**
 * Per-contractor Twilio AI Receptionist config (Option B — Phase 1).
 * Public fields may live on SETTINGS for UI; secrets stay server-only.
 */

export type WeeklyHours = {
  /** 0=Sun … 6=Sat — open windows as "HH:MM-HH:MM" or null if closed */
  [day: number]: string | null;
};

export type ReceptionistTwilioPublic = {
  subaccountSid: string;
  numberSid: string;
  phoneNumber: string; // E.164
};

export type ReceptionistConfig = {
  contractorId: string;
  enabled: boolean;
  status: 'none' | 'active' | 'pending_port' | 'disabled' | 'error';
  twilio: ReceptionistTwilioPublic | null;
  branding: {
    businessName: string;
    greeting: string;
  };
  services: string[];
  serviceArea: string;
  hours: { timezone: string; weekly: WeeklyHours };
  transferNumber?: string;
  afterHours: 'voicemail' | 'transfer' | 'ai';
  leadDestination: 'estimateace_lead';
  provisionError?: string;
  updatedAt?: string;
};

/** Server-only secrets — never send to the browser */
export type ReceptionistTwilioSecrets = {
  subaccountAuthToken: string;
};

export const DEFAULT_RECEPTIONIST_CONFIG = (
  contractorId: string,
  businessName = ''
): ReceptionistConfig => ({
  contractorId,
  enabled: false,
  status: 'none',
  twilio: null,
  branding: {
    businessName: businessName || 'Your Company',
    greeting: '',
  },
  services: [],
  serviceArea: '',
  hours: {
    timezone: 'America/New_York',
    weekly: {
      0: null,
      1: '08:00-17:00',
      2: '08:00-17:00',
      3: '08:00-17:00',
      4: '08:00-17:00',
      5: '08:00-17:00',
      6: null,
    },
  },
  transferNumber: '',
  afterHours: 'ai',
  leadDestination: 'estimateace_lead',
});

export function normalizeReceptionistConfig(
  raw: unknown,
  contractorId: string,
  businessName = ''
): ReceptionistConfig {
  const base = DEFAULT_RECEPTIONIST_CONFIG(contractorId, businessName);
  const r = raw && typeof raw === 'object' ? (raw as any) : {};
  const tw = r.twilio && typeof r.twilio === 'object' ? r.twilio : null;
  return {
    ...base,
    ...r,
    contractorId: String(r.contractorId || contractorId),
    enabled: r.enabled === true,
    status: (['none', 'active', 'pending_port', 'disabled', 'error'].includes(r.status)
      ? r.status
      : tw?.phoneNumber
        ? 'active'
        : 'none') as ReceptionistConfig['status'],
    twilio: tw
      ? {
          subaccountSid: String(tw.subaccountSid || ''),
          numberSid: String(tw.numberSid || ''),
          phoneNumber: String(tw.phoneNumber || ''),
        }
      : null,
    branding: {
      businessName: String(r.branding?.businessName || businessName || base.branding.businessName),
      greeting: String(r.branding?.greeting || ''),
    },
    services: Array.isArray(r.services) ? r.services.map(String).slice(0, 40) : [],
    serviceArea: String(r.serviceArea || ''),
    hours: {
      timezone: String(r.hours?.timezone || base.hours.timezone),
      weekly: { ...base.hours.weekly, ...(r.hours?.weekly || {}) },
    },
    transferNumber: String(r.transferNumber || ''),
    afterHours: (['voicemail', 'transfer', 'ai'].includes(r.afterHours)
      ? r.afterHours
      : 'ai') as ReceptionistConfig['afterHours'],
    leadDestination: 'estimateace_lead',
    provisionError: r.provisionError ? String(r.provisionError) : undefined,
    updatedAt: r.updatedAt ? String(r.updatedAt) : undefined,
  };
}

/** Public payload for GET /api/receptionist — never includes auth tokens */
export function toPublicReceptionistConfig(config: ReceptionistConfig) {
  return {
    contractorId: config.contractorId,
    enabled: config.enabled,
    status: config.status,
    twilio: config.twilio,
    phoneNumber: config.twilio?.phoneNumber || null,
    branding: config.branding,
    services: config.services,
    serviceArea: config.serviceArea,
    hours: config.hours,
    transferNumber: config.transferNumber || '',
    afterHours: config.afterHours,
    leadDestination: config.leadDestination,
    provisionError: config.provisionError || null,
    updatedAt: config.updatedAt || null,
  };
}

export const RECEPTIONIST_SECRETS_ROW_PREFIX = 'RECEPTIONIST-SECRETS-';

export function receptionistSecretsRowId(userId: string) {
  return `${RECEPTIONIST_SECRETS_ROW_PREFIX}${userId}`;
}
