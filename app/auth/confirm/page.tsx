'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabaseClient, getSupabaseConfigHelpMessage } from '@/lib/supabase/client';

/**
 * Landing page for app-domain auth emails (signup confirmation, and recovery
 * as a fallback). Links look like:
 *   /auth/confirm?token_hash=...&type=email
 * so the message never points at *.supabase.co.
 */
type Status = 'working' | 'error';

export default function AuthConfirmPage() {
  const [status, setStatus] = useState<Status>('working');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      queueMicrotask(() => {
        setError(getSupabaseConfigHelpMessage());
        setStatus('error');
      });
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const tokenHash = params.get('token_hash');
    const type = (params.get('type') || 'email') as
      | 'recovery'
      | 'email'
      | 'signup'
      | 'invite'
      | 'magiclink'
      | 'email_change';

    if (!tokenHash) {
      queueMicrotask(() => {
        setError('This confirmation link is missing information.');
        setStatus('error');
      });
      return;
    }

    void supabase.auth.verifyOtp({ token_hash: tokenHash, type }).then(({ error: err }) => {
      if (err) {
        setError(err.message);
        setStatus('error');
        return;
      }
      window.location.replace(type === 'recovery' ? '/reset-password' : '/');
    });
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-3xl shadow-sm p-6 sm:p-8 space-y-5">
        <div className="flex items-center gap-2 font-bold text-xl tracking-tight">
          <span className="w-9 h-9 bg-slate-900 text-white rounded-xl flex items-center justify-center text-sm">
            EA
          </span>
          EstimateAce
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Confirming your email</h1>
        {status === 'working' && <p className="text-sm text-slate-600">Please wait a moment…</p>}
        {status === 'error' && (
          <div className="space-y-3">
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">
              {error || 'This link is invalid or has expired.'}
            </p>
            <p className="text-sm text-slate-600">
              Go back to the login screen and try again, or use <strong>Forgot password?</strong> to
              get a new link.
            </p>
            <Link href="/" className="inline-block font-semibold text-emerald-700 underline">
              Back to login
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
