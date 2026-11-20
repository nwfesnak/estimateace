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
        <p className="text-sm text-slate-500">Last updated: November 20, 2026</p>

        <p>
          This Privacy Policy explains how EstimateAce (&quot;we&quot;, &quot;us&quot;) collects and
          uses information when you use our web application, our iPhone (iOS) and Android apps, and related services (together, the &quot;Service&quot;).
        </p>

        <h2>1. Information we collect</h2>
        <ul>
          <li>
            <strong>Account data</strong> — email, password (hashed by our auth provider), company
            profile fields you enter.
          </li>
          <li>
            <strong>Business content</strong> — estimates, invoices, job addresses, photos, videos,
            receipts, mileage logs, calendar notes, AI Receptionist call/SMS transcripts and leads
            you create or receive.
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
          <li>
            Run optional AI features you request (quotes, translation, job renderings, AI
            Receptionist calls/SMS)
          </li>
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
          <li>Meta Platforms — advertising measurement on our website only (see section 5C)</li>
        </ul>

        <h2>4. AI processing (including xAI)</h2>
        <p>
          When you use AI features, relevant text, images, or call/SMS content you submit (or that
          callers provide to AI Receptionist) may be sent to our AI provider — currently{' '}
          <strong>xAI</strong> — to generate a response. Do not submit data you are not authorized to
          process.
        </p>
        <p>
          <strong>Retention / training:</strong> We send prompts and necessary context to xAI over
          their API solely to provide the feature you requested. We do not sell your Customer Content
          for advertising. We configure and use the API for inference; we do not use your EstimateAce
          customer data to train EstimateAce&apos;s own models. For how xAI retains or uses API data
          (including any training or retention practices), see xAI&apos;s then-current privacy /
          API terms at{' '}
          <a href="https://x.ai" target="_blank" rel="noopener noreferrer">
            x.ai
          </a>
          . You should review those terms before enabling AI features that process sensitive client
          information.
        </p>
        <p>
          Call audio for AI Receptionist is processed via our telephony provider (Twilio) for
          speech-to-text and call handling; transcripts and lead summaries may be stored in your
          EstimateAce account so you can follow up.
        </p>

        <h2>5. Sharing</h2>
        <p>
          We do not sell your personal information. We share data with processors only as needed to
          run the Service, or if required by law, or with your direction (e.g. payment links you open
          to third-party apps). Our website also uses the Meta Pixel described in section 5C.
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

        <h2>5B. iPhone and Android apps</h2>
        <ul>
          <li>
            The apps open the same EstimateAce service as the website and store your data in the same
            account. They do not use advertising identifiers and do not track you across other
            companies&apos; apps or websites; the advertising pixel used on our website is not loaded
            in the apps.
          </li>
          <li>
            <strong>Camera, microphone and photos</strong> are used only when you choose to take or
            attach job photos, videos or receipts. You can turn these permissions off at any time in
            your phone&apos;s Settings.
          </li>
          <li>
            Links to payment pages (Stripe), maps and other websites open in your phone&apos;s browser
            and are covered by those sites&apos; own policies.
          </li>
        </ul>

        <h2>5C. Advertising cookies on our website (Meta Pixel)</h2>
        <p>
          Our websites (estimateace.com and app.estimateace.com in a web browser) use the{' '}
          <strong>Meta Pixel</strong>, a small piece of code from Meta Platforms,
          Inc. (Facebook / Instagram), so we can measure how well our ads work and show EstimateAce
          ads to people who have visited our website (retargeting).
        </p>
        <ul>
          <li>
            <strong>What it collects:</strong> when a page loads, your browser sends Meta the page
            address (URL) and the referring page, the fact that the page was viewed, your IP address,
            browser and device information (user agent, screen size), the time of the visit, and
            cookie identifiers (such as Meta&apos;s <code>_fbp</code> cookie, and Facebook cookies
            already in your browser if you use Facebook or Instagram). We do not send Meta your
            estimates, invoices, customer details, or other business content.
          </li>
          <li>
            <strong>How it is used:</strong> Meta uses this information to tell us how many people
            visit after seeing an ad, to build audiences for our ads, and for its own purposes as
            described in{' '}
            <a href="https://www.facebook.com/privacy/policy/" target="_blank" rel="noopener noreferrer">
              Meta&apos;s Privacy Policy
            </a>
            . Meta may link it to your Facebook or Instagram account.
          </li>
          <li>
            <strong>Not in the mobile apps:</strong> the Meta Pixel is turned off inside the EstimateAce
            iPhone and Android apps and is never loaded there.
          </li>
          <li>
            <strong>How to opt out:</strong> block third-party cookies or clear cookies in your browser
            settings, or use a browser or extension that blocks trackers such as connect.facebook.net.
            If you have a Facebook or Instagram
            account, you can limit ads based on activity from websites like ours in your{' '}
            <a href="https://www.facebook.com/adpreferences" target="_blank" rel="noopener noreferrer">
              Meta ad preferences
            </a>{' '}
            (Ad settings → Activity information from ad partners) and disconnect past activity in{' '}
            <a
              href="https://accountscenter.facebook.com/info_and_permissions/off_facebook_activity"
              target="_blank"
              rel="noopener noreferrer"
            >
              Your activity off Meta technologies
            </a>
            . You can also use the industry opt-out at{' '}
            <a href="https://optout.aboutads.info" target="_blank" rel="noopener noreferrer">
              optout.aboutads.info
            </a>
            . Opting out does not affect your use of EstimateAce.
          </li>
        </ul>

        <h2>6. Retention and account deletion</h2>
        <p>
          We retain account and job data while your account is active and as needed for backups,
          legal, and security purposes.
        </p>
        <p>
          <strong>Deleting your account:</strong> in the website or the iPhone / Android app, open
          Profile → Billing → Manage billing → Delete account (instructions:{' '}
          <Link href="/delete-account">app.estimateace.com/delete-account</Link>). Renewals stop right
          away and you keep access until the end of the period you already paid for (or your trial).
          Then we permanently delete your login, company profile, customers, estimates, invoices,
          jobs, receipts, photos, videos and other files, AI Receptionist settings, phone number,
          call logs and messages, crew logins you created, and your link to your Stripe payout
          account. We keep only what the law or payment networks require: billing and tax records at
          Stripe, payment dispute records (with your account link removed), and SMS opt-in / opt-out
          consent records for phone numbers. Routine backups roll off within about 30 days.
        </p>
        <p>
          <strong>Inactive promotional trials:</strong> if your account is on the 2-month launch-promotion
          trial, has never been paid for, and nobody signs in for 30 days, we email you a reminder at 20
          days, then email you a copy of all the data you entered (with download links for your photos and
          files, valid for about 30 days) and delete the account as described above. Those export copies
          are stored privately and removed when the links expire. See{' '}
          <Link href="/terms#trial-inactivity">Terms section 2B</Link>.
        </p>
        <p>
          If you are a <strong>crew member</strong> on someone else&apos;s EstimateAce account and you
          delete your own login, the crew seat the account owner was paying for is canceled
          automatically, the same as if the owner had removed you.
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
          <li>Opt out of website advertising cookies (see section 5C)</li>
          <li>
            Delete your account in the app or on the web (see section 6), or contact{' '}
            <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a> for access or deletion requests
          </li>
        </ul>

        <h2>9. Children</h2>
        <p>The Service is not directed to children under 16.</p>

        <h2>10. Changes</h2>
        <p>
          We may update this policy. Continued use after changes means you accept the updated
          policy. Material changes will be reflected by the &quot;Last updated&quot; date.
        </p>

        <h2>11. International users</h2>
        <p>
          The Service is operated from the United States. If you access it from another country, you
          understand that your information may be processed in the U.S. and other locations where our
          providers operate.
        </p>

        <h2>12. Contact</h2>
        <p>
          Privacy questions or data requests:{' '}
          <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a>
        </p>
      </div>
    </main>
  );
}
