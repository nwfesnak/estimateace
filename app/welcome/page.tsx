'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type Embed =
  | { kind: 'iframe'; src: string }
  | { kind: 'video'; src: string }
  | { kind: 'none' };

type WelcomePayload = {
  ok?: boolean;
  title?: string;
  description?: string;
  videoUrl?: string;
  embed?: Embed;
  shareUrl?: string;
};

export default function WelcomePage() {
  const [data, setData] = useState<WelcomePayload | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/welcome', { cache: 'no-store' });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (!cancelled) setError(json.error || 'Could not load welcome video.');
          return;
        }
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setError('Network error loading welcome page.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const title = data?.title || 'Welcome to EstimateAce';
  const description =
    data?.description ||
    'A quick walkthrough of EstimateAce — estimates, AI quoting, invoices, and getting paid.';
  const embed = data?.embed || { kind: 'none' as const };
  const hasVideo = embed.kind === 'iframe' || embed.kind === 'video';

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white text-slate-900">
      <header className="border-b bg-white/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-3">
          <div className="font-bold text-lg tracking-tight">
            Estimate<span className="text-emerald-600">Ace</span>
          </div>
          <div className="flex gap-2">
            <Link
              href="/trial"
              className="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800"
            >
              Start free trial
            </Link>
            <Link
              href="/"
              className="px-4 py-2 rounded-xl border border-slate-300 text-sm font-semibold hover:bg-slate-50"
            >
              Log in
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-10 sm:py-14">
        <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 mb-3">
          Private welcome link
        </p>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 mb-3">
          {title}
        </h1>
        <p className="text-slate-600 text-base sm:text-lg max-w-2xl mb-8 whitespace-pre-wrap">
          {description}
        </p>

        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-800 text-sm">
            {error}
          </div>
        ) : !data ? (
          <div className="rounded-2xl border bg-white p-10 text-center text-slate-500 shadow-sm">
            Loading video…
          </div>
        ) : hasVideo ? (
          <div className="rounded-2xl overflow-hidden border border-slate-200 shadow-lg bg-black aspect-video">
            {embed.kind === 'iframe' ? (
              <iframe
                src={embed.src}
                title={title}
                className="w-full h-full min-h-[240px]"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                allowFullScreen
              />
            ) : (
              <video
                src={embed.src}
                controls
                playsInline
                preload="metadata"
                className="w-full h-full min-h-[240px] bg-black"
              >
                Your browser does not support video playback.
              </video>
            )}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
            <p className="font-semibold text-slate-800 mb-2">Welcome video not set yet</p>
            <p className="text-sm text-slate-600 max-w-md mx-auto">
              The EstimateAce owner can add a YouTube, Loom, Vimeo, or MP4 link under Profile → Video
              Tutorials → Signup welcome video.
            </p>
          </div>
        )}

        <div className="mt-10 flex flex-col sm:flex-row gap-3 sm:items-center">
          <Link
            href="/trial"
            className="inline-flex justify-center px-6 py-3 rounded-2xl bg-emerald-600 text-white font-semibold hover:bg-emerald-700"
          >
            Start your 14-day free trial
          </Link>
          <Link
            href="/"
            className="inline-flex justify-center px-6 py-3 rounded-2xl border border-slate-300 font-semibold hover:bg-white"
          >
            Go to the app
          </Link>
        </div>

        <p className="mt-8 text-xs text-slate-400">
          This page is unlisted — it is not linked from the public website. Share it only with people
          signing up for EstimateAce.
        </p>
      </main>
    </div>
  );
}
