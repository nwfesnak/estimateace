/**
 * Shared SMS / A2P compliance copy and helpers for EstimateAce.
 */
export const SMS_KEYWORD_OPT_IN = 'START';
export const SMS_KEYWORD_CONFIRM = 'YES';
export const SMS_KEYWORD_STOP = 'STOP';
export const SMS_KEYWORD_HELP = 'HELP';

/** Public site base for compliance links (Twilio Message Flow field). */
export function getPublicSiteUrl(): string {
  const fromEnv = (process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  return 'https://app.estimateace.com';
}

/** Long code / toll-free customers text to opt in. */
export function getSmsOptInNumber(): string {
  const n = (process.env.NEXT_PUBLIC_SMS_OPT_IN_NUMBER || process.env.TWILIO_PHONE_NUMBER || '+18559169529')
    .trim()
    .replace(/\s+/g, '');
  return n.startsWith('+') ? n : n.replace(/\D/g, '').length === 10 ? `+1${n.replace(/\D/g, '')}` : n;
}

export function formatSmsNumberDisplay(e164: string): string {
  const d = e164.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) {
    return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return e164;
}

export function privacyPolicyUrl(): string {
  return `${getPublicSiteUrl()}/privacy`;
}

export function termsUrl(): string {
  return `${getPublicSiteUrl()}/terms`;
}

export function smsOptInPageUrl(): string {
  return `${getPublicSiteUrl()}/sms`;
}

export function smsMessageFlowUrl(): string {
  return `${getPublicSiteUrl()}/sms/message-flow`;
}

/** Twilio "How do end-users consent…" Message Flow field (under 2048 chars). */
export function buildTwilioMessageFlowDescription(): string {
  const num = formatSmsNumberDisplay(getSmsOptInNumber());
  const site = getPublicSiteUrl();
  return (
    `End users opt-in by visiting ${site}/sms and adding their mobile phone number, then checking a box agreeing to receive transactional text messages from EstimateAce (appointment reminders, estimate/invoice notices, recurring-service approvals, and account alerts). ` +
    `They then submit the form and receive a confirmation text. ` +
    `Additionally, end users can opt-in by texting ${SMS_KEYWORD_OPT_IN} to ${num}; we reply with a welcome message and ask them to reply ${SMS_KEYWORD_CONFIRM} to confirm. ` +
    `After ${SMS_KEYWORD_CONFIRM}, they receive a final confirmation message. ` +
    `Message frequency varies (typically a few messages per week when active). Message and data rates may apply. ` +
    `Reply ${SMS_KEYWORD_STOP} to opt out, ${SMS_KEYWORD_HELP} for help. ` +
    `Terms and Conditions: ${site}/terms. Privacy Policy: ${site}/privacy. ` +
    `Campaign collateral / message flow screenshot page: ${site}/sms/message-flow.`
  );
}

export function welcomeSms(companyLabel = 'EstimateAce'): string {
  const num = formatSmsNumberDisplay(getSmsOptInNumber());
  return (
    `${companyLabel}: Thanks for your interest in SMS alerts (appointments, estimates/invoices, recurring approvals). ` +
    `Msg frequency varies. Msg & data rates may apply. ` +
    `Reply ${SMS_KEYWORD_CONFIRM} to confirm opt-in. Reply ${SMS_KEYWORD_STOP} to cancel, ${SMS_KEYWORD_HELP} for help. ` +
    `Terms ${termsUrl()} Privacy ${privacyPolicyUrl()}`
  ).slice(0, 1600);
}

export function confirmRequestSms(): string {
  return (
    `EstimateAce: Please reply ${SMS_KEYWORD_CONFIRM} to finish opting in to transactional texts. ` +
    `Msg & data rates may apply. ${SMS_KEYWORD_STOP} to cancel. Terms ${termsUrl()}`
  ).slice(0, 1600);
}

export function confirmationSms(companyLabel = 'EstimateAce'): string {
  return (
    `${companyLabel}: You're confirmed for transactional SMS (reminders & job notices). ` +
    `Msg frequency varies. Msg & data rates may apply. ` +
    `Reply ${SMS_KEYWORD_STOP} to opt out, ${SMS_KEYWORD_HELP} for help. ` +
    `Privacy ${privacyPolicyUrl()}`
  ).slice(0, 1600);
}

export function helpSms(): string {
  return (
    `EstimateAce Help: Transactional SMS for appointments, estimates/invoices & account alerts. ` +
    `Msg & data rates may apply. Reply ${SMS_KEYWORD_STOP} to opt out. Support: support@estimateace.com ` +
    `Privacy ${privacyPolicyUrl()} Terms ${termsUrl()}`
  ).slice(0, 1600);
}

export function stopSms(): string {
  return `EstimateAce: You are opted out of SMS. No more texts will be sent. Reply ${SMS_KEYWORD_OPT_IN} to opt in again.`.slice(
    0,
    1600
  );
}
