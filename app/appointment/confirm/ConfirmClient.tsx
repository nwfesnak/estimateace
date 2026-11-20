'use client';

import { useEffect, useMemo, useState } from 'react';

type ConfirmPayload = {
  ok?: boolean;
  error?: string;
  companyName?: string;
  jobName?: string;
  reference?: string;
  formattedWhen?: string;
  location?: string;
  alreadyConfirmed?: boolean;
  confirmedAt?: string | null;
  expired?: boolean;
  confirmed?: boolean;
};

function readToken(): string {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.search);
  return String(params.get('t') || params.get('token') || '').trim();
}

export function AppointmentConfirmClient() {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [data, setData] = useState<ConfirmPayload | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const t = readToken();
    setToken(t);
    if (!t) {
      setError('This confirmation link is invalid or has expired.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/appointment-confirm?t=${encodeURIComponent(t)}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        const body = (await res.json().catch(() => ({}))) as ConfirmPayload;
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error || 'This confirmation link is invalid or has expired.');
          setData(null);
        } else {
          setData(body);
          setError('');
        }
      } catch {
        if (!cancelled) setError('Could not load this appointment. Please try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const already = Boolean(data?.alreadyConfirmed || data?.confirmed);
  const expired = Boolean(data?.expired) && !already;

  const heading = useMemo(() => {
    if (already) return 'Appointment confirmed';
    if (expired) return 'This link has expired';
    return 'Confirm your appointment';
  }, [already, expired]);

  const confirm = async () => {
    if (!token || submitting || already || expired) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/appointment-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ token }),
      });
      const body = (await res.json().catch(() => ({}))) as ConfirmPayload;
      if (!res.ok) {
        setError(body.error || 'Could not confirm this appointment. Please try again.');
        return;
      }
      setData({ ...data, ...body, alreadyConfirmed: true, confirmed: true });
    } catch {
      setError('Could not confirm this appointment. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 sm:py-12">
      <div
        className="mx-auto w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
        data-testid="appointment-confirm-page"
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
          {data?.companyName || 'EstimateAce'}
        </p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">{heading}</h1>

        {loading ? (
          <p className="mt-4 text-sm text-slate-600">Loading your appointment…</p>
        ) : error && !data ? (
          <p className="mt-4 text-sm text-slate-600" data-testid="appointment-confirm-error">
            {error}
          </p>
        ) : (
          <>
            <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
              {data?.jobName ? (
                <div className="mb-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-800">Job</div>
                  <div className="text-sm font-semibold text-slate-900">
                    {data.jobName}
                    {data.reference ? ` (${data.reference})` : ''}
                  </div>
                </div>
              ) : data?.reference ? (
                <div className="mb-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-800">Reference</div>
                  <div className="text-sm font-semibold text-slate-900">{data.reference}</div>
                </div>
              ) : null}
              {data?.formattedWhen ? (
                <div className="mb-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-800">Date & time</div>
                  <div className="text-sm font-semibold text-slate-900">{data.formattedWhen}</div>
                </div>
              ) : null}
              {data?.location ? (
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-800">Location</div>
                  <div className="text-sm text-slate-800">{data.location}</div>
                </div>
              ) : null}
            </div>

            {already ? (
              <p
                className="mt-5 rounded-xl bg-emerald-600 px-4 py-3 text-center text-sm font-semibold text-white"
                data-testid="appointment-confirm-success"
              >
                ✓ You&apos;re confirmed. We&apos;ve let {data?.companyName || 'your contractor'} know.
              </p>
            ) : expired ? (
              <p className="mt-5 text-sm text-slate-600">
                This appointment time has passed, so the confirmation link has expired. Please contact{' '}
                {data?.companyName || 'your contractor'} if you still need to confirm.
              </p>
            ) : (
              <>
                <p className="mt-5 text-sm text-slate-600">
                  Tap Confirm to let {data?.companyName || 'your contractor'} know you can make this appointment.
                </p>
                <button
                  type="button"
                  data-testid="appointment-confirm-button"
                  className="mt-4 w-full rounded-xl bg-[#10b981] px-4 py-3 text-base font-bold text-white hover:bg-[#0d9668] disabled:opacity-60"
                  disabled={submitting}
                  onClick={() => void confirm()}
                >
                  {submitting ? 'Confirming…' : 'Confirm appointment'}
                </button>
              </>
            )}

            {error && data ? (
              <p className="mt-3 text-sm text-red-700" data-testid="appointment-confirm-error">
                {error}
              </p>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
