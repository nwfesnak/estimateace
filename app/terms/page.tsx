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
        <p className="text-sm text-slate-500">Last updated: November 18, 2026</p>

        <p>
          These Terms govern your use of EstimateAce (&quot;Service&quot;), a software platform for
          contractors to create estimates, invoices, job documentation, and related tools.
          EstimateAce is operated by Nathan Fesnak, a sole proprietor based in Charlotte, North
          Carolina (&quot;EstimateAce,&quot; &quot;we,&quot; &quot;us&quot;). By creating an account or using the
          Service, you agree to these Terms.
        </p>

        <h2>1. Account</h2>
        <p>
          You must provide accurate account information and keep your password secure. You are
          responsible for activity under your account. Notify us promptly of unauthorized access at{' '}
          <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a>.
        </p>

        <h2>2. Subscription &amp; free trial</h2>
        <p>
          New accounts start with a free trial. No payment card is required to start the trial.
          When the trial ends, you must subscribe to a paid plan (currently $29.99 per month or $249
          per year, plus any applicable taxes) to keep using the Service. If you subscribe before
          your trial ends, your first charge happens when the trial would have ended. Subscriptions
          renew automatically at the end of each billing period until canceled. Optional add-ons
          (such as crew seats and AI Receptionist) are billed separately at the prices shown in the
          app. Subscription fees are charged through our payment processor, Stripe. We may change
          prices with advance notice; changes apply from your next billing period.
        </p>

        <h2 id="cancellation">2A. Cancellation &amp; refunds</h2>
        <p>
          You can cancel at any time from <strong>Profile → Billing → Manage billing</strong>{' '}
          (the Stripe billing portal) or by emailing <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a>.
          When you cancel, your subscription will not renew and you keep access through the end of
          the period you already paid for. We do not provide refunds or credits for partial billing
          periods, unused time, or downgrades, except where required by law.
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
          Optional AI features (pricing suggestions, translations, job renderings, AI Receptionist,
          and related tools) may send prompts, call audio transcripts, images, or other context you
          submit to our AI providers (currently xAI) to generate a response. AI output can be wrong
          or incomplete — you must review all quotes, legal language, and customer communications
          before use. AI is not professional advice.
        </p>
        <p>
          <strong>AI Receptionist</strong> is an optional paid add-on. When enabled, callers may
          reach an AI line (typically via call forwarding from your existing business number). You
          are responsible for carrier forwarding setup, disclosure to callers where required, and
          reviewing leads the AI logs. Speech recognition and AI answers can fail; keep a transfer /
          host number configured.
        </p>

        <h2>5. Evolving features</h2>
        <p>
          We may improve or change features over time. Crew seats are available as a paid per-seat
          add-on. Some capabilities (for example deeper email-inbox automation or streaming voice
          upgrades) may still roll out gradually — we will label unfinished items clearly in the
          product when material.
        </p>

        <h2>6. Acceptable use</h2>
        <p>
          You may not misuse the Service, attempt to access other customers&apos; data, reverse
          engineer the Service except as allowed by law, or use it for unlawful activity.
        </p>

        <h2 id="payments">7. Payments between you and your clients</h2>
        <p>
          If you accept card or bank payments from your clients through EstimateAce, those payments
          are processed by Stripe and paid out to your own Stripe connected account. Payment
          processing services for contractors on EstimateAce are provided by Stripe and are subject
          to the{' '}
          <a href="https://stripe.com/connect-account/legal" target="_blank" rel="noopener noreferrer">
            Stripe Connected Account Agreement
          </a>
          , which includes the{' '}
          <a href="https://stripe.com/legal" target="_blank" rel="noopener noreferrer">
            Stripe Terms of Service
          </a>{' '}
          (collectively, the &quot;Stripe Services Agreement&quot;). By agreeing to these Terms or
          continuing to use payment features, you agree to be bound by the Stripe Services Agreement,
          as Stripe may modify it from time to time. As a condition of EstimateAce enabling payment
          processing through Stripe, you agree to provide us accurate and complete information about
          you and your business, and you authorize us to share it and transaction information
          related to your use of the payment processing services provided by Stripe.
        </p>
        <p>
          EstimateAce provides software only. We are not a party to any transaction, contract, or
          dispute between you and your clients, and we do not hold your clients&apos; funds. You are
          responsible for your work, pricing, taxes, refunds, chargebacks, and disputes with your
          clients. Other payment methods you list on documents (such as PayPal, Venmo, Zelle, checks,
          or cash) are solely between you, your client, and that provider.
        </p>

        <h2>7A. Text messaging (SMS)</h2>
        <p>
          By opting in to EstimateAce SMS (via our{' '}
          <Link href="/sms">web form</Link>, Profile opt-in, or texting the published keyword to our
          long code / toll-free number), you consent to receive transactional text messages about
          appointments, estimates, invoices, recurring service approvals, and account verification.
          Message frequency varies with your activity. Message and data rates may apply. Consent is
          not required as a condition of purchase. Reply <strong>STOP</strong> to cancel,{' '}
          <strong>HELP</strong> for help. See our <Link href="/privacy">Privacy Policy</Link> and{' '}
          <Link href="/sms/message-flow">SMS message flow</Link>.
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

        <h2>11. Governing law</h2>
        <p>
          These Terms are governed by the laws of the United States and the State of North Carolina,
          without regard to conflict-of-law rules, except where mandatory consumer protections in your
          jurisdiction apply. Courts in that state shall have exclusive jurisdiction over disputes,
          except where prohibited by law.
        </p>

        <h2>12. Changes</h2>
        <p>
          We may update these Terms from time to time. The &quot;Last updated&quot; date will change when we
          do. Continued use of the Service after an update constitutes acceptance of the revised Terms.
          If you do not agree, stop using the Service and cancel any subscription.
        </p>

        <h2>13. Contact</h2>
        <p>
          Questions about these Terms:{' '}
          <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a>
          <br />
          EstimateAce (operated by Nathan Fesnak, sole proprietor), Charlotte, NC
        </p>
      </div>
    </main>
  );
}
