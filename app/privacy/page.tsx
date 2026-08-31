import Link from 'next/link';

export const metadata = {
  title: 'Privacy Policy | EstimateAce',
  description: 'Privacy Policy for EstimateAce contractor estimating software.',
};

const SUPPORT = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@estimateace.com';

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#f8fafc] text-[#0f172a]">
      <div className="max-w-3xl mx-auto px-4 py-12 prose prose-slate">
        <p className="text-sm">
          <Link href="/" className="text-emerald-700 font-medium no-underline hover:underline">
            ← Back to EstimateAce
          </Link>
        </p>
        <h1>Privacy Policy</h1>
        <p className="text-sm text-slate-500">Last updated: March 16, 2026</p>

        <p>
          This Privacy Policy explains how EstimateAce (&quot;we&quot;, &quot;us&quot;) collects and
          uses information when you use our web application and related services.
        </p>

        <h2>1. Information we collect</h2>
        <ul>
          <li>
            <strong>Account data</strong> — email, password (hashed by our auth provider), company
            profile fields you enter.
          </li>
          <li>
            <strong>Business content</strong> — estimates, invoices, job addresses, photos, videos,
            receipts, mileage logs, calendar notes, receptionist test transcripts you create.
          </li>
          <li>
            <strong>Usage &amp; technical data</strong> — IP address, device/browser type, logs needed
            to secure and operate the Service.
          </li>
          <li>
            <strong>Billing data</strong> — handled by Stripe (card details are not stored on our
            servers). We store subscription status and Stripe customer/subscription IDs.
          </li>
        </ul>

        <h2>2. How we use information</h2>
        <ul>
          <li>Provide, maintain, and improve the Service</li>
          <li>Authenticate users and protect accounts</li>
          <li>Process subscriptions and send transactional email/SMS when configured</li>
          <li>Run optional AI features you request (quotes, translation, receptionist test mode)</li>
          <li>Comply with law and enforce our Terms</li>
        </ul>

        <h2>3. Processors / subprocessors</h2>
        <p>We use trusted providers, including:</p>
        <ul>
          <li>Supabase — authentication and database</li>
          <li>Vercel — hosting</li>
          <li>xAI — AI model API when you use AI features</li>
          <li>Stripe — payments</li>
          <li>Resend / Twilio — email/SMS when you enable notifications</li>
        </ul>

        <h2>4. AI processing</h2>
        <p>
          When you use AI features, relevant text or images you submit may be sent to the AI provider
          to generate a response. Do not submit data you are not allowed to process. Review provider
          policies for their handling of API data.
        </p>

        <h2>5. Sharing</h2>
        <p>
          We do not sell your personal information. We share data with processors only as needed to
          run the Service, or if required by law, or with your direction (e.g. payment links you open
          to third-party apps).
        </p>
        <p>
          <strong>Mobile phone numbers:</strong> We do not sell, rent, or share mobile phone numbers
          with third parties or affiliates for their marketing or promotional purposes. Phone numbers
          collected for SMS are used only to deliver the transactional messages you consented to
          receive, and by SMS/telecom providers (such as Twilio) solely to transmit those messages.
        </p>

        <h2>5A. Text messaging (SMS)</h2>
        <p>
          If you opt in to EstimateAce SMS, we may send transactional texts such as appointment
          reminders, estimate/invoice notices, recurring-service approval links, and account
          verification codes. Message frequency varies based on your appointments and document
          activity (typically a few messages per week when your account is active; more during busy
          scheduling periods). <strong>Message and data rates may apply.</strong>
        </p>
        <p>
          You can opt out at any time by replying <strong>STOP</strong>. Reply{' '}
          <strong>HELP</strong> for help. For support, contact{' '}
          <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a>. Consent to SMS is not a condition of
          purchasing EstimateAce software. See our{' '}
          <Link href="/sms">SMS opt-in page</Link> and{' '}
          <Link href="/terms">Terms of Service</Link>.
        </p>

        <h2>6. Retention</h2>
        <p>
          We retain account and job data while your account is active and as needed for backups,
          legal, and security purposes. You may request deletion of your account by contacting
          support.
        </p>

        <h2>7. Security</h2>
        <p>
          We use industry-standard measures including HTTPS, authentication, and database access
          controls (including row-level security where configured). No method of transmission is
          100% secure.
        </p>

        <h2>8. Your choices</h2>
        <ul>
          <li>Update profile and job data in the app</li>
          <li>Manage or cancel subscription via Stripe customer portal when available</li>
          <li>
            Contact <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a> for access or deletion requests
          </li>
        </ul>

        <h2>9. Children</h2>
        <p>The Service is not directed to children under 16.</p>

        <h2>10. Changes</h2>
        <p>
          We may update this policy. Continued use after changes means you accept the updated
          policy. Material changes will be reflected by the &quot;Last updated&quot; date.
        </p>

        <h2>11. Contact</h2>
        <p>
          <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a>
        </p>

        <p className="text-sm text-slate-500">
          This policy is a Phase A template. Have counsel review for your jurisdiction before scale.
        </p>
      </div>
    </main>
  );
}
