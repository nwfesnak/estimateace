'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { computeStripeCardFee, STRIPE_CARD_FIXED_USD, STRIPE_CARD_PERCENT } from '@/lib/stripe-fees';

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
  paymentOptions?: Array<{
    method: string;
    label: string;
    icon: string;
    description: string;
    howItWorks: string;
    ready: boolean;
    handle?: string;
    qrUrl?: string;
    payUrl?: string;
    clickToPay: boolean;
  }>;
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
  const [selectedMethod, setSelectedMethod] = useState<string | null>(null);
  const [infoBanner, setInfoBanner] = useState('');

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
  const payKind: 'deposit' | 'balance' = showDeposit ? 'deposit' : 'balance';
  const basePay = showDeposit ? depositDue : balanceDue;
  const paymentOptions = doc?.paymentOptions || [];
  const canPay = basePay >= 0.5;

  const startStripeCheckout = async (kind: 'deposit' | 'balance' = payKind) => {
    if (!token) return;
    setBusy(true);
    setError('');
    setInfoBanner('');
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
        setError(json.error || 'Could not start Stripe payment. Contact your contractor.');
        return;
      }
      window.location.href = json.url;
    } catch {
      setError('Network error starting payment.');
    } finally {
      setBusy(false);
    }
  };

  const handlePayOption = async (method: string) => {
    setSelectedMethod(method);
    setError('');
    setInfoBanner('');
    setApproved(true);

    const opt = paymentOptions.find((o) => o.method === method);
    if (!opt) return;

    if (method === 'stripe') {
      await startStripeCheckout(payKind);
      return;
    }

    if (opt.payUrl && (method === 'venmo' || method === 'paypal')) {
      window.open(opt.payUrl, '_blank', 'noopener,noreferrer');
      setInfoBanner(
        `Opened ${opt.label}. Complete payment there for ${money(basePay)}, then your contractor will mark this paid.`
      );
      return;
    }

    if (method === 'zelle') {
      setInfoBanner(
        `Send ${money(basePay)} via Zelle to ${opt.handle || 'the contractor'}. Put invoice # ${doc?.invoiceNumber || ''} in the memo.`
      );
      return;
    }

    if (method === 'mailcheck') {
      setInfoBanner(
        `Mail a check for ${money(basePay)} to:\n${opt.handle || 'address on file'}\nWrite # ${doc?.invoiceNumber || ''} on the memo line.`
      );
      return;
    }

    setInfoBanner(opt.howItWorks || 'Follow the instructions to complete payment.');
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

          {canPay && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm space-y-1">
              {(() => {
                const fee = computeStripeCardFee(basePay, {
                  percentRate: STRIPE_CARD_PERCENT,
                  fixedFee: STRIPE_CARD_FIXED_USD,
                });
                return (
                  <>
                    <p className="font-semibold text-amber-950">If you pay by card / Apple Pay / eCheck</p>
                    <div className="flex justify-between text-amber-900">
                      <span>{showDeposit ? 'Deposit' : 'Balance'}</span>
                      <span>{money(fee.baseAmount)}</span>
                    </div>
                    <div className="flex justify-between text-amber-900">
                      <span>
                        Card processing ({fee.percentRate}% + ${fee.fixedFee.toFixed(2)})
                      </span>
                      <span>{money(fee.feeAmount)}</span>
                    </div>
                    <div className="flex justify-between font-bold text-amber-950 pt-1 border-t border-amber-200">
                      <span>Stripe Checkout total</span>
                      <span>{money(fee.totalAmount)}</span>
                    </div>
                    <p className="text-[11px] text-amber-800/80 pt-1">
                      Venmo, PayPal, Zelle, and mail check use the base amount only (no card fee).
                    </p>
                  </>
                );
              })()}
            </div>
          )}

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2 whitespace-pre-wrap">
              {error}
            </p>
          )}
          {infoBanner && (
            <p className="text-sm text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2 whitespace-pre-wrap">
              {infoBanner}
            </p>
          )}

          {isEstimate && !approved && (
            <Button
              className="w-full py-6 text-lg bg-slate-800 hover:bg-slate-900 text-white rounded-xl"
              disabled={busy}
              onClick={() => setApproved(true)}
            >
              ✓ Approve estimate
            </Button>
          )}

          {isEstimate && approved && (
            <div className="rounded-xl border-2 border-emerald-500 bg-emerald-50 p-3 text-center">
              <p className="text-emerald-800 font-semibold">Estimate approved</p>
              <p className="text-sm text-emerald-700">Choose how you want to pay below.</p>
            </div>
          )}

          {/* All contractor-enabled payment methods */}
          {canPay && (!isEstimate || approved || showDeposit) && (
            <div className="space-y-3 pt-1">
              <p className="text-sm font-semibold text-slate-800">
                Pay {showDeposit ? 'deposit' : 'balance'} — {money(basePay)}
              </p>
              <p className="text-xs text-slate-500">
                Options enabled by {doc?.company || 'your contractor'}:
              </p>
              {paymentOptions.map((opt) => {
                const isStripe = opt.method === 'stripe';
                const cardTotal = isStripe
                  ? computeStripeCardFee(basePay).totalAmount
                  : basePay;
                return (
                  <button
                    key={opt.method}
                    type="button"
                    disabled={busy}
                    onClick={() => void handlePayOption(opt.method)}
                    className={`w-full text-left p-4 border-2 rounded-2xl transition ${
                      selectedMethod === opt.method
                        ? 'border-emerald-500 bg-emerald-50'
                        : 'border-slate-200 bg-white hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-3xl shrink-0">{opt.icon}</span>
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-slate-900">{opt.label}</div>
                        <div className="text-xs text-slate-600 mt-0.5">{opt.description}</div>
                        {opt.handle && opt.method !== 'stripe' && (
                          <div className="text-xs font-medium text-slate-800 mt-1">
                            {opt.method === 'venmo'
                              ? opt.handle
                              : opt.method === 'zelle'
                                ? `Send to: ${opt.handle}`
                                : opt.method === 'mailcheck'
                                  ? `Mail to: ${opt.handle}`
                                  : opt.handle}
                          </div>
                        )}
                        {opt.method === 'zelle' && opt.qrUrl && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={opt.qrUrl}
                            alt="Zelle QR"
                            className="mt-2 w-28 h-28 object-contain border rounded bg-white"
                          />
                        )}
                        <p className="text-[11px] text-slate-500 mt-1">{opt.howItWorks}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-sm font-bold text-emerald-700">
                          {money(cardTotal)}
                        </div>
                        {isStripe && (
                          <div className="text-[10px] text-slate-500">incl. card fee</div>
                        )}
                        <div className="text-xs font-semibold text-emerald-600 mt-1">
                          {busy && selectedMethod === opt.method ? '…' : 'Pay →'}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
              {paymentOptions.length === 0 && (
                <Button
                  className="w-full py-6 bg-emerald-600 text-white"
                  disabled={busy}
                  onClick={() => void startStripeCheckout(payKind)}
                >
                  {busy ? 'Starting…' : `Pay with Stripe (${money(computeStripeCardFee(basePay).totalAmount)})`}
                </Button>
              )}
            </div>
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
