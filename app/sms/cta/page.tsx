import Link from 'next/link';
import {
  SMS_KEYWORD_CONFIRM,
  SMS_KEYWORD_HELP,
  SMS_KEYWORD_OPT_IN,
  SMS_KEYWORD_STOP,
  formatSmsNumberDisplay,
  getSmsOptInNumber,
  privacyPolicyUrl,
  termsUrl,
} from '@/lib/sms-compliance';

export const metadata = {
  title: 'Text START to opt in | EstimateAce SMS',
  description:
    'Public call-to-action: text START to EstimateAce to opt in to transactional SMS reminders and job notices.',
};

/**
 * Public opt-in CALL-TO-ACTION page for Twilio A2P reviewers.
 * Paste https://app.estimateace.com/sms/cta into Message Flow as evidence of text opt-in CTA.
 * Screenshot this page if Twilio asks for a hosted image.
 */
export default function SmsCtaPage() {
  const number = formatSmsNumberDisplay(getSmsOptInNumber());

  return (
    <main className="min-h-screen bg-[#ecfdf5] text-[#0f172a] flex items-center">
      <div className="max-w-lg mx-auto px-4 py-16 w-full">
        <div className="rounded-2xl border-4 border-emerald-700 bg-white shadow-xl p-8 text-center space-y-5">
          <p className="text-sm font-bold uppercase tracking-widest text-emerald-800">
            EstimateAce SMS
          </p>
          <h1 className="text-3xl sm:text-4xl font-black leading-tight">
            Opt in to text alerts
          </h1>
          <p className="text-slate-600 text-sm">
            Appointment reminders · estimate &amp; invoice notices · recurring approvals · account
            alerts
          </p>

          <div className="rounded-xl bg-emerald-700 text-white py-6 px-4 space-y-2">
            <p className="text-lg font-semibold">Text this keyword</p>
            <p className="text-5xl font-black tracking-wide">{SMS_KEYWORD_OPT_IN}</p>
            <p className="text-lg font-semibold pt-2">to this number</p>
            <p className="text-3xl sm:text-4xl font-black whitespace-nowrap">{number}</p>
          </div>

          <div className="text-left text-sm text-slate-700 space-y-2 border rounded-xl p-4 bg-slate-50">
            <p>
              <strong>What happens next:</strong> You receive a welcome text. Reply{' '}
              <strong>{SMS_KEYWORD_CONFIRM}</strong> to confirm. Then you get a confirmation message.
            </p>
            <p>
              <strong>Message frequency:</strong> varies (typically a few messages per week when
              active).
            </p>
            <p>
              <strong>Message and data rates may apply.</strong>
            </p>
            <p>
              Reply <strong>{SMS_KEYWORD_STOP}</strong> to opt out ·{' '}
              <strong>{SMS_KEYWORD_HELP}</strong> for help
            </p>
            <p>
              <a className="text-emerald-700 underline" href={termsUrl()}>
                Terms
              </a>
              {' · '}
              <a className="text-emerald-700 underline" href={privacyPolicyUrl()}>
                Privacy
              </a>
            </p>
          </div>

          <p className="text-xs text-slate-500">
            Also opt in online:{' '}
            <Link href="/sms" className="text-emerald-700 underline">
              app.estimateace.com/sms
            </Link>
          </p>
        </div>

        <p className="text-center text-[11px] text-slate-500 mt-6">
          Twilio reviewers: this page is the public call-to-action for texting{' '}
          {SMS_KEYWORD_OPT_IN} to {getSmsOptInNumber()}. Full flow:{' '}
          <Link href="/sms/message-flow" className="underline">
            /sms/message-flow
          </Link>
        </p>
      </div>
    </main>
  );
}
