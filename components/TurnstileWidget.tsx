'use client';

import { useEffect, useRef } from 'react';
import { TURNSTILE_SCRIPT_SRC, TURNSTILE_SITE_KEY, turnstileEnabled } from '@/lib/turnstile';

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-turnstile-script]');
    const script = existing || document.createElement('script');
    const done = () => (window.turnstile ? resolve() : reject(new Error('turnstile missing')));
    script.addEventListener('load', done, { once: true });
    script.addEventListener(
      'error',
      () => {
        scriptPromise = null;
        reject(new Error('turnstile script failed to load'));
      },
      { once: true }
    );
    if (!existing) {
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.dataset.turnstileScript = '1';
      document.head.appendChild(script);
    }
  });
  return scriptPromise;
}

type Props = {
  /** Called with a fresh token, or null when it expires / errors. */
  onToken: (token: string | null) => void;
  /** Action label shown in Cloudflare analytics (a-z, 0-9, _ and -). */
  action?: string;
  className?: string;
};

/**
 * Cloudflare Turnstile widget. Renders nothing when NEXT_PUBLIC_TURNSTILE_SITE_KEY is
 * unset. Tokens are single use: remount (change `key`) after each submit to get a new one.
 */
export function TurnstileWidget({ onToken, action, className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onTokenRef = useRef(onToken);
  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    if (!turnstileEnabled) return;
    let widgetId: string | null = null;
    let cancelled = false;
    onTokenRef.current(null);

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetId = window.turnstile.render(containerRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action,
          appearance: 'always',
          'refresh-expired': 'auto',
          callback: (token: string) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(null),
          'error-callback': () => onTokenRef.current(null),
        });
      })
      .catch(() => onTokenRef.current(null));

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          /* already gone */
        }
      }
    };
  }, [action]);

  if (!turnstileEnabled) return null;
  return <div ref={containerRef} className={className ?? 'my-3 flex justify-center min-h-[65px]'} />;
}
