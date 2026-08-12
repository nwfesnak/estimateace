'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

function CertificateInner() {
  const searchParams = useSearchParams();
  const token = useMemo(() => String(searchParams.get('token') || '').trim(), [searchParams]);
  const [company, setCompany] = useState('');
  const [docLabel, setDocLabel] = useState('Document');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [certificateUrl, setCertificateUrl] = useState('');
  const [certificateIsPdf, setCertificateIsPdf] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) {
      setError(
        'This certificate link is missing or incomplete. Open the link from your estimate or invoice email.'
      );
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
          setError(json.error || 'Could not load certificate.');
          setLoading(false);
          return;
        }
        setCompany(json.company || 'Contractor');
        setDocLabel(json.documentType === 'invoice' ? 'Invoice' : 'Estimate');
        setInvoiceNumber(json.invoiceNumber || '');
        if (!json.hasCertificate || !json.certificateUrl) {
          setError('No Certificate of Insurance is available for this contractor.');
          setLoading(false);
          return;
        }
        setCertificateUrl(String(json.certificateUrl));
        setCertificateIsPdf(!!json.certificateIsPdf);
      } catch {
        if (!cancelled) setError('Network error loading certificate.');
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
        <p className="text-slate-600">Loading certificate…</p>
      </div>
    );
  }

  if (error || !certificateUrl) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md w-full bg-white rounded-2xl border shadow-sm p-6 text-center">
          <h1 className="text-xl font-semibold mb-2">Certificate unavailable</h1>
          <p className="text-slate-600">{error || 'No certificate on file.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="bg-slate-800 text-white px-6 py-5">
          <p className="text-sm text-slate-300">{company}</p>
          <h1 className="text-2xl font-bold mt-1">Certificate of Insurance</h1>
          {(docLabel || invoiceNumber) && (
            <p className="text-slate-300 text-sm mt-1">
              {docLabel}
              {invoiceNumber ? ` # ${invoiceNumber}` : ''}
            </p>
          )}
        </div>
        <div className="p-4 md:p-6">
          <div className="flex flex-wrap gap-3 mb-4">
            <a
              href={certificateUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center rounded-xl bg-emerald-600 text-white font-semibold px-5 py-3 text-sm hover:bg-emerald-700"
            >
              Open certificate
            </a>
            <a
              href={certificateUrl}
              download
              className="inline-flex items-center justify-center rounded-xl bg-slate-100 text-slate-800 font-semibold px-5 py-3 text-sm hover:bg-slate-200"
            >
              Download
            </a>
          </div>
          {certificateIsPdf ? (
            <iframe
              title="Certificate of Insurance"
              src={certificateUrl}
              className="w-full min-h-[70vh] rounded-xl border border-slate-200 bg-slate-50"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={certificateUrl}
              alt="Certificate of Insurance"
              className="w-full max-h-[80vh] object-contain rounded-xl border border-slate-200 bg-slate-50"
            />
          )}
          <p className="mt-6 text-xs text-slate-500 border-t pt-4">
            Certificate of Insurance provided by {company || 'your contractor'}.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function ClientCertificatePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
          <p className="text-slate-600">Loading…</p>
        </div>
      }
    >
      <CertificateInner />
    </Suspense>
  );
}
