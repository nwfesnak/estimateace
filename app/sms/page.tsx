'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

const SUPPORT = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@estimateace.com';

function displayNumber(): string {
  const raw = (
    process.env.NEXT_PUBLIC_SMS_OPT_IN_NUMBER ||
    process.env.NEXT_PUBLIC_TWILIO_PHONE_NUMBER ||
    '+18559169529'
  ).replace(/\D/g, '');
  if (raw.length === 11 && raw.startsWith('1')) {
    return `(${raw.slice(1, 4)}) ${raw.slice(4, 7)}-${raw.slice(7)}`;
  }
  if (raw.length === 10) return `(${raw.slice(0, 3)}) ${raw.slice(3, 6)}-${raw.slice(6)}`;
  return '+18559169529';
}

export default function SmsOptInPage() {
  const smsNumber = useMemo(() => displayNumber(), []);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [finalConfirm, setFinalConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');
    if (!agreed || !finalConfirm) {
      setError('Please check both consent boxes to continue.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/sms/opt-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, agreed, finalConfirm }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        setError(data.error || 'Could not complete opt-in.');
        if (data.optedIn) {
          setMessage('Your opt-in was recorded. Confirmation SMS may be delayed.');
        }
        return;
      }
      setMessage(data.message || 'You are opted in. Check your phone for a confirmation text.');
      setFinalConfirm(false);
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#f8fafc] text-[#0f172a]">
      <div className="max-w-xl mx-auto px-4 py-12">
        <p className="text-sm mb-6">
          <Link href="/" className="text-emerald-700 font-medium hover:underline">
            ← Back to EstimateAce
          </Link>
        </p>

        <h1 className="text-3xl font-bold text-[#1e293b]">Text message opt-in</h1>
        <p className="text-slate-600 mt-2">
          EstimateAce sends <strong>transactional</strong> SMS only (appointment reminders,
          estimate/invoice notices, recurring approvals, and account alerts)—not marketing blasts.
        </p>

        <div className="mt-6 rounded-xl border-2 border-emerald-600 bg-emerald-50 p-5 space-y-3 text-sm text-slate-800">
          <p className="text-xs font-bold uppercase tracking-wide text-emerald-800">Via text opt-in</p>
          <p className="text-xl font-bold">
            Text <span className="underline">START</span> to{' '}
            <span className="whitespace-nowrap">{smsNumber}</span>
          </p>
          <p>
            You will get a <strong>welcome message</strong> explaining EstimateAce SMS. Reply{' '}
            <strong>YES</strong> for <strong>final confirmation</strong>. Then you receive a{' '}
            <strong>confirmation message</strong>.
          </p>
          <p>
            <strong>Message frequency:</strong> varies (typically a few messages per week when
            active).
          </p>
          <p>
            <strong>Message and data rates may apply.</strong>
          </p>
          <p>
            Reply <strong>STOP</strong> to opt out · Reply <strong>HELP</strong> for help ·{' '}
            <a className="text-emerald-700 underline" href={`mailto:${SUPPORT}`}>
              {SUPPORT}
            </a>
          </p>
          <p>
            <Link href="/terms" className="text-emerald-700 underline">
              Terms of Service
            </Link>
            {' · '}
            <Link href="/privacy" className="text-emerald-700 underline">
              Privacy Policy
            </Link>
            {' · '}
            <Link href="/sms/message-flow" className="text-emerald-700 underline">
              Message flow (Twilio)
            </Link>
          </p>
        </div>

        <form onSubmit={submit} className="mt-8 rounded-xl border bg-white p-6 space-y-4 shadow-sm">
          <h2 className="text-lg font-semibold">Web form opt-in</h2>
          <div>
            <label className="block text-sm font-semibold mb-1">Name (optional)</label>
            <input
              className="w-full border rounded-lg h-10 px-3"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1">Mobile phone *</label>
            <input
              className="w-full border rounded-lg h-10 px-3"
              type="tel"
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(704) 555-1234"
            />
          </div>

          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            <span>
              I agree to receive transactional text messages from EstimateAce at the number provided.
              Msg frequency varies. <strong>Msg &amp; data rates may apply.</strong> Reply STOP to
              cancel, HELP for help. I agree to the{' '}
              <Link href="/terms" className="text-emerald-700 underline">
                Terms
              </Link>{' '}
              and{' '}
              <Link href="/privacy" className="text-emerald-700 underline">
                Privacy Policy
              </Link>
              .
            </span>
          </label>

          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={finalConfirm}
              onChange={(e) => setFinalConfirm(e.target.checked)}
            />
            <span>
              <strong>Final confirmation:</strong> Yes — text me at this number to complete opt-in.
            </span>
          </label>

          {error ? <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</p> : null}
          {message ? (
            <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
              {message}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            className="w-full h-11 rounded-lg bg-[#10b981] hover:bg-[#059669] text-white font-semibold disabled:opacity-60"
          >
            {busy ? 'Submitting…' : 'Opt in & send confirmation text'}
          </button>
        </form>
      </div>
    </main>
  );
}
