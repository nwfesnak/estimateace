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

/**
 * Description field that:
 * - Fills the available screen/parent width (never wider than the viewport)
 * - Auto-grows height so full text is visible when not editing
 * - On touch devices: double-tap to engage editing
 */
export function TouchDoubleTapTextarea({
  engageHint = 'Double-tap to edit',
  className,
  readOnly,
  onBlur,
  onFocus,
  onChange,
  onInput,
  style,
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
      try {
        el.setSelectionRange(end, end);
      } catch {
        // ignore selection errors on some mobile browsers
      }
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
  const value = typeof props.value === 'string' ? props.value : '';

  // Height follows content; WIDTH is always constrained to the parent (see CSS).
  const syncHeight = React.useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Reset width constraints every sync so layout reflows on orientation change
    el.style.width = '100%';
    el.style.maxWidth = '100%';
    el.style.minWidth = '0';
    el.style.boxSizing = 'border-box';
    el.style.height = 'auto';
    const minPx = 72;
    const next = Math.max(el.scrollHeight, minPx);
    el.style.height = `${next}px`;
  }, []);

  React.useLayoutEffect(() => {
    syncHeight();
  }, [value, engaged, showEngageOverlay, syncHeight]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => syncHeight();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    // Re-measure after fonts/layout settle
    const t = window.setTimeout(syncHeight, 50);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.clearTimeout(t);
    };
  }, [syncHeight]);

  return (
    <div
      className="line-item-description-shell relative w-full min-w-0 max-w-full"
      style={{ touchAction: 'pan-y' }}
    >
      <Textarea
        ref={textareaRef}
        {...props}
        value={props.value}
        readOnly={readOnly || showEngageOverlay}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onChange={(e) => {
          onChange?.(e);
          // Height after React commits new value
          window.requestAnimationFrame(syncHeight);
        }}
        onInput={(e) => {
          onInput?.(e);
          syncHeight();
        }}
        style={{
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
          boxSizing: 'border-box',
          // Critical: do NOT use field-sizing: content — it expands WIDTH past the screen
          fieldSizing: 'fixed',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
          whiteSpace: 'pre-wrap',
          ...style,
        }}
        className={cn(
          // Override base Textarea `flex field-sizing-content` which breaks mobile width
          'line-item-description-textarea block w-full min-w-0 max-w-full',
          'overflow-x-hidden overflow-y-hidden whitespace-pre-wrap break-words',
          'box-border',
          showEngageOverlay && 'caret-transparent resize-none',
          !showEngageOverlay && 'resize-y',
          className
        )}
      />
      {showEngageOverlay && (
        <div
          className="absolute inset-0 z-10 flex items-end justify-center rounded-lg bg-white/35 pb-2"
          style={{ touchAction: 'pan-y' }}
          onTouchStart={handleOverlayTouchStart}
          onTouchEnd={handleOverlayTouchEnd}
          aria-hidden="true"
        >
          <span className="rounded-full bg-black/55 px-2.5 py-1 text-[10px] font-medium text-white shadow-sm pointer-events-none">
            {engageHint}
          </span>
        </div>
      )}
    </div>
  );
}
