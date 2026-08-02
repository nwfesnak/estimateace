'use client';

import { useMemo, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseClient, getSupabaseConfigHelpMessage } from '@/lib/supabase/client';

const APP_HOME = '/';
const TRIAL_DAYS = 14;

type Plan = 'monthly' | 'yearly';

function TrialForm() {
  const searchParams = useSearchParams();
  const initialPlan: Plan =
    searchParams.get('plan') === 'yearly' ? 'yearly' : 'monthly';

  const [plan, setPlan] = useState<Plan>(initialPlan);
  const [company, setCompany] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const planLabel = plan === 'yearly' ? 'Yearly' : 'Monthly';
  const planPrice = plan === 'yearly' ? '$249/year' : '$29.99/month';

  const billingNote = useMemo(
    () =>
      `After your ${TRIAL_DAYS}-day free trial, you will be billed ${planPrice} (${planLabel.toLowerCase()}) unless you cancel. You can change plans or cancel in Profile → Plan / Billing.`,
    [plan, planPrice, planLabel]
  );

  const startTrial = async () => {
    setError(null);
    setInfo(null);

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedCompany = company.trim();
    const trimmedName = name.trim();

    if (!trimmedCompany) {
      setError('Enter your company name.');
      return;
    }
    if (!trimmedEmail || !password) {
      setError('Enter email and password.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== password2) {
      setError('Passwords do not match.');
      return;
    }
    if (!agree) {
      setError('Please confirm you understand the trial and billing terms.');
      return;
    }

    const supabase = getSupabaseClient();
    if (!supabase) {
      setError(getSupabaseConfigHelpMessage());
      return;
    }

    setBusy(true);
    try {
      const { data, error: signErr } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
        options: {
          data: {
            company: trimmedCompany,
            full_name: trimmedName,
            phone: phone.trim(),
            preferred_plan: plan,
          },
        },
      });

      if (signErr) {
        setError(signErr.message);
        return;
      }

      // Session present = logged in immediately; otherwise email confirmation required
      if (data.session?.user) {
        const token = data.session.access_token;
        // Seed trial + preferred plan
        try {
          await fetch('/api/billing/start-trial', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              plan,
              company: trimmedCompany,
              name: trimmedName,
              phone: phone.trim(),
            }),
          });
        } catch {
          /* trial still seeds on first status poll */
        }

        setInfo('Account created — starting your free trial…');
        window.location.href = `${APP_HOME}?trial=started&plan=${plan}`;
        return;
      }

      if (data.user && !data.session) {
        setInfo(
          'Account created! Check your email to confirm, then log in. Your 14-day trial starts on first login. You chose: ' +
            planLabel +
            ` (${planPrice} after trial).`
        );
        return;
      }

      setInfo('Account created. You can log in to start your trial.');
    } catch (e: any) {
      setError(e?.message || 'Signup failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b bg-white">
        <div className="max-w-lg mx-auto px-4 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 font-bold text-xl tracking-tight">
            <span className="w-9 h-9 bg-slate-900 text-white rounded-xl flex items-center justify-center text-sm">
              EA
            </span>
            EstimateAce
          </Link>
          <Link href="/" className="text-sm font-semibold text-slate-600 hover:text-slate-900">
            Log in
          </Link>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-10">
        <div className="bg-white border border-slate-200 rounded-3xl shadow-sm p-6 sm:p-8 space-y-6">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-emerald-600">
              {TRIAL_DAYS}-day free trial
            </p>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mt-1">
              Start free trial &amp; choose your plan
            </h1>
            <p className="text-sm text-slate-600 mt-2">
              This is the only place to create a new EstimateAce account (from the website or Sign
              Up). Enter your details for a {TRIAL_DAYS}-day free trial. After the trial you will be
              billed for the plan you choose below unless you cancel. Then use the same email and
              password to log in at app.estimateace.com.
            </p>
          </div>

          {/* Plan choice */}
          <div>
            <label className="block text-sm font-semibold mb-2">Choose your plan after trial</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setPlan('monthly')}
                className={`rounded-2xl border-2 p-4 text-left transition ${
                  plan === 'monthly'
                    ? 'border-slate-900 bg-slate-50 ring-2 ring-slate-900/10'
                    : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <div className="font-semibold">Monthly</div>
                <div className="text-2xl font-bold tracking-tight mt-1">$29.99</div>
                <div className="text-xs text-slate-500">per month after trial</div>
              </button>
              <button
                type="button"
                onClick={() => setPlan('yearly')}
                className={`rounded-2xl border-2 p-4 text-left transition relative ${
                  plan === 'yearly'
                    ? 'border-emerald-600 bg-emerald-50 ring-2 ring-emerald-600/20'
                    : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <span className="absolute -top-2 right-3 text-[10px] font-bold bg-emerald-600 text-white px-2 py-0.5 rounded-full">
                  Best value
                </span>
                <div className="font-semibold">Yearly</div>
                <div className="text-2xl font-bold tracking-tight mt-1">$249</div>
                <div className="text-xs text-slate-500">per year after trial</div>
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-amber-200 bg-amber-50 text-amber-950 text-sm p-4 leading-snug">
            <strong>Billing notice:</strong> {billingNote}
          </div>

          {/* Account fields */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Company name *</label>
              <input
                className="w-full h-11 rounded-xl border border-slate-300 px-3 text-sm"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Your company LLC"
                autoComplete="organization"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Your name</label>
              <input
                className="w-full h-11 rounded-xl border border-slate-300 px-3 text-sm"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full name"
                autoComplete="name"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Work email *</label>
              <input
                type="email"
                className="w-full h-11 rounded-xl border border-slate-300 px-3 text-sm"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Phone</label>
              <input
                type="tel"
                className="w-full h-11 rounded-xl border border-slate-300 px-3 text-sm"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(555) 555-5555"
                autoComplete="tel"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Password *</label>
              <input
                type="password"
                className="w-full h-11 rounded-xl border border-slate-300 px-3 text-sm"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Confirm password *</label>
              <input
                type="password"
                className="w-full h-11 rounded-xl border border-slate-300 px-3 text-sm"
                value={password2}
                onChange={(e) => setPassword2(e.target.value)}
                placeholder="Repeat password"
                autoComplete="new-password"
              />
            </div>
          </div>

          <label className="flex items-start gap-3 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1 accent-emerald-600"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
            />
            <span>
              I understand this is a <strong>{TRIAL_DAYS}-day free trial</strong>, and after that I
              will be billed <strong>{planPrice}</strong> ({planLabel.toLowerCase()}) unless I
              cancel. I agree to the{' '}
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

          {error && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">
              {error}
            </p>
          )}
          {info && (
            <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl p-3">
              {info}
            </p>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={() => void startTrial()}
            className="w-full h-12 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white font-semibold disabled:opacity-50"
          >
            {busy ? 'Creating account…' : `Start ${TRIAL_DAYS}-day free trial`}
          </button>

          <p className="text-center text-sm text-slate-500">
            Already have an account?{' '}
            <Link href="/" className="font-semibold text-emerald-700 underline">
              Log in
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}

export default function TrialPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center text-slate-500">Loading…</div>
      }
    >
      <TrialForm />
    </Suspense>
  );
}
