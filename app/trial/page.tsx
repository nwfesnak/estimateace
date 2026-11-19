'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseClient, getSupabaseConfigHelpMessage } from '@/lib/supabase/client';
import { TurnstileWidget } from '@/components/TurnstileWidget';
import {
  captchaOption,
  friendlyCaptchaError,
  TURNSTILE_REQUIRED_MESSAGE,
  turnstileEnabled,
} from '@/lib/turnstile';

const APP_HOME = '/';
const DEFAULT_TRIAL_DAYS = 14;
const CAPPED_OFFER_LIMIT = 20;

type Plan = 'monthly' | 'yearly';
type Offer = 'standard' | '2mo' | '6mo';

/** The old 3-month offer is retired; its links go to the standard trial. */
function isRetiredPromo(promo: string | null): boolean {
  const p = String(promo || '')
    .trim()
    .toLowerCase();
  return p === '3mo' || p === '3months' || p === '90' || p === 'three-months';
}

function offerForPromo(promo: string | null): Offer {
  const p = String(promo || '')
    .trim()
    .toLowerCase();
  if (p === '2mo' || p === '2months' || p === '60' || p === 'two-months') return '2mo';
  if (p === '6mo' || p === '6months' || p === '180' || p === 'six-months') return '6mo';
  return 'standard';
}

const OFFER_DAYS: Record<Offer, number> = {
  standard: DEFAULT_TRIAL_DAYS,
  '2mo': 60,
  '6mo': 180,
};

type Spots = { limit: number; remaining: number; open: boolean } | null;

function TrialForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialPlan: Plan =
    searchParams.get('plan') === 'yearly' ? 'yearly' : 'monthly';
  const rawPromo = searchParams.get('promo');
  const retiredPromo = isRetiredPromo(rawPromo);
  // Retired ?promo=3mo → standard card-required trial (never sent to the server).
  const promo = retiredPromo ? null : rawPromo;
  const offer = offerForPromo(promo);
  // 6-month is card-free but capped at 20 signups.
  // Standard and 2-month require a card up front in Stripe Checkout.
  const cappedOffer = offer === '6mo';
  const cardRequired = !cappedOffer;
  const trialDays = OFFER_DAYS[offer];
  const trialLabel =
    trialDays >= 180
      ? '6-month'
      : trialDays >= 60
          ? '2-month'
          : trialDays === 14
            ? '14-day'
            : `${trialDays}-day`;

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
  const [spots, setSpots] = useState<Spots>(null);
  // Cloudflare Turnstile (only when NEXT_PUBLIC_TURNSTILE_SITE_KEY is set). Tokens are
  // single use, so the widget is remounted (captchaNonce) after every signup attempt.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaNonce, setCaptchaNonce] = useState(0);

  const offerFull = cappedOffer && spots?.open === false;
  const standardTrialHref = `/trial${plan === 'yearly' ? '?plan=yearly' : ''}`;

  useEffect(() => {
    if (retiredPromo) {
      router.replace(`/trial${initialPlan === 'yearly' ? '?plan=yearly' : ''}`);
    }
  }, [retiredPromo, router, initialPlan]);

  useEffect(() => {
    if (!cappedOffer) return;
    let cancelled = false;
    fetch(`/api/billing/promo-spots?promo=${offer}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d || typeof d.remaining !== 'number') return;
        setSpots({
          limit: Number(d.limit) || CAPPED_OFFER_LIMIT,
          remaining: Math.max(0, Number(d.remaining) || 0),
          open: d.open !== false,
        });
      })
      .catch(() => {
        /* server still enforces the cap */
      });
    return () => {
      cancelled = true;
    };
  }, [cappedOffer, offer]);

  const planLabel = plan === 'yearly' ? 'Yearly' : 'Monthly';
  const planPrice = plan === 'yearly' ? '$249/year' : '$29.99/month';

  const billingNote = useMemo(
    () =>
      cardRequired
        ? `A credit card is required to start. Your ${trialLabel} free trial lasts ${trialDays} days and you won't be charged until it ends. After the trial, your card is charged ${planPrice} (${planLabel.toLowerCase()}) unless you cancel. Cancel anytime before the trial ends in Profile → Billing → Manage billing and you won't be charged.`
        : `No credit card is needed to start. This ${trialLabel} free trial (${trialDays} days) is limited to the first ${spots?.limit ?? CAPPED_OFFER_LIMIT} signups. When it ends, you'll need to subscribe at ${planPrice} (${planLabel.toLowerCase()}) to keep access. You won't be charged unless you subscribe. Cancel anytime in Profile → Billing → Manage billing.`,
    [cardRequired, planPrice, planLabel, trialDays, trialLabel, spots?.limit]
  );

  /** Send a just-signed-up user to Stripe Checkout to add a card and start the trial. */
  const goToCardCheckout = async (token: string) => {
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ plan }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.url) {
        setInfo('Account created — taking you to add your card…');
        window.location.href = json.url;
        return;
      }
    } catch {
      /* fall through: the app's paywall offers the same Checkout */
    }
    // Account exists; the app will show "Start your free trial" with the card step.
    window.location.href = `${APP_HOME}?trial=card&plan=${plan}`;
  };

  const startTrial = async () => {
    setError(null);
    setInfo(null);

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedCompany = company.trim();
    const trimmedName = name.trim();

    if (offerFull) {
      setError(`This ${trialLabel} offer is full. Please start the standard free trial instead.`);
      return;
    }
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

    if (cappedOffer) {
      try {
        const spotsRes = await fetch(`/api/billing/promo-spots?promo=${offer}`, {
          cache: 'no-store',
        });
        const latest = await spotsRes.json().catch(() => ({}));
        if (spotsRes.ok && latest.open === false) {
          setSpots({ limit: Number(latest.limit) || CAPPED_OFFER_LIMIT, remaining: 0, open: false });
          setError(`This ${trialLabel} offer is full. All ${latest.limit || CAPPED_OFFER_LIMIT} spots are taken.`);
          return;
        }
      } catch {
        /* server still enforces the 20-signup cap */
      }
    }

    const supabase = getSupabaseClient();
    if (!supabase) {
      setError(getSupabaseConfigHelpMessage());
      return;
    }

    if (turnstileEnabled && !captchaToken) {
      setError(TURNSTILE_REQUIRED_MESSAGE);
      return;
    }
    const usedCaptchaToken = captchaToken;

    setBusy(true);
    try {
      const { data, error: signErr } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
        options: {
          // Used when Supabase email confirmation is on: the link returns to the app,
          // which then shows the card step (standard/2-month) or starts the 6-month trial.
          emailRedirectTo: `${window.location.origin}/?plan=${plan}${promo ? `&promo=${encodeURIComponent(promo)}` : ''}`,
          ...captchaOption(usedCaptchaToken),
          data: {
            company: trimmedCompany,
            full_name: trimmedName,
            phone: phone.trim(),
            preferred_plan: plan,
            promo: promo || '',
          },
        },
      });

      if (signErr) {
        setError(friendlyCaptchaError(signErr.message) || signErr.message);
        return;
      }

      // Session present = logged in immediately; otherwise email confirmation required
      if (data.session?.user) {
        const token = data.session.access_token;
        let trialJson: { error?: string; full?: boolean; limit?: number } = {};
        try {
          const trialRes = await fetch('/api/billing/start-trial', {
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
              promo: promo || undefined,
              trialDays,
            }),
          });
          trialJson = await trialRes.json().catch(() => ({}));
          if (cappedOffer && !trialRes.ok) {
            if (trialJson.full) {
              setSpots({ limit: Number(trialJson.limit) || CAPPED_OFFER_LIMIT, remaining: 0, open: false });
            }
            setError(
              (trialJson.error ||
                `This ${trialLabel} offer is full. All ${CAPPED_OFFER_LIMIT} spots are taken.`) +
                ' Your account was created — log in and add a card to start the standard free trial.'
            );
            return;
          }
        } catch {
          if (cappedOffer) {
            setError(`Could not start the ${trialLabel} offer. Please try again.`);
            return;
          }
        }

        if (cardRequired) {
          await goToCardCheckout(token);
          return;
        }

        setInfo('Account created — starting your free trial…');
        window.location.href = `${APP_HOME}?trial=started&plan=${plan}${
          promo ? `&promo=${encodeURIComponent(promo)}` : ''
        }`;
        return;
      }

      if (data.user && !data.session) {
        setInfo(
          cardRequired
            ? `Account created! Check your email to confirm, then log in. You'll add a card to start your ${trialLabel} free trial (${trialDays} days). You won't be charged until the trial ends. You chose: ${planLabel} (${planPrice} after trial).`
            : `Account created! Check your email to confirm, then log in. Your ${trialLabel} free trial (${trialDays} days) starts on first login, with no credit card needed. You chose: ${planLabel} (${planPrice} after trial).`
        );
        return;
      }

      setInfo('Account created. You can log in to start your trial.');
    } catch (e: any) {
      setError(e?.message || 'Signup failed. Try again.');
    } finally {
      setBusy(false);
      if (turnstileEnabled) {
        // Token was consumed (or rejected): get a fresh challenge for any retry.
        setCaptchaToken(null);
        setCaptchaNonce((n) => n + 1);
      }
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
              {trialLabel} free trial
              {offer !== 'standard' ? ' · Limited offer' : ''}
              {cardRequired ? ' · Card required' : ' · No card needed'}
            </p>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mt-1">
              Start free trial &amp; choose your plan
            </h1>
            <p className="text-sm text-slate-600 mt-2">
              This is the only place to create a new EstimateAce account (from the website or Sign
              Up). Enter your details for a {trialLabel} free trial ({trialDays} days).
              {cardRequired
                ? ' A credit card is required to start, but you will not be charged until the trial ends. Cancel anytime before then and you pay nothing. '
                : ' No credit card is required to start. After the trial you will need to subscribe to the plan you choose below to keep access. '}
              Then use the same email and password to log in at app.estimateace.com.
              {cappedOffer ? ` This offer is limited to the first ${spots?.limit ?? CAPPED_OFFER_LIMIT} signups.` : ''}
            </p>
          </div>

          {cappedOffer && offerFull && (
            <div className="rounded-2xl border border-red-200 bg-red-50 text-red-900 text-sm p-4 leading-snug space-y-2">
              <p>
                <strong>This {trialLabel} offer is full.</strong> All {spots?.limit ?? CAPPED_OFFER_LIMIT}{' '}
                spots have been taken.
              </p>
              <p>
                You can still try EstimateAce free with our standard{' '}
                {DEFAULT_TRIAL_DAYS}-day trial.
              </p>
              <Link
                href={standardTrialHref}
                className="inline-block mt-1 rounded-xl bg-slate-900 text-white px-4 py-2 font-semibold"
              >
                Start the standard free trial
              </Link>
            </div>
          )}
          {cappedOffer && !offerFull && spots && (
            <p className="text-sm font-semibold text-emerald-700">
              {spots.remaining} of {spots.limit} spots left.
            </p>
          )}

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
              {cardRequired ? (
                <>
                  I understand this is a <strong>{trialLabel} free trial</strong> ({trialDays} days),
                  a card is required to start, and my card will be charged{' '}
                  <strong>{planPrice}</strong> ({planLabel.toLowerCase()}) when the trial ends unless I
                  cancel before then. I agree to the{' '}
                </>
              ) : (
                <>
                  I understand this is a <strong>{trialLabel} free trial</strong> ({trialDays} days), and
                  after that I will need to subscribe at <strong>{planPrice}</strong> (
                  {planLabel.toLowerCase()}) to keep using EstimateAce. I agree to the{' '}
                </>
              )}
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

          <TurnstileWidget key={`signup-captcha-${captchaNonce}`} action="signup" onToken={setCaptchaToken} />

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
            disabled={busy || offerFull}
            onClick={() => void startTrial()}
            className="w-full h-12 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white font-semibold disabled:opacity-50"
          >
            {busy
              ? 'Creating account…'
              : offerFull
                ? 'Offer full'
                : cardRequired
                  ? `Continue to add card · ${trialLabel} free trial`
                  : `Start ${trialLabel} free trial`}
          </button>
          {cardRequired && (
            <p className="text-center text-xs text-slate-600" data-testid="auto-renew-disclosure">
              <strong>Card required.</strong> You&apos;ll be charged {planPrice} after your{' '}
              {trialDays}-day trial unless you cancel. Renews automatically until canceled.
            </p>
          )}

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
