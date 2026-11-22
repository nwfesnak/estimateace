'use client';

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { getTabStripOverflow, tabStripScrollAmount } from '@/lib/swipe-hint-tabs';

type SwipeHintTabStripProps = {
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
};

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  const isLeft = dir === 'left';
  return (
    <svg
      viewBox="0 0 20 20"
      width="18"
      height="18"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {isLeft ? <path d="M12.5 4.5 7 10l5.5 5.5" /> : <path d="M7.5 4.5 13 10l-5.5 5.5" />}
    </svg>
  );
}

/**
 * Horizontal tab row with a soft edge fade and a chevron when more tabs
 * are off-screen. The right arrow hides at the end; a left arrow appears
 * once the strip has been scrolled. Tapping an arrow scrolls the strip.
 * Works on touch / iOS webview (no hover required).
 */
export function SwipeHintTabStrip({
  children,
  className = '',
  'data-testid': testId,
}: SwipeHintTabStripProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const update = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = getTabStripOverflow({
      scrollLeft: el.scrollLeft,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    });
    setCanScrollLeft(next.canScrollLeft);
    setCanScrollRight(next.canScrollRight);
  }, []);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const tick = () => update();
    tick();
    el.addEventListener('scroll', tick, { passive: true });
    window.addEventListener('resize', tick);
    const ro = new ResizeObserver(tick);
    ro.observe(el);
    if (innerRef.current) ro.observe(innerRef.current);
    return () => {
      el.removeEventListener('scroll', tick);
      window.removeEventListener('resize', tick);
      ro.disconnect();
    };
  }, [update, children]);

  const scrollByDir = (dir: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    const amount = tabStripScrollAmount(el.clientWidth);
    if (typeof el.scrollBy === 'function') {
      el.scrollBy({ left: dir * amount, behavior: 'smooth' });
    } else {
      el.scrollLeft += dir * amount;
    }
  };

  return (
    <div className={`relative ${className}`.trim()} data-testid={testId}>
      <div
        ref={scrollerRef}
        data-testid="swipe-hint-scroller"
        className="flex overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-x' }}
      >
        <div ref={innerRef} className="flex min-w-full">
          {children}
        </div>
      </div>

      {canScrollLeft && (
        <>
          <div
            className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-[#f4f4f4] to-transparent"
            data-testid="swipe-hint-fade-left"
            aria-hidden="true"
          />
          <button
            type="button"
            data-testid="swipe-hint-left"
            aria-label="Show previous tabs"
            className="absolute left-0 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white/95 text-slate-700 shadow-sm"
            onClick={() => scrollByDir(-1)}
          >
            <Chevron dir="left" />
          </button>
        </>
      )}

      {canScrollRight && (
        <>
          <div
            className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[#f4f4f4] to-transparent"
            data-testid="swipe-hint-fade-right"
            aria-hidden="true"
          />
          <button
            type="button"
            data-testid="swipe-hint-right"
            aria-label="Show more tabs"
            className="absolute right-0 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white/95 text-slate-700 shadow-sm"
            onClick={() => scrollByDir(1)}
          >
            <Chevron dir="right" />
          </button>
        </>
      )}
    </div>
  );
}
