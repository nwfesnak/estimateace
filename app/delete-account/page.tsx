import Link from 'next/link';

export const metadata = {
  title: 'Delete your account | EstimateAce',
  description: 'How to delete your EstimateAce account and data (web, iPhone and Android app).',
};

const SUPPORT = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@estimateace.com';

/**
 * Public account-deletion instructions. Google Play requires a web link for this
 * (Data safety → "Delete account URL"); Apple requires deletion inside the app, which is
 * Profile → Billing → Manage billing → Delete account.
 */
export default function DeleteAccountPage() {
  return (
    <main className="min-h-screen bg-[#f8fafc] text-[#0f172a]">
      <div className="max-w-3xl mx-auto px-4 py-12 prose prose-slate">
        <p className="text-sm">
          <Link href="/" className="text-emerald-700 font-medium no-underline hover:underline">
            ← Back to EstimateAce
          </Link>
        </p>
        <h1>Delete your EstimateAce account</h1>

        <h2>In the app or on the web</h2>
        <ol>
          <li>Log in to EstimateAce (iPhone app, Android app, or app.estimateace.com).</li>
          <li>
            Open <strong>Profile → Billing → Manage billing</strong>.
          </li>
          <li>
            Scroll to <strong>Delete account</strong>, type <strong>DELETE</strong>, and tap{' '}
            <strong>Schedule account deletion</strong>.
          </li>
        </ol>
        <p>
          You keep access until the end of the period you already paid for (or the end of your trial).
          On that date your access stops and your account is deleted.
        </p>

        <h2>What gets deleted</h2>
        <p>
          Your EstimateAce login and the business data stored in your account, such as your company
          profile, customers, estimates and invoices. Any EstimateAce subscription is stopped.
        </p>

        <h2>What we keep</h2>
        <p>
          Payment and tax records that the law requires us to keep (handled by Stripe), and
          basic records of past payments your customers made to you, kept only as long as required.
        </p>

        <h2>Can&apos;t log in?</h2>
        <p>
          Email <a href={`mailto:${SUPPORT}?subject=Delete%20my%20account`}>{SUPPORT}</a> from the email
          address on your account with the subject &quot;Delete my account&quot;. We confirm by email and
          complete the deletion within 30 days.
        </p>
      </div>
    </main>
  );
}
