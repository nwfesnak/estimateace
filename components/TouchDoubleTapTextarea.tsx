'use client';

import * as React from 'react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const DOUBLE_TAP_MS = 450;
const TAP_MOVE_TOLERANCE_PX = 12;

function isTouchPrimaryDevice() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(pointer: coarse)').matches ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  );
}

type TouchDoubleTapTextareaProps = React.ComponentProps<typeof Textarea> & {
  engageHint?: string;
};

export function TouchDoubleTapTextarea({
  engageHint = 'Double-tap to edit',
  className,
  readOnly,
  onBlur,
  onFocus,
  ...props
}: TouchDoubleTapTextareaProps) {
  const [isTouch, setIsTouch] = React.useState(false);
  const [engaged, setEngaged] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const lastTapAtRef = React.useRef(0);
  const touchStartRef = React.useRef<{ x: number; y: number } | null>(null);

  React.useEffect(() => {
    setIsTouch(isTouchPrimaryDevice());
  }, []);

  const engageEditor = React.useCallback(() => {
    if (readOnly) return;
    setEngaged(true);
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  }, [readOnly]);

  const handleOverlayTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.changedTouches[0];
    if (!touch) return;
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleOverlayTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.changedTouches[0];
    if (!touch) return;

    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (start) {
      const movedX = Math.abs(touch.clientX - start.x);
      const movedY = Math.abs(touch.clientY - start.y);
      if (movedX > TAP_MOVE_TOLERANCE_PX || movedY > TAP_MOVE_TOLERANCE_PX) {
        return;
      }
    }

    const now = Date.now();
    if (now - lastTapAtRef.current <= DOUBLE_TAP_MS) {
      lastTapAtRef.current = 0;
      engageEditor();
      return;
    }

    lastTapAtRef.current = now;
  };

  const handleFocus = (event: React.FocusEvent<HTMLTextAreaElement>) => {
    if (isTouch && !engaged && !readOnly) {
      event.target.blur();
      return;
    }
    onFocus?.(event);
  };

  const handleBlur = (event: React.FocusEvent<HTMLTextAreaElement>) => {
    if (isTouch) {
      setEngaged(false);
      lastTapAtRef.current = 0;
    }
    onBlur?.(event);
  };

  const showEngageOverlay = isTouch && !engaged && !readOnly;

  return (
    <div className="relative touch-pan-y">
      <Textarea
        ref={textareaRef}
        {...props}
        readOnly={readOnly || showEngageOverlay}
        onFocus={handleFocus}
        onBlur={handleBlur}
        className={cn(showEngageOverlay && 'caret-transparent', className)}
      />
      {showEngageOverlay && (
        <div
          className="absolute inset-0 z-10 flex items-end justify-center rounded-lg bg-white/35 pb-2 touch-manipulation"
          onTouchStart={handleOverlayTouchStart}
          onTouchEnd={handleOverlayTouchEnd}
          aria-hidden="true"
        >
          <span className="rounded-full bg-black/55 px-2.5 py-1 text-[10px] font-medium text-white shadow-sm">
            {engageHint}
          </span>
        </div>
      )}
    </div>
  );
}