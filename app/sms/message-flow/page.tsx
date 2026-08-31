import Link from 'next/link';
import {
  SMS_KEYWORD_CONFIRM,
  SMS_KEYWORD_HELP,
  SMS_KEYWORD_OPT_IN,
  SMS_KEYWORD_STOP,
  buildTwilioMessageFlowDescription,
  confirmationSms,
  formatSmsNumberDisplay,
  getSmsOptInNumber,
  helpSms,
  privacyPolicyUrl,
  smsCtaUrl,
  smsOptInPageUrl,
  stopSms,
  termsUrl,
  welcomeSms,
} from '@/lib/sms-compliance';

export const metadata = {
  title: 'SMS Message Flow | EstimateAce',
  description:
    'EstimateAce SMS opt-in message flow and campaign collateral for Twilio A2P / toll-free verification.',
};

/**
 * Public campaign collateral page for Twilio "Message Flow" field.
 * Hosted at https://app.estimateace.com/sms/message-flow
 * (screenshot this page or paste the URL directly into Twilio).
 */
export default function SmsMessageFlowPage() {
  const number = formatSmsNumberDisplay(getSmsOptInNumber());
  const flow = buildTwilioMessageFlowDescription();

  return (
    <main className="min-h-screen bg-white text-[#0f172a]">
      <div className="max-w-3xl mx-auto px-4 py-10">
        <p className="text-sm mb-4">
          <Link href="/sms" className="text-emerald-700 font-medium hover:underline">
            ← SMS opt-in
          </Link>
        </p>

        <div className="border-2 border-slate-800 rounded-xl p-6 space-y-6 bg-[#f8fafc]">
          <header>
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
              EstimateAce · SMS campaign collateral
            </p>
            <h1 className="text-2xl font-bold mt-1">How end-users consent to receive messages</h1>
            <p className="text-sm text-slate-600 mt-2">
              Paste this page URL (or the CTA page) into Twilio&apos;s Message Flow field. Screenshot
              either page if Twilio asks for hosted image evidence.
            </p>
          </header>

          <section className="rounded-lg border-4 border-emerald-700 bg-emerald-50 p-5 text-center space-y-2">
            <p className="text-xs font-bold uppercase text-emerald-900">
              Public text opt-in call-to-action (for Twilio reviewers)
            </p>
            <p className="text-2xl font-black">
              Text {SMS_KEYWORD_OPT_IN} to {number}
            </p>
            <p className="text-sm">
              Full CTA page:{' '}
              <a className="text-emerald-800 font-semibold underline" href={smsCtaUrl()}>
                {smsCtaUrl()}
              </a>
            </p>
          </section>

          <section className="rounded-lg border bg-white p-4 text-sm leading-relaxed">
            <h2 className="font-semibold mb-2">Message flow (paste into Twilio)</h2>
            <p>{flow}</p>
          </section>

          <section className="rounded-lg border-2 border-emerald-600 bg-emerald-50 p-4 text-sm space-y-2">
            <h2 className="font-semibold text-emerald-950">Via Text — number &amp; keyword</h2>
            <p className="text-2xl font-bold text-emerald-900 tracking-wide">{number}</p>
            <p>
              E.164: <strong>{getSmsOptInNumber()}</strong>
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                Opt-in keyword: <strong>{SMS_KEYWORD_OPT_IN}</strong>
              </li>
              <li>
                Final confirmation keyword: <strong>{SMS_KEYWORD_CONFIRM}</strong>
              </li>
              <li>
                Help: <strong>{SMS_KEYWORD_HELP}</strong> · Opt-out:{' '}
                <strong>{SMS_KEYWORD_STOP}</strong>
              </li>
            </ul>
          </section>

          <section className="rounded-lg border bg-white p-4 text-sm space-y-2">
            <h2 className="font-semibold">Opt-in methods (check in Twilio)</h2>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <strong>Web Form:</strong>{' '}
                <a className="text-emerald-700 underline" href={smsOptInPageUrl()}>
                  {smsOptInPageUrl()}
                </a>{' '}
                — enter mobile number, consent checkbox (unchecked by default), final confirmation
                checkbox, submit → confirmation SMS.
              </li>
              <li>
                <strong>Via Text:</strong> Text <strong>{SMS_KEYWORD_OPT_IN}</strong> to{' '}
                <strong>{number}</strong> → welcome message (frequency, rates, HELP/STOP, Terms &amp;
                Privacy links, request to reply <strong>{SMS_KEYWORD_CONFIRM}</strong>) → confirmation
                message after <strong>{SMS_KEYWORD_CONFIRM}</strong>.
              </li>
            </ul>
            <p className="text-xs text-slate-600">
              Do not check Verbal, Paper Form, Mobile QR Code, or Other unless you actually use them.
            </p>
          </section>

          <section className="rounded-lg border bg-white p-4 text-sm space-y-3">
            <h2 className="font-semibold">Sample messages</h2>
            <div>
              <p className="text-xs font-semibold text-slate-500">Welcome (after START)</p>
              <p className="mt-1 font-mono text-xs bg-slate-100 p-3 rounded">{welcomeSms()}</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-500">Confirmation (after YES / web form)</p>
              <p className="mt-1 font-mono text-xs bg-slate-100 p-3 rounded">{confirmationSms()}</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-500">HELP</p>
              <p className="mt-1 font-mono text-xs bg-slate-100 p-3 rounded">{helpSms()}</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-500">STOP</p>
              <p className="mt-1 font-mono text-xs bg-slate-100 p-3 rounded">{stopSms()}</p>
            </div>
          </section>

          <section className="rounded-lg border bg-white p-4 text-sm space-y-1">
            <h2 className="font-semibold">Disclosures</h2>
            <ul className="list-disc pl-5 space-y-1">
              <li>Message frequency varies (typically a few messages per week when active).</li>
              <li>
                <strong>Message and data rates may apply.</strong>
              </li>
              <li>
                Reply <strong>{SMS_KEYWORD_STOP}</strong> to opt out ·{' '}
                <strong>{SMS_KEYWORD_HELP}</strong> for help.
              </li>
              <li>Mobile numbers are not sold or shared for third-party marketing.</li>
              <li>
                Privacy Policy:{' '}
                <a className="text-emerald-700 underline" href={privacyPolicyUrl()}>
                  {privacyPolicyUrl()}
                </a>
              </li>
              <li>
                Terms &amp; Conditions:{' '}
                <a className="text-emerald-700 underline" href={termsUrl()}>
                  {termsUrl()}
                </a>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}
