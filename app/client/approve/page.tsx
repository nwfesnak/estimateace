'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';

type DocPayload = {
  ok?: boolean;
  documentType?: string;
  invoiceNumber?: string;
  jobName?: string;
  company?: string;
  companyPhone?: string;
  companyEmail?: string;
  address?: string;
  date?: string;
  grandTotal?: number;
  amountPaid?: number;
  balanceDue?: number;
  subtotalBeforeDiscount?: number;
  discountAmount?: number;
  discountDescription?: string;
  discountType?: string;
  discountValue?: number;
  taxAmount?: number;
  depositPercent?: number;
  depositDue?: number;
  showDeposit?: boolean;
  paymentStatus?: string;
  terms?: string;
  items?: Array<{ description: string; qty: number; total: number }>;
  message?: string;
  error?: string;
};


function money(n: number) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function ApprovePayInner() {
  const searchParams = useSearchParams();
  const token = useMemo(() => String(searchParams.get('token') || '').trim(), [searchParams]);
  const paidFlag = searchParams.get('paid');

  const [doc, setDoc] = useState<DocPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    if (!token) {
      setError('This link is missing or incomplete. Ask your contractor to resend the estimate.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/client/document?token=${encodeURIComponent(token)}`);
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error || 'Could not load this document.');
          setLoading(false);
          return;
        }
        setDoc(json);
        if (paidFlag === '1') setApproved(true);
      } catch {
        if (!cancelled) setError('Network error loading document.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, paidFlag]);

  const isEstimate = (doc?.documentType || 'estimate') !== 'invoice';
  const depositDue = Number(doc?.depositDue) || 0;
  const balanceDue = Number(doc?.balanceDue) || 0;
  const showDeposit = !!doc?.showDeposit && depositDue >= 0.5;

  const startCheckout = async (kind: 'deposit' | 'balance') => {
    if (!token) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/client/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          kind,
          amount: kind === 'deposit' ? depositDue : balanceDue,
          grandTotal: doc?.grandTotal,
          depositPercent: doc?.depositPercent,
          jobName: doc?.jobName,
          clientEmail: doc?.companyEmail,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.url) {
        setError(json.error || 'Could not start payment. Contact your contractor.');
        return;
      }
      window.location.href = json.url;
    } catch {
      setError('Network error starting payment.');
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

  if (error && !doc) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md w-full bg-white rounded-2xl border shadow-sm p-6 text-center">
          <h1 className="text-xl font-semibold text-slate-900 mb-2">Link problem</h1>
          <p className="text-slate-600">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="max-w-lg mx-auto bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="bg-emerald-600 text-white px-6 py-5">
          <p className="text-sm text-emerald-100">EstimateAce</p>
          <h1 className="text-2xl font-bold mt-1">{doc?.company || 'Your contractor'}</h1>
          <p className="text-emerald-50 mt-1">
            {isEstimate ? 'Estimate' : 'Invoice'} {doc?.invoiceNumber || ''}
          </p>
        </div>

        <div className="p-6 space-y-4">
          {paidFlag === '1' && (
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 px-4 py-3 text-sm">
              Payment received — thank you! Your contractor will follow up shortly.
            </div>
          )}
          {paidFlag === '0' && (
            <div className="rounded-xl bg-amber-50 border border-amber-200 text-amber-900 px-4 py-3 text-sm">
              Payment was cancelled. You can try again below anytime.
            </div>
          )}

          <div>
            <p className="text-sm text-slate-500">Client / job</p>
            <p className="font-semibold text-slate-900">{doc?.jobName}</p>
            {doc?.address ? <p className="text-sm text-slate-600 mt-1">{doc.address}</p> : null}
          </div>

          {Array.isArray(doc?.items) && doc!.items!.length > 0 && (
            <div className="border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="text-left p-2">Description</th>
                    <th className="text-right p-2">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {doc!.items!.map((it, i) => (
                    <tr key={i} className="border-t">
                      <td className="p-2 text-slate-800">{it.description}</td>
                      <td className="p-2 text-right whitespace-nowrap">{money(it.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="rounded-xl bg-slate-50 p-4 space-y-1">
            {(Number(doc?.discountAmount) || 0) > 0.005 && (
              <>
                <div className="flex justify-between text-sm text-slate-600">
                  <span>Subtotal</span>
                  <span>
                    {money(
                      Number(doc?.subtotalBeforeDiscount) ||
                        Number(doc?.grandTotal) + Number(doc?.discountAmount) ||
                        0
                    )}
                  </span>
                </div>
                <div className="flex justify-between text-sm font-semibold text-red-700">
                  <span>
                    Discount
                    {doc?.discountDescription ? ` — ${doc.discountDescription}` : ''}
                    {doc?.discountType === 'percent' && Number(doc?.discountValue) > 0
                      ? ` (${doc.discountValue}%)`
                      : ''}
                  </span>
                  <span>−{money(Number(doc?.discountAmount) || 0)}</span>
                </div>
                {(Number(doc?.taxAmount) || 0) > 0 && (
                  <div className="flex justify-between text-sm text-slate-600">
                    <span>Tax</span>
                    <span>{money(Number(doc?.taxAmount) || 0)}</span>
                  </div>
                )}
              </>
            )}
            <div className="flex justify-between text-lg font-bold">
              <span>Grand total</span>
              <span className="text-emerald-700">{money(Number(doc?.grandTotal) || 0)}</span>
            </div>
            {(Number(doc?.amountPaid) || 0) > 0 && (
              <div className="flex justify-between text-sm text-slate-600">
                <span>Amount paid</span>
                <span>{money(Number(doc?.amountPaid) || 0)}</span>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span>Balance due</span>
              <span className="font-semibold">{money(balanceDue)}</span>
            </div>
            {showDeposit && (
              <div className="flex justify-between text-sm text-emerald-800 pt-2 border-t mt-2">
                <span>Deposit ({doc?.depositPercent || 0}%)</span>
                <span className="font-semibold">{money(depositDue)}</span>
              </div>
            )}
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>
          )}

          {isEstimate ? (
            <div className="space-y-3 pt-2">
              {!approved ? (
                <Button
                  className="w-full py-6 text-lg bg-slate-800 hover:bg-slate-900 text-white rounded-xl"
                  disabled={busy}
                  onClick={() => setApproved(true)}
                >
                  ✓ Approve estimate
                </Button>
              ) : (
                <div className="rounded-xl border-2 border-emerald-500 bg-emerald-50 p-4 text-center">
                  <p className="text-emerald-800 font-semibold text-lg">Estimate approved</p>
                  <p className="text-sm text-emerald-700 mt-1">
                    Next step: pay the deposit if required, or contact {doc?.company || 'your contractor'}.
                  </p>
                </div>
              )}

              {showDeposit && (
                <Button
                  className="w-full py-7 text-lg bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-semibold shadow-md"
                  disabled={busy}
                  onClick={() => {
                    setApproved(true);
                    void startCheckout('deposit');
                  }}
                >
                  {busy ? 'Starting checkout…' : `Approve & pay deposit (${money(depositDue)})`}
                </Button>
              )}

              {!showDeposit && approved && balanceDue >= 0.5 && (
                <Button
                  className="w-full py-6 text-lg bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl"
                  disabled={busy}
                  onClick={() => void startCheckout('balance')}
                >
                  {busy ? 'Starting checkout…' : `Pay now (${money(balanceDue)})`}
                </Button>
              )}
            </div>
          ) : (
            balanceDue >= 0.5 && (
              <Button
                className="w-full py-7 text-lg bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-semibold"
                disabled={busy}
                onClick={() => void startCheckout('balance')}
              >
                {busy ? 'Starting checkout…' : `Pay balance (${money(balanceDue)})`}
              </Button>
            )
          )}

          {/* Terms as hyperlink (full text on /client/terms) */}
          {String(doc?.terms || '').trim() ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-center">
              <a
                href={`/client/terms?token=${encodeURIComponent(token)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-semibold text-teal-800 underline underline-offset-2"
              >
                View Terms &amp; Conditions
              </a>
              <p className="text-[11px] text-slate-500 mt-1">Opens full terms in a new tab</p>
            </div>
          ) : null}

          <div className="pt-4 border-t text-sm text-slate-600 space-y-1">
            <p className="font-medium text-slate-800">Questions?</p>
            {doc?.companyPhone ? <p>Phone: {doc.companyPhone}</p> : null}
            {doc?.companyEmail ? <p>Email: {doc.companyEmail}</p> : null}
            {!doc?.companyPhone && !doc?.companyEmail ? (
              <p>Reply to the estimate email to reach your contractor.</p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ClientApprovePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
          <p className="text-slate-600">Loading…</p>
        </div>
      }
    >
      <ApprovePayInner />
    </Suspense>
  );
}
