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
import { quoteTotalsForItems } from '@/lib/optional-line-items';
import { openPayPalPaymentPage, openVenmoPaymentPage } from '@/lib/payment-links';

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
  clientEmail?: string;
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
  taxRate?: number;
  isTaxExempt?: boolean;
  taxesEnabled?: boolean;
  depositPercent?: number;
  depositDue?: number;
  showDeposit?: boolean;
  amountDueNow?: number;
  payKind?: 'deposit' | 'balance';
  payLabel?: string;
  paymentStatus?: string;
  terms?: string;
  termsDisplayMode?: 'link' | 'printed';
  chargeCCFee?: boolean;
  ccFeePercentage?: number;
  estimateApproved?: boolean;
  approvedAt?: string | null;
  approvedBy?: string | null;
  items?: Array<{
    id?: string;
    description: string;
    qty: number;
    total: number;
    optional?: boolean;
    clientSelected?: boolean;
  }>;
  paymentOptions?: PayOption[];
  message?: string;
  error?: string;
};

/**
 * Zelle / mail check always $0 fee.
 * Card / PayPal: fee only when contractor enabled chargeCCFee. Venmo never.
 */
function sanitizePayOptions(
  raw: PayOption[] | undefined,
  basePay: number,
  feePercent: number,
  chargeFees: boolean
): PayOption[] {
  return (raw || []).map((opt) => {
    const method = String(opt.method || '').toLowerCase();
    const base =
      Number(opt.baseAmount) > 0 ? Number(opt.baseAmount) : Math.max(0, Number(basePay) || 0);
    const freeMethod = !methodHasProcessingFee(method);

    // Zelle / mail check / cash — never a processing fee
    // Also zero fees when contractor turned off chargeCCFee
    if (freeMethod || !chargeFees) {
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
        description: freeMethod
          ? description
          : description || opt.description || 'Pay securely',
        howItWorks: freeMethod
          ? method === 'zelle'
            ? 'Send the amount shown via your bank’s Zelle. Put the invoice # in the memo. No processing fee.'
            : method === 'mailcheck' || method === 'check'
              ? 'Mail a check for the amount shown. Write the invoice number on the memo line. No processing fee.'
              : opt.howItWorks
          : opt.howItWorks,
        baseAmount: base,
        feeAmount: 0,
        totalAmount: base,
        feeLabel: 'No processing fee',
        feeDescription: 'No processing fee for this payment method',
      };
    }

    // Stripe / PayPal — fee when contractor opted in
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
            ? 'Pay in the Venmo app — no processing fee'
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
  const [showOtherPays, setShowOtherPays] = useState(false);
  const [infoBanner, setInfoBanner] = useState('');
  /** Optional line ids the client wants to add */
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);

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
        const chosen = (Array.isArray(json.items) ? json.items : [])
          .filter((it: any) => it?.optional && it?.clientSelected && it?.id)
          .map((it: any) => String(it.id));
        setSelectedOptionIds(chosen);
        if (paidFlag === '1' || json.estimateApproved) setApproved(true);
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

  const persistClientApproval = async () => {
    if (!token) return false;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/client/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, selectedOptionIds }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || 'Could not save approval. Try again.');
        return false;
      }
      setApproved(true);
      setDoc((prev) =>
        prev
          ? {
              ...prev,
              estimateApproved: true,
              approvedAt: json.approvedAt || prev.approvedAt,
              approvedBy: 'client',
              items: (prev.items || []).map((it) =>
                it.optional
                  ? { ...it, clientSelected: selectedOptionIds.includes(String(it.id || '')) }
                  : it
              ),
            }
          : prev
      );
      try {
        const reload = await fetch(`/api/client/document?token=${encodeURIComponent(token)}`);
        const fresh = await reload.json().catch(() => ({}));
        if (reload.ok) setDoc(fresh);
      } catch {
        /* approval already saved */
      }
      setInfoBanner('Estimate approved — your contractor can schedule the job. It is not an invoice yet.');
      return true;
    } catch {
      setError('Network error saving approval.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const isEstimate = (doc?.documentType || 'estimate') !== 'invoice';
  const docItems = Array.isArray(doc?.items) ? doc.items : [];
  const optionalItems = docItems.filter((it) => it.optional);
  const requiredItems = docItems.filter((it) => !it.optional);
  const hasOptionalLines = optionalItems.length > 0;
  const allLinesOptional = hasOptionalLines && requiredItems.length === 0;
  const choicePreview = useMemo(
    () =>
      quoteTotalsForItems({
        items: docItems.map((it, index) => ({
          ...it,
          id: it.id || `idx-${index}`,
        })),
        selectedIds: selectedOptionIds,
        discount: {
          description: doc?.discountDescription,
          value: Number(doc?.discountValue) || 0,
          type: doc?.discountType,
          amount: Number(doc?.discountAmount) || 0,
        },
        taxRate: Number(doc?.taxRate) || 0,
        taxesEnabled: doc?.taxesEnabled !== false,
        isTaxExempt: !!doc?.isTaxExempt,
      }),
    [docItems, selectedOptionIds, doc?.discountDescription, doc?.discountValue, doc?.discountType, doc?.discountAmount, doc?.taxRate, doc?.taxesEnabled, doc?.isTaxExempt]
  );
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
  const chargeFees = doc?.chargeCCFee === true;
  const feePercent = chargeFees
    ? Number(doc?.ccFeePercentage) > 0
      ? Number(doc?.ccFeePercentage)
      : STRIPE_CARD_PERCENT
    : 0;
  // Fees only if contractor enabled chargeCCFee; Zelle / mail never
  const paymentOptions = useMemo(
    () => sanitizePayOptions(doc?.paymentOptions, basePay, feePercent, chargeFees),
    [doc?.paymentOptions, basePay, feePercent, chargeFees]
  );
  const primaryPay = paymentOptions.find((o) => o.method === 'stripe') || paymentOptions[0];
  const otherPays = primaryPay
    ? paymentOptions.filter((o) => o.method !== primaryPay.method)
    : [];
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

  const startStripeCheckout = async (
    kind: 'deposit' | 'balance' = payKind,
    method: 'card' | 'bank' = 'card'
  ) => {
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
          method,
          amount: kind === 'deposit' ? depositDue : balanceDue,
          grandTotal: doc?.grandTotal,
          depositPercent: doc?.depositPercent,
          jobName: doc?.jobName,
          clientEmail: doc?.clientEmail || '',
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

    if (method === 'stripe' || method === 'ach') {
      await startStripeCheckout(payKind, method === 'ach' ? 'bank' : 'card');
      return;
    }

    const totalWithFee = Number(opt.totalAmount) > 0 ? Number(opt.totalAmount) : basePay;
    const feeAmt = Number(opt.feeAmount) || 0;
    const payNote = [doc?.company, doc?.invoiceNumber, payLabel].filter(Boolean).join(' · ');

    if (method === 'venmo' || method === 'paypal') {
      const opened =
        method === 'venmo'
          ? openVenmoPaymentPage(opt.handle || '', totalWithFee, payNote)
          : openPayPalPaymentPage(opt.handle || '', totalWithFee, payNote);
      if (!opened) {
        setError(
          method === 'venmo'
            ? 'Could not open Venmo. Send the amount to the @username shown.'
            : 'Could not open PayPal. Use the PayPal name shown on this page.'
        );
        return;
      }
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
          <p className="text-sm text-emerald-100">
            {isEstimate ? 'Review this estimate' : 'Pay this invoice'}
          </p>
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
            <p className="text-sm text-slate-500">For</p>
            <p className="font-semibold text-slate-900">{doc?.jobName}</p>
            {doc?.address ? <p className="text-sm text-slate-600 mt-1">{doc.address}</p> : null}
          </div>

          {requiredItems.length > 0 && (
            <div className="border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="text-left p-2">Description</th>
                    <th className="text-right p-2">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {requiredItems.map((it, i) => (
                    <tr key={it.id || i} className="border-t">
                      <td className="p-2 text-slate-800">{it.description}</td>
                      <td className="p-2 text-right whitespace-nowrap">{money(it.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {hasOptionalLines && isEstimate && (
            <div className="rounded-xl border border-amber-300 bg-amber-50/70 p-3 space-y-2">
              <p className="text-sm font-semibold text-amber-950">
                {allLinesOptional ? 'Choose the options you want' : 'Optional add-ons'}
              </p>
              <p className="text-xs text-amber-900">
                {allLinesOptional
                  ? 'Every line on this estimate is optional. Check the ones you want included.'
                  : 'Included work is listed above. Check any extra options you want to add.'}
              </p>
              {optionalItems.map((it) => {
                const id = String(it.id || '');
                const checked = selectedOptionIds.includes(id);
                return (
                  <label
                    key={id || it.description}
                    className={`flex items-start gap-3 rounded-lg border bg-white p-3 ${
                      approved ? 'cursor-default' : 'cursor-pointer'
                    } ${checked ? 'border-amber-400' : 'border-amber-200'}`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-5 w-5 shrink-0 accent-amber-600"
                      checked={checked}
                      disabled={approved || busy}
                      onChange={(e) => {
                        setSelectedOptionIds((prev) =>
                          e.target.checked ? [...prev, id] : prev.filter((x) => x !== id)
                        );
                        setError('');
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-slate-900">{it.description}</span>
                      <span className="block text-sm font-semibold text-amber-900 mt-0.5">
                        {money(it.total)}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          {hasOptionalLines && !isEstimate && (
            <div className="border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <tbody>
                  {optionalItems.map((it, i) => (
                    <tr key={it.id || i} className="border-t">
                      <td className="p-2 text-slate-800">
                        {it.description}
                        <span className="block text-[11px] text-amber-800">
                          {it.clientSelected ? 'Added' : 'Optional — not included'}
                        </span>
                      </td>
                      <td className="p-2 text-right whitespace-nowrap">{money(it.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="rounded-xl bg-slate-50 p-4 space-y-1">
            {((hasOptionalLines && isEstimate ? choicePreview.discountAmount : Number(doc?.discountAmount)) || 0) > 0.005 && (
              <>
                <div className="flex justify-between text-sm text-slate-600">
                  <span>Subtotal</span>
                  <span>
                    {money(
                      hasOptionalLines && isEstimate
                        ? choicePreview.includedSubtotal
                        : Number(doc?.subtotalBeforeDiscount) ||
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
                  <span>
                    −{money(hasOptionalLines && isEstimate ? choicePreview.discountAmount : Number(doc?.discountAmount) || 0)}
                  </span>
                </div>
                {((hasOptionalLines && isEstimate ? choicePreview.taxAmount : Number(doc?.taxAmount)) || 0) > 0 && (
                  <div className="flex justify-between text-sm text-slate-600">
                    <span>Tax</span>
                    <span>
                      {money(hasOptionalLines && isEstimate ? choicePreview.taxAmount : Number(doc?.taxAmount) || 0)}
                    </span>
                  </div>
                )}
              </>
            )}
            <div className="flex justify-between text-lg font-bold">
              <span>Grand total</span>
              <span className="text-emerald-700">
                {money(hasOptionalLines && isEstimate ? choicePreview.grandTotal : Number(doc?.grandTotal) || 0)}
              </span>
            </div>
            {hasOptionalLines && isEstimate && choicePreview.optionalOpenTotal > 0.009 && (
              <p className="text-xs text-amber-800 pt-1">
                Unchecked options ({money(choicePreview.optionalOpenTotal)}) are not in this total.
              </p>
            )}
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
            {chargeFees && feePercent > 0 && basePay >= 0.5 && (
              <>
                <div className="flex justify-between text-sm text-slate-600">
                  <span>
                    Stripe credit card fee ({feePercent}% + ${STRIPE_CARD_FIXED_USD.toFixed(2)})
                  </span>
                  <span>
                    {money(
                      computeStripeCardFee(basePay, {
                        percentRate: feePercent,
                        chargeFees: true,
                        method: 'stripe',
                      }).feeAmount
                    )}
                  </span>
                </div>
                <div className="flex justify-between text-sm font-semibold">
                  <span>Pay by Stripe credit card</span>
                  <span>
                    {money(
                      computeStripeCardFee(basePay, {
                        percentRate: feePercent,
                        chargeFees: true,
                        method: 'stripe',
                      }).totalAmount
                    )}
                  </span>
                </div>
              </>
            )}
            {payKind === 'deposit' && depositDue >= 0.5 && (!hasOptionalLines || !isEstimate || approved) && (
              <div className="flex justify-between text-sm text-emerald-800 pt-2 border-t mt-2">
                <span>Deposit ({doc?.depositPercent || 0}%)</span>
                <span className="font-semibold">{money(depositDue)}</span>
              </div>
            )}
          </div>

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

          {hasTerms && (
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 shrink-0 accent-emerald-600"
                checked={termsAccepted}
                onChange={(e) => {
                  setTermsAccepted(e.target.checked);
                  if (e.target.checked) setError('');
                }}
              />
              <span className="text-sm text-slate-700 leading-snug">
                I agree to the{' '}
                <a
                  href={`/client/terms?token=${encodeURIComponent(token)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline font-medium text-slate-900"
                >
                  terms
                </a>
                .
              </span>
            </label>
          )}

          {isEstimate && !approved && (
            <Button
              className="w-full py-6 text-lg bg-slate-800 hover:bg-slate-900 text-white rounded-xl disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                if (!requireTermsOrError()) return;
                if (allLinesOptional && selectedOptionIds.length === 0) {
                  setError('Choose at least one option before approving this estimate.');
                  return;
                }
                void persistClientApproval();
              }}
            >
              ✓ Approve estimate
            </Button>
          )}

          {isEstimate && approved && (
            <div className="rounded-xl border-2 border-emerald-500 bg-emerald-50 p-3 text-center">
              <p className="text-emerald-800 font-semibold">Estimate approved</p>
              <p className="text-sm text-emerald-700">
                Your contractor can schedule this job. It is not an invoice yet.
                {doc?.showDeposit ? ' Choose how you want to pay the deposit below.' : ''}
              </p>
            </div>
          )}

          {canPay && (!hasOptionalLines || !isEstimate || approved) && (!isEstimate || approved || payKind === 'deposit') && (
            <div className="space-y-3 pt-1">
              {primaryPay ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handlePayOption(primaryPay.method)}
                  className="w-full rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white py-5 px-4 disabled:opacity-60"
                >
                  <span className="block text-lg font-bold">
                    {busy && selectedMethod === primaryPay.method
                      ? 'Starting…'
                      : `Pay ${money(
                          Number(primaryPay.totalAmount) > 0 ? Number(primaryPay.totalAmount) : basePay
                        )}`}
                  </span>
                  <span className="block text-sm text-emerald-50 mt-1">
                    {primaryPay.method === 'stripe'
                      ? Number(primaryPay.feeAmount) > 0
                        ? `Card · includes ${money(Number(primaryPay.feeAmount))} processing fee`
                        : 'Credit or debit card'
                      : primaryPay.label}
                  </span>
                </button>
              ) : (
                <Button
                  className="w-full py-6 bg-emerald-600 text-white"
                  disabled={busy}
                  onClick={() => void startStripeCheckout(payKind, 'card')}
                >
                  {busy ? 'Starting…' : `Pay ${money(basePay)}`}
                </Button>
              )}

              {otherPays.length > 0 && (
                <button
                  type="button"
                  className="w-full rounded-2xl border-2 border-slate-300 bg-white text-slate-800 font-semibold py-3 px-4"
                  onClick={() => setShowOtherPays((open) => !open)}
                >
                  {showOtherPays ? 'Hide other ways to pay' : 'More ways to pay'}
                </button>
              )}

              {showOtherPays &&
                otherPays.map((opt) => {
                  const total = Number(opt.totalAmount) > 0 ? Number(opt.totalAmount) : basePay;
                  return (
                    <button
                      key={opt.method}
                      type="button"
                      disabled={busy}
                      onClick={() => void handlePayOption(opt.method)}
                      className="w-full flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-left disabled:opacity-60"
                    >
                      <span className="min-w-0">
                        <span className="block font-medium text-slate-900">{opt.label}</span>
                        {opt.handle ? (
                          <span className="block text-xs text-slate-500 truncate">{opt.handle}</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 font-semibold text-slate-800">{money(total)}</span>
                    </button>
                  );
                })}

              {showOtherPays && selectedMethod === 'zelle' && paymentOptions.find((o) => o.method === 'zelle')?.qrUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={paymentOptions.find((o) => o.method === 'zelle')?.qrUrl}
                  alt="Zelle QR"
                  className="mx-auto w-28 h-28 object-contain border rounded bg-white"
                />
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
