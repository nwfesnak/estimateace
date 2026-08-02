import Link from 'next/link';

export const metadata = {
  title: 'Terms of Service | EstimateAce',
  description: 'Terms of Service for EstimateAce contractor estimating software.',
};

const SUPPORT = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@estimateace.com';

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-[#f8fafc] text-[#0f172a]">
      <div className="max-w-3xl mx-auto px-4 py-12 prose prose-slate">
        <p className="text-sm">
          <Link href="/" className="text-emerald-700 font-medium no-underline hover:underline">
            ← Back to EstimateAce
          </Link>
        </p>
        <h1>Terms of Service</h1>
        <p className="text-sm text-slate-500">Last updated: August 2, 2026 · Phase A soft-launch</p>

        <p>
          These Terms govern your use of EstimateAce (&quot;Service&quot;), a software platform for
          contractors to create estimates, invoices, job documentation, and related tools. By
          creating an account or using the Service, you agree to these Terms.
        </p>

        <h2>1. Account</h2>
        <p>
          You must provide accurate account information and keep your password secure. You are
          responsible for activity under your account. Notify us promptly of unauthorized access at{' '}
          <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a>.
        </p>

        <h2>2. Subscription &amp; trial</h2>
        <p>
          Access may be provided under a free trial and/or paid subscription. Fees, if any, are
          charged through Stripe. Unless required by law, fees are non-refundable except where we
          state otherwise. You may cancel via the billing portal; access continues until the end of
          the paid period when applicable.
        </p>

        <h2>3. Your content</h2>
        <p>
          You retain ownership of estimates, invoices, photos, and other content you upload
          (&quot;Customer Content&quot;). You grant us a limited license to host, process, and display
          Customer Content solely to provide the Service. You are responsible for having rights to
          any client data you store.
        </p>

        <h2>4. AI features</h2>
        <p>
          Optional AI features (pricing suggestions, translations, receptionist test mode, etc.) may
          send prompts and relevant context to our AI providers (e.g. xAI). AI output can be wrong or
          incomplete — you must review all quotes, legal language, and customer communications
          before use. AI is not professional advice.
        </p>

        <h2>5. Beta / incomplete features</h2>
        <p>
          Some features are labeled beta or demo (including AI Receptionist live phone answering and
          advanced crew billing). Beta features are provided as-is and may change or be removed.
        </p>

        <h2>6. Acceptable use</h2>
        <p>
          You may not misuse the Service, attempt to access other customers&apos; data, reverse
          engineer the Service except as allowed by law, or use it for unlawful activity.
        </p>

        <h2>7. Payment links to third parties</h2>
        <p>
          Payment methods you configure (PayPal, Venmo, Zelle, etc.) are between you and those
          processors. EstimateAce does not hold client funds unless a future feature expressly
          states otherwise.
        </p>

        <h2>8. Disclaimers</h2>
        <p>
          THE SERVICE IS PROVIDED &quot;AS IS&quot; WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR
          IMPLIED. WE DO NOT WARRANT UNINTERRUPTED OR ERROR-FREE OPERATION.
        </p>

        <h2>9. Limitation of liability</h2>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, ESTIMATEACE AND ITS OPERATORS SHALL NOT BE LIABLE
          FOR INDIRECT, INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES, OR LOST PROFITS, ARISING FROM
          USE OF THE SERVICE. OUR TOTAL LIABILITY FOR ANY CLAIM SHALL NOT EXCEED THE AMOUNTS YOU
          PAID US FOR THE SERVICE IN THE THREE MONTHS BEFORE THE CLAIM.
        </p>

        <h2>10. Termination</h2>
        <p>
          You may stop using the Service at any time. We may suspend or terminate accounts that
          violate these Terms or create risk to the Service or other users.
        </p>

        <h2>11. Contact</h2>
        <p>
          Support: <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a>
        </p>

        <p className="text-sm text-slate-500">
          This is a standard software terms template for Phase A launch. Have a lawyer review before
          high-volume commercial sales.
        </p>
      </div>
    </main>
  );
}
