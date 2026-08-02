'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';

export type LidarMeasureMode = 'length' | 'area' | 'height';

export type LidarMeasureResult = {
  qty: number;
  unit: string;
  label: string;
  method: 'webxr' | 'manual' | 'calibrated';
  feet?: number;
  inches?: number;
  lengthFt?: number;
  widthFt?: number;
};

type LidarMeasureProps = {
  open: boolean;
  onClose: () => void;
  onApply: (result: LidarMeasureResult) => void;
  preferArea?: boolean;
  /** Stream from Measure button click (iOS needs user gesture). */
  initialStream?: MediaStream | null;
};

type Point = { x: number; y: number }; // 0–1 normalized in viewfinder

type Phase = 'calibrate' | 'measure';

function parseDim(feetStr: string, inchesStr: string): number {
  const f = parseFloat(String(feetStr).replace(/,/g, '')) || 0;
  const i = parseFloat(String(inchesStr).replace(/,/g, '')) || 0;
  return Math.max(0, f + i / 12);
}

function feetToParts(totalFeet: number): { feet: number; inches: number } {
  const totalIn = Math.max(0, totalFeet) * 12;
  const feet = Math.floor(totalIn / 12);
  const inches = Math.round((totalIn % 12) * 10) / 10;
  return { feet, inches };
}

function formatFeet(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const { feet, inches } = feetToParts(n);
  if (feet === 0) return `${inches}"`;
  if (inches === 0) return `${feet}'`;
  return `${feet}' ${inches}"`;
}

function pixelDistance(a: Point, b: Point, viewW: number, viewH: number): number {
  const dx = (b.x - a.x) * viewW;
  const dy = (b.y - a.y) * viewH;
  return Math.hypot(dx, dy);
}

/**
 * Measure tool for estimate line qty.
 *
 * How it works (no raw LiDAR in web browsers on iPhone):
 * 1. Calibrate — tap two ends of something you know (door, tape mark), enter that length
 * 2. Measure — tap two ends of what you want; app scales using calibration
 * 3. Or type ft/in manually
 *
 * Stay the same distance from the surface for best accuracy.
 */
