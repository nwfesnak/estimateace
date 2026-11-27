'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabaseClient, getSupabaseConfigHelpMessage } from '@/lib/supabase/client';

/**
 * Supabase password-recovery landing page.
 * The reset email links here (redirectTo=/reset-password). Prefer app-domain links
 * with ?token_hash=&type=recovery (verifyOtp). Legacy Supabase action_link / PKCE
 * ?code= URLs still work. We then ask for a new password and save it with
 * auth.updateUser before sending them into the app.
 */
type Phase = 'checking' | 'ready' | 'invalid' | 'saving' | 'done';

export default function ResetPasswordPage() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabaseClient();
    let settled = false;
    if (!supabase) {
      queueMicrotask(() => {
        setError(getSupabaseConfigHelpMessage());
        setPhase('invalid');
      });
      return;
    }
    const markReady = () => {
      if (settled) return;
      settled = true;
      setPhase('ready');
    };

    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    const search = typeof window !== 'undefined' ? window.location.search : '';
    const urlError =
      new URLSearchParams(hash.replace(/^#/, '')).get('error_description') ||
      new URLSearchParams(search).get('error_description');
    if (urlError) {
      queueMicrotask(() => {
        setError(urlError.replace(/\+/g, ' '));
        setPhase('invalid');
      });
      return;
    }

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (session?.user && (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
        markReady();
      }
    });

    // App-domain recovery links (?token_hash=&type=recovery) from crew invites and
    // custom email templates. PKCE-style links (?code=...) need an explicit exchange.
    const params = new URLSearchParams(search);
    const tokenHash = params.get('token_hash');
    const otpType = (params.get('type') || 'recovery') as
      | 'recovery'
      | 'email'
      | 'signup'
      | 'invite'
      | 'magiclink'
      | 'email_change';
    const code = params.get('code');
    const exchange = tokenHash
      ? supabase.auth.verifyOtp({ token_hash: tokenHash, type: otpType }).then(({ error: exErr }) => {
          if (exErr) setError(exErr.message);
        })
      : code
      ? supabase.auth.exchangeCodeForSession(code).then(({ error: exErr }) => {
          if (exErr) setError(exErr.message);
        })
      : Promise.resolve();

    void exchange.then(async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session?.user) markReady();
      // Give detectSessionInUrl a moment to finish before declaring the link dead.
      setTimeout(async () => {
        if (settled) return;
        const { data: again } = await supabase.auth.getSession();
        if (again.session?.user) markReady();
        else {
          settled = true;
          setPhase('invalid');
        }
      }, 2500);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  const save = async () => {
    setError(null);
    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    if (password !== password2) {
      setError('Passwords do not match.');
      return;
    }
    const supabase = getSupabaseClient();
    if (!supabase) return;
    setPhase('saving');
    const { error: upErr } = await supabase.auth.updateUser({ password });
    if (upErr) {
      setError(upErr.message);
      setPhase('ready');
      return;
    }
    setPhase('done');
    setTimeout(() => {
      window.location.href = '/';
    }, 1500);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-3xl shadow-sm p-6 sm:p-8 space-y-5">
        <div className="flex items-center gap-2 font-bold text-xl tracking-tight">
          <span className="w-9 h-9 bg-slate-900 text-white rounded-xl flex items-center justify-center text-sm">
            EA
          </span>
          EstimateAce
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Set a new password</h1>

        {phase === 'checking' && <p className="text-sm text-slate-600">Checking your reset link…</p>}

        {phase === 'invalid' && (
          <div className="space-y-3">
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">
              {error || 'This reset link is invalid or has expired.'}
            </p>
            <p className="text-sm text-slate-600">
              Go back to the login screen and tap <strong>Forgot password?</strong> to get a new link.
            </p>
            <Link href="/" className="inline-block font-semibold text-emerald-700 underline">
              Back to login
            </Link>
          </div>
        )}

        {(phase === 'ready' || phase === 'saving') && (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">New password</label>
              <input
                type="password"
                className="w-full h-11 rounded-xl border border-slate-300 px-3 text-sm"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                placeholder="At least 8 characters"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Confirm new password</label>
              <input
                type="password"
                className="w-full h-11 rounded-xl border border-slate-300 px-3 text-sm"
                value={password2}
                onChange={(e) => setPassword2(e.target.value)}
                autoComplete="new-password"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save();
                }}
              />
            </div>
            {error && (
              <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">{error}</p>
            )}
            <button
              type="button"
              disabled={phase === 'saving'}
              onClick={() => void save()}
              className="w-full h-12 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white font-semibold disabled:opacity-50"
            >
              {phase === 'saving' ? 'Saving…' : 'Save new password'}
            </button>
          </div>
        )}

        {phase === 'done' && (
          <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl p-3">
            Password updated. Taking you to EstimateAce…
          </p>
        )}
      </div>
    </div>
  );
}
