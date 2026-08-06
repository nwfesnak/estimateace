'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

function TermsInner() {
  const searchParams = useSearchParams();
  const token = useMemo(() => String(searchParams.get('token') || '').trim(), [searchParams]);
  const [company, setCompany] = useState('');
  const [docLabel, setDocLabel] = useState('Document');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [terms, setTerms] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) {
      setError('This terms link is missing or incomplete. Open the link from your estimate or invoice email.');
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
          setError(json.error || 'Could not load terms.');
          setLoading(false);
          return;
        }
        setCompany(json.company || 'Contractor');
        setDocLabel(json.documentType === 'invoice' ? 'Invoice' : 'Estimate');
        setInvoiceNumber(json.invoiceNumber || '');
        setTerms(String(json.terms || '').trim());
        if (!String(json.terms || '').trim()) {
          setError('No terms were attached to this document.');
        }
      } catch {
        if (!cancelled) setError('Network error loading terms.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <p className="text-slate-600">Loading terms…</p>
      </div>
    );
  }

  if (error && !terms) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md w-full bg-white rounded-2xl border shadow-sm p-6 text-center">
          <h1 className="text-xl font-semibold mb-2">Terms unavailable</h1>
          <p className="text-slate-600">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="max-w-2xl mx-auto bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="bg-slate-800 text-white px-6 py-5">
          <p className="text-sm text-slate-300">{company}</p>
          <h1 className="text-2xl font-bold mt-1">Terms &amp; Conditions</h1>
          {(docLabel || invoiceNumber) && (
            <p className="text-slate-300 text-sm mt-1">
              {docLabel}
              {invoiceNumber ? ` # ${invoiceNumber}` : ''}
            </p>
          )}
        </div>
        <div className="p-6 md:p-8">
          <div className="text-sm md:text-base text-slate-800 leading-relaxed whitespace-pre-wrap">
            {terms}
          </div>
          <p className="mt-8 text-xs text-slate-500 border-t pt-4">
            These terms apply to the {docLabel.toLowerCase()} from {company || 'your contractor'}.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function ClientTermsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
          <p className="text-slate-600">Loading…</p>
        </div>
      }
    >
      <TermsInner />
    </Suspense>
  );
}