export function LidarMeasure({
  open,
  onClose,
  onApply,
  preferArea = false,
  initialStream = null,
}: LidarMeasureProps) {
  const [mounted, setMounted] = React.useState(false);
  const [mode, setMode] = React.useState<LidarMeasureMode>(preferArea ? 'area' : 'length');
  const [phase, setPhase] = React.useState<Phase>('calibrate');
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState('');
  const [cameraReady, setCameraReady] = React.useState(false);
  const [cameraBusy, setCameraBusy] = React.useState(false);

  // Screen points for current segment (0–1)
  const [points, setPoints] = React.useState<Point[]>([]);
  // feet of real world per pixel (after calibration)
  const [feetPerPx, setFeetPerPx] = React.useState<number | null>(null);
  const [calibPx, setCalibPx] = React.useState<number | null>(null);

  // Calibration known length inputs
  const [calFt, setCalFt] = React.useState('3');
  const [calIn, setCalIn] = React.useState('0');

  // Results
  const [lengthFt, setLengthFt] = React.useState(0);
  const [widthFt, setWidthFt] = React.useState(0);
  const [measuringWhich, setMeasuringWhich] = React.useState<'length' | 'width'>('length');

  // Manual override fields (always available)
  const [manLenFt, setManLenFt] = React.useState('');
  const [manLenIn, setManLenIn] = React.useState('');
  const [manWidFt, setManWidFt] = React.useState('');
  const [manWidIn, setManWidIn] = React.useState('');
  const [showManual, setShowManual] = React.useState(false);

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const viewRef = React.useRef<HTMLDivElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const viewportMetaPrev = React.useRef<string | null>(null);
  const openGenRef = React.useRef(0);

  React.useEffect(() => setMounted(true), []);

  const knownCalFeet = parseDim(calFt, calIn);

  const manualLen = parseDim(manLenFt, manLenIn);
  const manualWid = parseDim(manWidFt, manWidIn);

  // Prefer manual if user typed; else camera measure results
  const effectiveLen = showManual && manualLen > 0 ? manualLen : lengthFt;
  const effectiveWid = showManual && manualWid > 0 ? manualWid : widthFt;

  const previewQty =
    mode === 'area'
      ? effectiveLen > 0 && effectiveWid > 0
        ? Math.round(effectiveLen * effectiveWid * 100) / 100
        : 0
      : Math.round(effectiveLen * 1000) / 1000;

  const previewUnit = mode === 'area' ? 'SF' : mode === 'height' ? 'ft' : 'lf';

  const stopCamera = React.useCallback(() => {
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      try {
        videoRef.current.srcObject = null;
      } catch {
        /* ignore */
      }
    }
    setCameraReady(false);
  }, []);

  const attachStream = React.useCallback(async (stream: MediaStream, gen: number) => {
    streamRef.current = stream;
    for (let n = 0; n < 60; n++) {
      if (gen !== openGenRef.current) return;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        try {
          await video.play();
          if (gen === openGenRef.current) {
            setCameraReady(true);
            setError(null);
          }
          return;
        } catch (e) {
          console.warn(e);
          if (gen === openGenRef.current) {
            setError('Camera preview blocked. Use Manual ft/in below.');
            setShowManual(true);
          }
          return;
        }
      }
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    }
  }, []);

  const requestCamera = React.useCallback(
    async (gen: number) => {
      setCameraBusy(true);
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setError('No camera — open Manual and type ft/in.');
          setShowManual(true);
          return;
        }
        const attempts: MediaStreamConstraints[] = [
          { video: { facingMode: { ideal: 'environment' } }, audio: false },
          { video: { facingMode: 'environment' }, audio: false },
          { video: true, audio: false },
        ];
        let stream: MediaStream | null = null;
        for (const c of attempts) {
          try {
            stream = await navigator.mediaDevices.getUserMedia(c);
            break;
          } catch {
            /* next */
          }
        }
        if (!stream) {
          setError('Camera blocked. Use Manual ft/in — still applies to your line.');
          setShowManual(true);
          return;
        }
        if (gen !== openGenRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (streamRef.current && streamRef.current !== stream) {
          streamRef.current.getTracks().forEach((t) => t.stop());
        }
        await attachStream(stream, gen);
      } finally {
        if (gen === openGenRef.current) setCameraBusy(false);
      }
    },
    [attachStream]
  );

  const resetSession = React.useCallback((nextMode: LidarMeasureMode, preferAreaMode: boolean) => {
    const m = nextMode || (preferAreaMode ? 'area' : 'length');
    setMode(m);
    setPhase('calibrate');
    setPoints([]);
    setFeetPerPx(null);
    setCalibPx(null);
    setLengthFt(0);
    setWidthFt(0);
    setMeasuringWhich('length');
    setManLenFt('');
    setManLenIn('');
    setManWidFt('');
    setManWidIn('');
    setError(null);
    setStatus(
      'STEP 1 — Calibrate: tap TWO ends of something you know the size of (door, 3ft tape mark). Then enter that size and tap Set scale.'
    );
  }, []);

  React.useEffect(() => {
    if (!open) {
      openGenRef.current += 1;
      stopCamera();
      return;
    }

    const gen = ++openGenRef.current;
    resetSession(preferArea ? 'area' : 'length', preferArea);

    document.documentElement.classList.add('device-camera-lock');
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta) {
      viewportMetaPrev.current = meta.getAttribute('content');
      meta.setAttribute(
        'content',
        'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover'
      );
    }

    if (initialStream && initialStream.getTracks().some((t) => t.readyState === 'live')) {
      void attachStream(initialStream, gen);
    } else {
      const t = window.setTimeout(() => {
        if (gen === openGenRef.current) void requestCamera(gen);
      }, 60);
      return () => {
        window.clearTimeout(t);
        openGenRef.current += 1;
        stopCamera();
        document.documentElement.classList.remove('device-camera-lock');
        const m = document.querySelector('meta[name="viewport"]');
        if (m && viewportMetaPrev.current != null) {
          m.setAttribute('content', viewportMetaPrev.current);
          viewportMetaPrev.current = null;
        }
      };
    }

    return () => {
      openGenRef.current += 1;
      stopCamera();
      document.documentElement.classList.remove('device-camera-lock');
      const m = document.querySelector('meta[name="viewport"]');
      if (m && viewportMetaPrev.current != null) {
        m.setAttribute('content', viewportMetaPrev.current);
        viewportMetaPrev.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preferArea]);

  const viewSize = () => {
    const el = viewRef.current;
    return {
      w: Math.max(1, el?.clientWidth || 1),
      h: Math.max(1, el?.clientHeight || 1),
    };
  };

  const handleViewTap = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!cameraReady) {
      setError('Wait for camera, or use Manual ft/in.');
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / Math.max(1, rect.width);
    const y = (e.clientY - rect.top) / Math.max(1, rect.height);
    const p: Point = {
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
    };

    setError(null);

    if (points.length === 0) {
      setPoints([p]);
      setStatus(
        phase === 'calibrate'
          ? 'Point 1 set — tap the OTHER end of your known length'
          : measuringWhich === 'width'
            ? 'Point 1 set — tap the other end of the WIDTH'
            : 'Point 1 set — tap the other end of the LENGTH'
      );
      try {
        navigator.vibrate?.(12);
      } catch {
        /* ignore */
      }
      return;
    }

    if (points.length >= 1) {
      const a = points[0];
      const b = p;
      const { w, h } = viewSize();
      const px = pixelDistance(a, b, w, h);
      setPoints([a, b]);

      if (phase === 'calibrate') {
        setCalibPx(px);
        setStatus(
          `Line set (${Math.round(px)} px). Enter the real length below and tap “Set scale”.`
        );
        try {
          navigator.vibrate?.([10, 20, 10]);
        } catch {
          /* ignore */
        }
        return;
      }

      // Measure phase
      if (!feetPerPx || feetPerPx <= 0) {
        setError('Calibrate first: set scale with a known length.');
        setPhase('calibrate');
        setPoints([]);
        return;
      }

      const feet = px * feetPerPx;
      if (mode === 'area' && measuringWhich === 'width') {
        setWidthFt(feet);
        if (!showManual) {
          const parts = feetToParts(feet);
          setManWidFt(String(parts.feet));
          setManWidIn(String(parts.inches));
        }
        setStatus(`Width = ${formatFeet(feet)}. Adjust if needed, then Apply to line.`);
      } else {
        setLengthFt(feet);
        if (!showManual) {
          const parts = feetToParts(feet);
          setManLenFt(String(parts.feet));
          setManLenIn(String(parts.inches));
        }
        if (mode === 'area') {
          setMeasuringWhich('width');
          setPoints([]);
          setStatus(`Length = ${formatFeet(feet)}. Now tap TWO ends of the WIDTH.`);
        } else {
          setStatus(`Measured ${formatFeet(feet)}. Tap Apply to line.`);
        }
      }
      try {
        navigator.vibrate?.([15, 25, 15]);
      } catch {
        /* ignore */
      }
    }
  };

  const setScale = () => {
    if (knownCalFeet <= 0) {
      setError('Enter the known length in feet / inches (e.g. door 3 ft 0 in).');
      return;
    }
    if (!calibPx || calibPx < 8) {
      setError('Tap two points on the camera first (both ends of the known length).');
      return;
    }
    const scale = knownCalFeet / calibPx;
    setFeetPerPx(scale);
    setPhase('measure');
    setPoints([]);
    setMeasuringWhich('length');
    setLengthFt(0);
    setWidthFt(0);
    setError(null);
    setStatus(
      mode === 'area'
        ? 'Scale set ✓ — tap TWO ends of the LENGTH to measure'
        : mode === 'height'
          ? 'Scale set ✓ — tap bottom and top of the height'
          : 'Scale set ✓ — tap TWO ends of what you want to measure'
    );
  };

  const clearPoints = () => {
    setPoints([]);
    setCalibPx(null);
    if (phase === 'calibrate') {
      setStatus('Tap TWO ends of a known length on the camera.');
    } else if (mode === 'area' && measuringWhich === 'width') {
      setStatus('Tap TWO ends of the WIDTH.');
    } else {
      setStatus('Tap TWO ends to measure.');
    }
  };

  const recaliibrate = () => {
    setPhase('calibrate');
    setPoints([]);
    setCalibPx(null);
    setFeetPerPx(null);
    setLengthFt(0);
    setWidthFt(0);
    setMeasuringWhich('length');
    setStatus('Recalibrate: tap TWO ends of a known length, enter size, Set scale.');
  };

  const applyMeasurement = () => {
    setError(null);

    // Pull from manual fields if filled (user may edit after measure)
    const len = parseDim(manLenFt, manLenIn) || effectiveLen;
    const wid = parseDim(manWidFt, manWidIn) || effectiveWid;

    if (mode === 'area') {
      if (len <= 0 || wid <= 0) {
        setError('Need length AND width. Measure both on camera, or type ft/in in Manual.');
        setShowManual(true);
        return;
      }
      const sqft = Math.round(len * wid * 100) / 100;
      onApply({
        qty: sqft,
        unit: 'SF',
        label: `${formatFeet(len)} × ${formatFeet(wid)} = ${sqft.toLocaleString()} SF`,
        method: feetPerPx ? 'calibrated' : 'manual',
        lengthFt: len,
        widthFt: wid,
      });
      return;
    }

    if (len <= 0) {
      setError('Measure on camera (after scale) or type length in Manual.');
      setShowManual(true);
      return;
    }
    const unit = mode === 'height' ? 'ft' : 'lf';
    onApply({
      qty: Math.round(len * 1000) / 1000,
      unit,
      label: mode === 'height' ? `Height ${formatFeet(len)}` : `Length ${formatFeet(len)}`,
      method: feetPerPx ? 'calibrated' : 'manual',
      ...feetToParts(len),
    });
  };

  const handleClose = () => {
    stopCamera();
    onClose();
  };

  if (!mounted || !open) return null;

  const lineStyle: React.CSSProperties | undefined =
    points.length === 2
      ? (() => {
          const a = points[0];
          const b = points[1];
          const x1 = a.x * 100;
          const y1 = a.y * 100;
          const x2 = b.x * 100;
          const y2 = b.y * 100;
          const dx = x2 - x1;
          const dy = y2 - y1;
          const len = Math.hypot(dx, dy);
          const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
          return {
            position: 'absolute' as const,
            left: `${x1}%`,
            top: `${y1}%`,
            width: `${len}%`,
            height: '3px',
            background: '#10b981',
            transformOrigin: '0 50%',
            transform: `rotate(${angle}deg)`,
            zIndex: 12,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
            pointerEvents: 'none' as const,
          };
        })()
      : undefined;

  const shell = (
    <div
      id="lidar-measure-root"
      className="device-camera-shell"
      role="dialog"
      aria-modal="true"
      aria-label="Measure"
      style={{ zIndex: 500, background: '#0a0a0a' }}
    >
      {/* Top */}
      <div className="device-camera-top" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
        <div className="device-camera-top-info">
          <div className="device-camera-title">📡 Measure</div>
          <div className="device-camera-subtitle">
            {phase === 'calibrate'
              ? 'Calibrate with a known length, then measure'
              : 'Tap two points on the camera to measure'}
          </div>
        </div>
        <button type="button" className="device-camera-done" onClick={handleClose}>
          Close
        </button>
      </div>

      {/* Mode */}
      <div className="flex gap-2 px-3 pb-2">
        {(
          [
            ['length', 'Length'],
            ['area', 'Area'],
            ['height', 'Height'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setMode(id);
              setPoints([]);
              setLengthFt(0);
              setWidthFt(0);
              setMeasuringWhich('length');
              if (feetPerPx) {
                setPhase('measure');
                setStatus(
                  id === 'area'
                    ? 'Tap TWO ends of the LENGTH first'
                    : 'Tap TWO ends to measure'
                );
              } else {
                setPhase('calibrate');
                setStatus('Calibrate first: tap known length, enter size, Set scale.');
              }
            }}
            className={`flex-1 rounded-full py-2 text-xs font-semibold border ${
              mode === id
                ? 'bg-[#10b981] border-[#10b981] text-white'
                : 'bg-white/10 border-white/20 text-white/80'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Steps badge */}
      <div className="px-3 pb-2 flex gap-2 text-[10px] font-semibold uppercase tracking-wide">
        <span
          className={`rounded-full px-2.5 py-1 ${
            phase === 'calibrate' ? 'bg-amber-500 text-black' : 'bg-white/10 text-white/50'
          }`}
        >
          1. Scale
        </span>
        <span
          className={`rounded-full px-2.5 py-1 ${
            phase === 'measure' ? 'bg-emerald-500 text-black' : 'bg-white/10 text-white/50'
          }`}
        >
          2. Measure
        </span>
        <span
          className={`rounded-full px-2.5 py-1 ${
            previewQty > 0 ? 'bg-sky-500 text-black' : 'bg-white/10 text-white/50'
          }`}
        >
          3. Apply
        </span>
      </div>

      {/* Camera — tap targets */}
      <div className="device-camera-frame px-3" style={{ flex: '1 1 40%', minHeight: '200px', maxHeight: '42vh' }}>
        <div className="device-camera-frame-border relative">
          <div
            ref={viewRef}
            className="device-camera-viewfinder touch-none"
            onPointerDown={handleViewTap}
            style={{ cursor: 'crosshair' }}
          >
            <video ref={videoRef} className="device-camera-video pointer-events-none" playsInline muted autoPlay />

            {/* Points */}
            {points.map((pt, i) => (
              <div
                key={i}
                className="absolute z-20 w-5 h-5 -ml-2.5 -mt-2.5 rounded-full border-2 border-white bg-[#10b981] shadow-lg pointer-events-none"
                style={{ left: `${pt.x * 100}%`, top: `${pt.y * 100}%` }}
              >
                <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] font-bold text-white drop-shadow">
                  {i + 1}
                </span>
              </div>
            ))}
            {lineStyle && <div style={lineStyle} />}

            {!cameraReady && (
              <div className="device-camera-loading">
                <p className="text-sm text-white/85 text-center px-4">
                  {cameraBusy ? 'Starting camera…' : error || 'Starting camera…'}
                </p>
                <button
                  type="button"
                  className="device-camera-retry mt-3"
                  onClick={() => void requestCamera(openGenRef.current)}
                >
                  Enable camera
                </button>
                <button
                  type="button"
                  className="device-camera-retry mt-2"
                  onClick={() => setShowManual(true)}
                >
                  Skip — type ft/in
                </button>
              </div>
            )}

            {cameraReady && (
              <div className="absolute top-2 left-2 right-2 z-10 rounded-lg bg-black/70 px-3 py-2 text-[11px] text-white leading-snug pointer-events-none">
                {status}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div
        className="px-3 pt-2 space-y-2.5 overflow-y-auto"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        {phase === 'calibrate' && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
            <p className="text-xs text-amber-100 font-medium">
              Known length (what you tapped on camera)
            </p>
            <div className="flex gap-2 items-center">
              <input
                inputMode="decimal"
                value={calFt}
                onChange={(e) => setCalFt(e.target.value)}
                className="flex-1 h-11 rounded-lg bg-black/50 border border-white/25 text-white text-center text-lg font-semibold"
                placeholder="3"
              />
              <span className="text-white/60 text-sm">ft</span>
              <input
                inputMode="decimal"
                value={calIn}
                onChange={(e) => setCalIn(e.target.value)}
                className="flex-1 h-11 rounded-lg bg-black/50 border border-white/25 text-white text-center text-lg font-semibold"
                placeholder="0"
              />
              <span className="text-white/60 text-sm">in</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[
                { l: 'Door 36″', f: '3', i: '0' },
                { l: '2 ft', f: '2', i: '0' },
                { l: '4 ft', f: '4', i: '0' },
                { l: 'Tape 1 ft', f: '1', i: '0' },
              ].map((c) => (
                <button
                  key={c.l}
                  type="button"
                  onClick={() => {
                    setCalFt(c.f);
                    setCalIn(c.i);
                  }}
                  className="rounded-full px-2.5 py-1 text-[11px] bg-white/10 text-white border border-white/15"
                >
                  {c.l}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={setScale}
              className="w-full rounded-xl py-3 text-sm font-bold bg-amber-500 text-black"
            >
              Set scale {calibPx ? '✓ line ready' : '(tap 2 points first)'}
            </button>
          </div>
        )}

        {phase === 'measure' && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 space-y-2">
            <div className="flex justify-between text-xs text-emerald-100">
              <span>
                {mode === 'area'
                  ? measuringWhich === 'width'
                    ? 'Measuring WIDTH'
                    : 'Measuring LENGTH'
                  : 'Measuring'}
              </span>
              <button type="button" onClick={recaliibrate} className="underline text-white/70">
                Recalibrate
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-white">
              <div>
                <div className="text-[10px] uppercase text-white/50">
                  {mode === 'height' ? 'Height' : 'Length'}
                </div>
                <div className="text-lg font-bold tabular-nums">{formatFeet(lengthFt)}</div>
              </div>
              {mode === 'area' && (
                <div>
                  <div className="text-[10px] uppercase text-white/50">Width</div>
                  <div className="text-lg font-bold tabular-nums">{formatFeet(widthFt)}</div>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={clearPoints}
                className="flex-1 rounded-xl py-2.5 text-sm font-semibold bg-white/10 text-white border border-white/20"
              >
                Undo points
              </button>
              {mode === 'area' && lengthFt > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setMeasuringWhich('width');
                    setPoints([]);
                    setStatus('Tap TWO ends of the WIDTH');
                  }}
                  className="flex-1 rounded-xl py-2.5 text-sm font-semibold bg-white/10 text-white border border-white/20"
                >
                  Measure width
                </button>
              )}
            </div>
          </div>
        )}

        {/* Manual always available */}
        <button
          type="button"
          onClick={() => setShowManual((v) => !v)}
          className="w-full text-left text-xs text-white/60 py-1"
        >
          {showManual ? '▼ Hide manual entry' : '▶ Type ft/in manually (no camera measure)'}
        </button>

        {showManual && (
          <div className="rounded-xl border border-white/15 bg-white/5 p-3 space-y-2">
            <div>
              <label className="text-[10px] uppercase text-white/50">
                {mode === 'height' ? 'Height' : 'Length'}
              </label>
              <div className="flex gap-2 items-center mt-1">
                <input
                  inputMode="decimal"
                  value={manLenFt}
                  onChange={(e) => setManLenFt(e.target.value)}
                  className="flex-1 h-11 rounded-lg bg-black/50 border border-white/25 text-white text-center font-semibold"
                  placeholder="ft"
                />
                <span className="text-white/50 text-xs">ft</span>
                <input
                  inputMode="decimal"
                  value={manLenIn}
                  onChange={(e) => setManLenIn(e.target.value)}
                  className="flex-1 h-11 rounded-lg bg-black/50 border border-white/25 text-white text-center font-semibold"
                  placeholder="in"
                />
                <span className="text-white/50 text-xs">in</span>
              </div>
            </div>
            {mode === 'area' && (
              <div>
                <label className="text-[10px] uppercase text-white/50">Width</label>
                <div className="flex gap-2 items-center mt-1">
                  <input
                    inputMode="decimal"
                    value={manWidFt}
                    onChange={(e) => setManWidFt(e.target.value)}
                    className="flex-1 h-11 rounded-lg bg-black/50 border border-white/25 text-white text-center font-semibold"
                    placeholder="ft"
                  />
                  <span className="text-white/50 text-xs">ft</span>
                  <input
                    inputMode="decimal"
                    value={manWidIn}
                    onChange={(e) => setManWidIn(e.target.value)}
                    className="flex-1 h-11 rounded-lg bg-black/50 border border-white/25 text-white text-center font-semibold"
                    placeholder="in"
                  />
                  <span className="text-white/50 text-xs">in</span>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="text-white min-w-0">
            <div className="text-[10px] uppercase text-white/50">Result → line qty</div>
            <div className="text-xl font-bold tabular-nums">
              {previewQty > 0 ? (
                <>
                  {previewQty.toLocaleString()}{' '}
                  <span className="text-base text-emerald-400">{previewUnit}</span>
                </>
              ) : (
                <span className="text-white/30">—</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={applyMeasurement}
            disabled={previewQty <= 0}
            className="shrink-0 rounded-xl px-5 py-3.5 text-sm font-bold bg-[#10b981] text-white disabled:opacity-35"
          >
            Apply to line
          </button>
        </div>

        {error && <p className="text-xs text-amber-300 leading-snug">{error}</p>}
        <p className="text-[10px] text-white/35 leading-snug">
          Web browsers cannot read iPhone LiDAR. This tool measures by camera scale: calibrate once
          with a known length (door ≈ 3′), stay the same distance from the wall/floor, then tap to
          measure. Or type tape readings in Manual.
        </p>
      </div>
    </div>
  );

  return createPortal(shell, document.body);
}
