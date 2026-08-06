'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';

type PlanView = {
  id: string;
  serviceName: string;
  clientName: string;
  amount: number;
  interval: string;
  intervalLabel: string;
  description: string;
  status: string;
  address: string;
  amountLabel: string;
};

function SubscribeInner() {
  const searchParams = useSearchParams();
  const token = useMemo(() => String(searchParams.get('token') || '').trim(), [searchParams]);
  const subscribed = searchParams.get('subscribed');

  const [plan, setPlan] = useState<PlanView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setError('This link is missing. Ask your contractor to send a new subscribe link.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/client/recurring?token=${encodeURIComponent(token)}`);
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error || 'Could not load this service plan.');
          setLoading(false);
          return;
        }
        setPlan(json.plan);
      } catch {
        if (!cancelled) setError('Network error loading plan.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const startSubscribe = async () => {
    if (!token) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/client/recurring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.url) {
        setError(json.error || 'Could not start payment setup.');
        return;
      }
      window.location.href = json.url;
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <p className="text-slate-600">Loading…</p>
      </div>
    );
  }

  if (error && !plan) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md w-full bg-white rounded-2xl border shadow-sm p-6 text-center">
          <h1 className="text-xl font-semibold mb-2">Link problem</h1>
          <p className="text-slate-600">{error}</p>
        </div>
      </div>
    );
  }

  const isActive = plan?.status === 'active' || subscribed === '1';

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="max-w-lg mx-auto bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="bg-teal-700 text-white px-6 py-5">
          <p className="text-sm text-teal-100">Recurring service</p>
          <h1 className="text-2xl font-bold mt-1">{plan?.serviceName}</h1>
          <p className="text-teal-50 mt-1">
            {plan?.amountLabel} {plan?.intervalLabel}
          </p>
        </div>

        <div className="p-6 space-y-4">
          {subscribed === '1' && (
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 px-4 py-3 text-sm">
              You&apos;re set up — thanks! Your contractor will bill this service automatically.
            </div>
          )}
          {subscribed === '0' && (
            <div className="rounded-xl bg-amber-50 border border-amber-200 text-amber-900 px-4 py-3 text-sm">
              Checkout was cancelled. You can try again below anytime.
            </div>
          )}

          {plan?.clientName ? (
            <div>
              <p className="text-sm text-slate-500">Client</p>
              <p className="font-semibold">{plan.clientName}</p>
            </div>
          ) : null}
          {plan?.address ? (
            <div>
              <p className="text-sm text-slate-500">Service address</p>
              <p className="font-medium text-slate-800">{plan.address}</p>
            </div>
          ) : null}
          {plan?.description ? (
            <div className="rounded-xl bg-slate-50 border p-4 text-sm text-slate-700 whitespace-pre-wrap">
              {plan.description}
            </div>
          ) : null}

          <div className="rounded-xl border-2 border-teal-200 bg-teal-50 p-4 text-center">
            <p className="text-sm text-teal-800">Automatic charge</p>
            <p className="text-3xl font-bold text-teal-900 mt-1">
              {plan?.amountLabel}
              <span className="text-base font-semibold text-teal-700"> / {plan?.interval}</span>
            </p>
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          {isActive ? (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-center text-emerald-900 font-semibold">
              Subscription active
            </div>
          ) : (
            <Button
              className="w-full py-7 text-lg bg-teal-700 hover:bg-teal-800 text-white rounded-xl font-semibold"
              disabled={busy || plan?.status === 'canceled'}
              onClick={() => void startSubscribe()}
            >
              {busy
                ? 'Starting secure checkout…'
                : `Subscribe — ${plan?.amountLabel} ${plan?.intervalLabel}`}
            </Button>
          )}

          <p className="text-[11px] text-center text-slate-500 leading-relaxed">
            You are paying your contractor for this service only. This is not an EstimateAce software
            subscription.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function ClientSubscribePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
          <p className="text-slate-600">Loading…</p>
        </div>
      }
    >
      <SubscribeInner />
    </Suspense>
  );
}
