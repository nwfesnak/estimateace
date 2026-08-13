'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  computeStripeCardFee,
  methodHasProcessingFee,
  STRIPE_CARD_FIXED_USD,
  STRIPE_CARD_PERCENT,
} from '@/lib/stripe-fees';

type PayOption = {
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
  baseAmount?: number;
  feeAmount?: number;
  totalAmount?: number;
  feeLabel?: string;
  feeDescription?: string;
};

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
  amountDueNow?: number;
  payKind?: 'deposit' | 'balance';
  payLabel?: string;
  paymentStatus?: string;
  terms?: string;
  chargeCCFee?: boolean;
  ccFeePercentage?: number;
  items?: Array<{ description: string; qty: number; total: number }>;
  paymentOptions?: PayOption[];
  message?: string;
  error?: string;
};

/** Zelle / mail check always $0 fee. Card / Venmo / PayPal keep (or recompute) processing fee. */
function sanitizePayOptions(
  raw: PayOption[] | undefined,
  basePay: number,
  feePercent: number
): PayOption[] {
  return (raw || []).map((opt) => {
    const method = String(opt.method || '').toLowerCase();
    const base =
      Number(opt.baseAmount) > 0 ? Number(opt.baseAmount) : Math.max(0, Number(basePay) || 0);
    const freeMethod = !methodHasProcessingFee(method);

    // Zelle / mail check / cash — never a processing fee
    if (freeMethod) {
      let description = String(opt.description || '');
      description = description
        .replace(/\s*\(includes processing fee\)/gi, '')
        .replace(/\s*—?\s*includes processing fee/gi, '')
        .trim();
      if (method === 'zelle') {
        description = 'Bank-to-bank transfer — no processing fee';
      } else if (method === 'mailcheck' || method === 'check') {
        description = 'Paper check by mail — no processing fee';
      }
      return {
        ...opt,
        description,
        howItWorks:
          method === 'zelle'
            ? 'Send the amount shown via your bank’s Zelle. Put the invoice # in the memo. No processing fee.'
            : method === 'mailcheck' || method === 'check'
              ? 'Mail a check for the amount shown. Write the invoice number on the memo line. No processing fee.'
              : opt.howItWorks,
        baseAmount: base,
        feeAmount: 0,
        totalAmount: base,
        feeLabel: 'No processing fee',
        feeDescription: 'No processing fee for this payment method',
      };
    }

    // Stripe / Venmo / PayPal — always include processing fee
    let feeAmt = Math.max(0, Number(opt.feeAmount) || 0);
    let total = Number(opt.totalAmount) > 0 ? Number(opt.totalAmount) : 0;
    if (feeAmt < 0.01) {
      const recomputed = computeStripeCardFee(base, {
        chargeFees: true,
        method,
        percentRate: feePercent > 0 ? feePercent : undefined,
        fixedFee: STRIPE_CARD_FIXED_USD,
      });
      feeAmt = recomputed.feeAmount;
      total = recomputed.totalAmount;
    }
    if (!(total > 0)) total = Math.round((base + feeAmt) * 100) / 100;

    return {
      ...opt,
      baseAmount: base,
      feeAmount: feeAmt,
      totalAmount: total,
      feeLabel: opt.feeLabel || 'Processing fee',
      description:
        method === 'stripe'
          ? opt.description || 'Pay securely with Stripe Checkout'
          : method === 'venmo'
            ? 'Pay in the Venmo app (includes processing fee)'
            : method === 'paypal'
              ? 'PayPal balance, bank, or card (includes processing fee)'
              : opt.description,
    };
  });
}


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
  /** Required when contractor attached Terms & Conditions */
  const [termsAccepted, setTermsAccepted] = useState(false);
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
  const amountPaid = Number(doc?.amountPaid) || 0;
  const grandTotal = Number(doc?.grandTotal) || 0;
  // Estimate → deposit; invoice → full remaining (total − deposit already paid)
  const payKind: 'deposit' | 'balance' =
    doc?.payKind === 'deposit' || (!!doc?.showDeposit && depositDue >= 0.5)
      ? 'deposit'
      : 'balance';
  const basePay =
    Number(doc?.amountDueNow) > 0
      ? Number(doc?.amountDueNow)
      : payKind === 'deposit'
        ? depositDue
        : balanceDue;
  const payLabel =
    doc?.payLabel ||
    (payKind === 'deposit'
      ? 'Deposit due'
      : amountPaid > 0
        ? 'Balance due (after deposit)'
        : 'Total due');
  const feePercent =
    Number(doc?.ccFeePercentage) > 0 ? Number(doc?.ccFeePercentage) : STRIPE_CARD_PERCENT;
  // Card / Venmo / PayPal always charge fee; Zelle / mail never (sanitizePayOptions)
  const paymentOptions = useMemo(
    () => sanitizePayOptions(doc?.paymentOptions, basePay, feePercent),
    [doc?.paymentOptions, basePay, feePercent]
  );
  const canPay = basePay >= 0.5;
  const hasTerms = Boolean(String(doc?.terms || '').trim());
  /** Block approve/pay until client confirms they read terms (only when terms exist) */
  const termsGateOk = !hasTerms || termsAccepted;

  const requireTermsOrError = () => {
    if (termsGateOk) return true;
    setError(
      'Please read the Terms & Conditions and check the box to confirm before continuing.'
    );
    return false;
  };

  const startStripeCheckout = async (kind: 'deposit' | 'balance' = payKind) => {
    if (!token) return;
    if (!requireTermsOrError()) return;
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
    if (!requireTermsOrError()) return;
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

    const totalWithFee = Number(opt.totalAmount) > 0 ? Number(opt.totalAmount) : basePay;
    const feeAmt = Number(opt.feeAmount) || 0;

    if (opt.payUrl && (method === 'venmo' || method === 'paypal')) {
      window.open(opt.payUrl, '_blank', 'noopener,noreferrer');
      setInfoBanner(
        `Opened ${opt.label}. Pay ${money(totalWithFee)}` +
          (feeAmt > 0
            ? ` (includes ${money(feeAmt)} ${opt.feeLabel || 'processing fee'})`
            : '') +
          `. Your contractor will mark the job paid when funds arrive.`
      );
      return;
    }

    if (method === 'zelle') {
      setInfoBanner(
        `Send ${money(totalWithFee)} via Zelle to ${opt.handle || 'the contractor'}` +
          (feeAmt > 0 ? ` (job ${money(basePay)} + ${money(feeAmt)} fee)` : '') +
          `. Put invoice # ${doc?.invoiceNumber || ''} in the memo.`
      );
      return;
    }

    if (method === 'mailcheck') {
      setInfoBanner(
        `Mail a check for ${money(totalWithFee)} to:\n${opt.handle || 'address on file'}\n` +
          (feeAmt > 0 ? `(Job ${money(basePay)} + ${money(feeAmt)} processing fee)\n` : '') +
          `Write # ${doc?.invoiceNumber || ''} on the memo line.`
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
              <span>{payLabel}</span>
              <span className="font-semibold">{money(basePay)}</span>
            </div>
            {payKind === 'deposit' && depositDue >= 0.5 && (
              <div className="flex justify-between text-sm text-emerald-800 pt-2 border-t mt-2">
                <span>Deposit ({doc?.depositPercent || 0}%)</span>
                <span className="font-semibold">{money(depositDue)}</span>
              </div>
            )}
          </div>

          {/* Amount due summary */}
          {canPay && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm space-y-1">
              <div className="flex justify-between font-semibold text-slate-900">
                <span>{payLabel}</span>
                <span>{money(basePay)}</span>
              </div>
              {isEstimate && payKind === 'deposit' && (
                <p className="text-xs text-slate-600">
                  Deposit only. Remaining balance after deposit: {money(Math.max(0, grandTotal - basePay))}
                  {amountPaid > 0 ? ` (already paid ${money(amountPaid)})` : ''}.
                </p>
              )}
              {!isEstimate && amountPaid > 0 && (
                <p className="text-xs text-slate-600">
                  Job total {money(grandTotal)} − deposit/payments {money(amountPaid)} = balance due.
                </p>
              )}
              <p className="text-[11px] text-amber-800 pt-1">
                Card, Venmo, and PayPal include a processing fee. Zelle and mail check have no
                processing fee.
              </p>
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

          {/* Terms must be accepted before approve/pay when contractor set them up */}
          {hasTerms && (
            <div className="rounded-xl border-2 border-teal-300 bg-teal-50/80 p-4 space-y-3">
              <div className="text-center">
                <a
                  href={`/client/terms?token=${encodeURIComponent(token)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-semibold text-teal-900 underline underline-offset-2"
                >
                  View Terms &amp; Conditions
                </a>
                <p className="text-[11px] text-teal-800/80 mt-1">
                  Opens full terms in a new tab — please read before continuing
                </p>
              </div>
              <label className="flex items-start gap-3 cursor-pointer select-none rounded-lg border border-teal-200 bg-white p-3">
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5 shrink-0 accent-teal-700"
                  checked={termsAccepted}
                  onChange={(e) => {
                    setTermsAccepted(e.target.checked);
                    if (e.target.checked) setError('');
                  }}
                />
                <span className="text-sm text-slate-800 leading-snug">
                  <strong>I have read and agree</strong> to the Terms &amp; Conditions for this{' '}
                  {isEstimate ? 'estimate' : 'invoice'}.
                </span>
              </label>
              {!termsAccepted && (
                <p className="text-xs text-amber-900 text-center font-medium">
                  Check the box above to enable approve and payment options.
                </p>
              )}
            </div>
          )}

          {isEstimate && !approved && (
            <Button
              className="w-full py-6 text-lg bg-slate-800 hover:bg-slate-900 text-white rounded-xl disabled:opacity-50"
              disabled={busy || !termsGateOk}
              onClick={() => {
                if (!requireTermsOrError()) return;
                setApproved(true);
                setError('');
              }}
            >
              ✓ Approve estimate
            </Button>
          )}

          {isEstimate && approved && (
            <div className="rounded-xl border-2 border-emerald-500 bg-emerald-50 p-3 text-center">
              <p className="text-emerald-800 font-semibold">Estimate approved</p>
              <p className="text-sm text-emerald-700">Choose how you want to pay the deposit below.</p>
            </div>
          )}

          {/* All contractor-enabled methods — totals include processing fee */}
          {canPay && (!isEstimate || approved || payKind === 'deposit') && (
            <div className={`space-y-3 pt-1 ${!termsGateOk ? 'opacity-60' : ''}`}>
              <p className="text-sm font-semibold text-slate-800">
                {payLabel} — choose a payment method
              </p>
              <p className="text-xs text-slate-500">
                Options enabled by {doc?.company || 'your contractor'}:
              </p>
              {paymentOptions.map((opt) => {
                const total = Number(opt.totalAmount) > 0 ? Number(opt.totalAmount) : basePay;
                const feeAmt = Number(opt.feeAmount) || 0;
                return (
                  <button
                    key={opt.method}
                    type="button"
                    disabled={busy || !termsGateOk}
                    onClick={() => void handlePayOption(opt.method)}
                    className={`w-full text-left p-4 border-2 rounded-2xl transition ${
                      selectedMethod === opt.method
                        ? 'border-emerald-500 bg-emerald-50'
                        : 'border-slate-200 bg-white hover:bg-slate-50'
                    } disabled:cursor-not-allowed disabled:opacity-70`}
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
                        <div className="mt-2 text-[11px] text-slate-600 space-y-0.5">
                          <div className="flex justify-between gap-2">
                            <span>{payLabel}</span>
                            <span>{money(Number(opt.baseAmount) || basePay)}</span>
                          </div>
                          {feeAmt > 0 ? (
                            <div className="flex justify-between gap-2 text-amber-800">
                              <span>{opt.feeLabel || 'Processing fee'}</span>
                              <span>{money(feeAmt)}</span>
                            </div>
                          ) : (
                            <div className="flex justify-between gap-2 text-emerald-700 font-medium">
                              <span>Processing fee</span>
                              <span>None</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-sm font-bold text-emerald-700">{money(total)}</div>
                        <div className="text-[10px] text-slate-500">you pay</div>
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
                  className="w-full py-6 bg-emerald-600 text-white disabled:opacity-50"
                  disabled={busy || !termsGateOk}
                  onClick={() => void startStripeCheckout(payKind)}
                >
                  {busy
                    ? 'Starting…'
                    : `Pay with Stripe (${money(
                        computeStripeCardFee(basePay, {
                          chargeFees: true,
                          percentRate: feePercent,
                          fixedFee: STRIPE_CARD_FIXED_USD,
                        }).totalAmount
                      )})`}
                </Button>
              )}
            </div>
          )}

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
