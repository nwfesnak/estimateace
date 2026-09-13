/**
 * Twilio provisioner for per-contractor AI receptionist numbers (Option B Phase 1).
 * Uses the platform master Twilio account to create a subaccount + buy a local US number.
 */
import type { ReceptionistTwilioPublic, ReceptionistTwilioSecrets } from '@/lib/receptionist-config';

function masterCreds() {
  const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (!accountSid || !authToken) {
    throw new Error(
      'Twilio master credentials missing. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on Vercel.'
    );
  }
  return { accountSid, authToken };
}

function basicAuth(sid: string, token: string) {
  return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
}

async function twilioForm(
  accountSid: string,
  authToken: string,
  path: string,
  method: 'GET' | 'POST' | 'POST_FORM',
  params?: Record<string, string>
): Promise<any> {
  const url = path.startsWith('http')
    ? path
    : `https://api.twilio.com/2010-04-01${path}`;
  const headers: Record<string, string> = {
    Authorization: basicAuth(accountSid, authToken),
  };
  let body: string | undefined;
  if (method !== 'GET' && params) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(params).toString();
  }
  const res = await fetch(url, {
    method: method === 'GET' ? 'GET' : 'POST',
    headers,
    body,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg =
      json?.message ||
      json?.error_message ||
      json?.raw ||
      `Twilio HTTP ${res.status}`;
    throw new Error(String(msg));
  }
  return json;
}

export function getReceptionistWebhookBase(): string {
  const base = (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.VERCEL_URL ||
    'https://app.estimateace.com'
  )
    .trim()
    .replace(/\/$/, '');
  const withProto = base.startsWith('http') ? base : `https://${base}`;
  return withProto;
}

export function receptionistWebhookUrls() {
  const base = getReceptionistWebhookBase();
  return {
    voiceUrl: `${base}/api/webhooks/twilio/voice`,
    smsUrl: `${base}/api/webhooks/twilio/sms`,
    statusCallback: `${base}/api/webhooks/twilio/voice/status`,
  };
}

export type ProvisionResult = {
  twilio: ReceptionistTwilioPublic;
  secrets: ReceptionistTwilioSecrets;
};

/**
 * Create a Twilio subaccount and purchase a US local number with webhook URLs set.
 */
export async function provisionContractorReceptionistLine(input: {
  contractorId: string;
  friendlyName: string;
  areaCode?: string;
}): Promise<ProvisionResult> {
  const { accountSid, authToken } = masterCreds();
  const name = `EA-${String(input.friendlyName || 'Contractor')
    .replace(/[^\w\s-]/g, '')
    .slice(0, 40)}-${input.contractorId.slice(0, 8)}`;

  // 1) Subaccount
  const sub = await twilioForm(accountSid, authToken, '/Accounts.json', 'POST', {
    FriendlyName: name,
  });
  const subSid = String(sub.sid || '');
  const subToken = String(sub.auth_token || '');
  if (!subSid || !subToken) {
    throw new Error('Twilio did not return a subaccount SID/token.');
  }

  // 2) Find an available local number
  const area =
    (input.areaCode || process.env.TWILIO_RECEPTIONIST_AREA_CODE || '').replace(/\D/g, '').slice(0, 3);
  const availPath = area
    ? `/Accounts/${subSid}/AvailablePhoneNumbers/US/Local.json?AreaCode=${area}&PageSize=5`
    : `/Accounts/${subSid}/AvailablePhoneNumbers/US/Local.json?PageSize=5`;
  const available = await twilioForm(subSid, subToken, availPath, 'GET');
  const first = Array.isArray(available.available_phone_numbers)
    ? available.available_phone_numbers[0]
    : null;
  if (!first?.phone_number) {
    throw new Error(
      area
        ? `No Twilio local numbers available in area code ${area}. Try another area code.`
        : 'No Twilio local numbers available. Set TWILIO_RECEPTIONIST_AREA_CODE or check Twilio console.'
    );
  }

  const hooks = receptionistWebhookUrls();

  // 3) Buy number + wire webhooks (same URLs for every contractor; tenant = To number)
  const bought = await twilioForm(subSid, subToken, `/Accounts/${subSid}/IncomingPhoneNumbers.json`, 'POST', {
    PhoneNumber: String(first.phone_number),
    FriendlyName: `EstimateAce AI — ${input.friendlyName || 'Contractor'}`.slice(0, 64),
    VoiceUrl: hooks.voiceUrl,
    VoiceMethod: 'POST',
    StatusCallback: hooks.statusCallback,
    StatusCallbackMethod: 'POST',
    SmsUrl: hooks.smsUrl,
    SmsMethod: 'POST',
  });

  const numberSid = String(bought.sid || '');
  const phoneNumber = String(bought.phone_number || first.phone_number || '');
  if (!numberSid || !phoneNumber) {
    throw new Error('Twilio purchased the number but did not return SID/phone.');
  }

  return {
    twilio: {
      subaccountSid: subSid,
      numberSid,
      phoneNumber,
    },
    secrets: {
      subaccountAuthToken: subToken,
    },
  };
}

/** Close / release number (optional). Soft-disable without release is preferred. */
export async function releaseContractorNumber(input: {
  subaccountSid: string;
  subaccountAuthToken: string;
  numberSid: string;
}): Promise<void> {
  await twilioForm(
    input.subaccountSid,
    input.subaccountAuthToken,
    `/Accounts/${input.subaccountSid}/IncomingPhoneNumbers/${input.numberSid}.json`,
    'POST',
    { Status: 'closed' }
  );
}
