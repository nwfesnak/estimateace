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
  initialStream?: MediaStream | null;
};

/** Normalized 0–1 coords inside the measure image/view */
type Point = { x: number; y: number };

type Phase = 'live' | 'calibrate' | 'measure';

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

/** Euclidean distance in image pixel space (normalized × image size). */
function distPx(a: Point, b: Point, imgW: number, imgH: number): number {
  return Math.hypot((b.x - a.x) * imgW, (b.y - a.y) * imgH);
}

/**
 * Job-site measure (web-safe):
 * 1. Aim camera → Freeze frame (photo locks so points never drift)
 * 2. Tap Point A — stays fixed on the photo
 * 3. Tap Point B — stays fixed; enter known length → Set scale
 * 4. Tap new A/B to measure; Apply to line
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
  const [phase, setPhase] = React.useState<Phase>('live');
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState('Aim at the job, then Freeze frame');
  const [cameraReady, setCameraReady] = React.useState(false);
  const [cameraBusy, setCameraBusy] = React.useState(false);

  // Frozen still (data URL) — measuring only happens on this
  const [freezeUrl, setFreezeUrl] = React.useState<string | null>(null);
  const [imgSize, setImgSize] = React.useState({ w: 1, h: 1 });

  // Anchors — always stored in ref + state so they never jump
  const [anchors, setAnchors] = React.useState<Point[]>([]);
  const anchorsRef = React.useRef<Point[]>([]);

  const [feetPerPx, setFeetPerPx] = React.useState<number | null>(null);
  const [calibPx, setCalibPx] = React.useState<number | null>(null);
  const [calFt, setCalFt] = React.useState('3');
  const [calIn, setCalIn] = React.useState('0');

  const [lengthFt, setLengthFt] = React.useState(0);
  const [widthFt, setWidthFt] = React.useState(0);
  const [measuringWhich, setMeasuringWhich] = React.useState<'length' | 'width'>('length');

  const [manLenFt, setManLenFt] = React.useState('');
  const [manLenIn, setManLenIn] = React.useState('');
  const [manWidFt, setManWidFt] = React.useState('');
  const [manWidIn, setManWidIn] = React.useState('');
  const [showManual, setShowManual] = React.useState(false);

  // Live preview crosshair while aiming second point (does not move anchor 1)
  const [hover, setHover] = React.useState<Point | null>(null);
  /** Stage pixel size for letterbox overlay (matches object-fit: contain). */
  const [stagePx, setStagePx] = React.useState({ w: 1, h: 1 });

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const viewportMetaPrev = React.useRef<string | null>(null);
  const openGenRef = React.useRef(0);
  const lastTapMs = React.useRef(0);
  const pointerDownId = React.useRef<number | null>(null);

  React.useEffect(() => setMounted(true), []);

  // Keep stage size in sync so anchors sit on the photo, not the black bars
  React.useEffect(() => {
    if (!open) return;
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) setStagePx({ w: Math.max(1, cr.width), h: Math.max(1, cr.height) });
    });
    ro.observe(el);
    setStagePx({ w: Math.max(1, el.clientWidth), h: Math.max(1, el.clientHeight) });
    return () => ro.disconnect();
  }, [open, freezeUrl]);

  const letterbox = React.useMemo(() => {
    const scale = Math.min(stagePx.w / imgSize.w, stagePx.h / imgSize.h);
    const drawW = imgSize.w * scale;
    const drawH = imgSize.h * scale;
    return {
      left: (stagePx.w - drawW) / 2,
      top: (stagePx.h - drawH) / 2,
      width: drawW,
      height: drawH,
    };
  }, [stagePx.w, stagePx.h, imgSize.w, imgSize.h]);

  const knownCalFeet = parseDim(calFt, calIn);
  const manualLen = parseDim(manLenFt, manLenIn);
  const manualWid = parseDim(manWidFt, manWidIn);
  const effectiveLen = manualLen > 0 ? manualLen : lengthFt;
  const effectiveWid = manualWid > 0 ? manualWid : widthFt;
  const previewQty =
    mode === 'area'
      ? effectiveLen > 0 && effectiveWid > 0
        ? Math.round(effectiveLen * effectiveWid * 100) / 100
        : 0
      : Math.round(effectiveLen * 1000) / 1000;
  const previewUnit = mode === 'area' ? 'SF' : mode === 'height' ? 'ft' : 'lf';

  const setAnchorsSafe = React.useCallback((next: Point[]) => {
    anchorsRef.current = next;
    setAnchors(next);
  }, []);

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
            setStatus('Aim camera, then tap Freeze frame');
          }
          return;
        } catch {
          if (gen === openGenRef.current) {
            setError('Camera blocked. Use Manual ft/in.');
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
          setError('No camera. Use Manual ft/in.');
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
          setError('Camera unavailable. Use Manual ft/in.');
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

  const resetMeasureState = React.useCallback((area: boolean) => {
    setMode(area ? 'area' : 'length');
    setPhase('live');
    setFreezeUrl(null);
    setAnchorsSafe([]);
    setFeetPerPx(null);
    setCalibPx(null);
    setLengthFt(0);
    setWidthFt(0);
    setMeasuringWhich('length');
    setHover(null);
    setManLenFt('');
    setManLenIn('');
    setManWidFt('');
    setManWidIn('');
    setError(null);
    setStatus('Aim camera, then tap Freeze frame');
  }, [setAnchorsSafe]);

  React.useEffect(() => {
    if (!open) {
      openGenRef.current += 1;
      stopCamera();
      return;
    }

    const gen = ++openGenRef.current;
    resetMeasureState(preferArea);

    document.documentElement.classList.add('device-camera-lock');
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta) {
      viewportMetaPrev.current = meta.getAttribute('content');
      meta.setAttribute(
        'content',
        'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover'
      );
    }

    const cleanup = () => {
      openGenRef.current += 1;
      stopCamera();
      document.documentElement.classList.remove('device-camera-lock');
      const m = document.querySelector('meta[name="viewport"]');
      if (m && viewportMetaPrev.current != null) {
        m.setAttribute('content', viewportMetaPrev.current);
        viewportMetaPrev.current = null;
      }
    };

    if (initialStream && initialStream.getTracks().some((t) => t.readyState === 'live')) {
      void attachStream(initialStream, gen);
      return cleanup;
    }

    const t = window.setTimeout(() => {
      if (gen === openGenRef.current) void requestCamera(gen);
    }, 60);
    return () => {
      window.clearTimeout(t);
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preferArea]);

  /** Grab a still from the live video — all anchors stick to this photo. */
  const freezeFrame = () => {
    setError(null);
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !cameraReady || !video.videoWidth) {
      setError('Camera not ready yet.');
      return;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setError('Could not capture frame.');
      return;
    }
    ctx.drawImage(video, 0, 0, w, h);
    let url: string;
    try {
      url = canvas.toDataURL('image/jpeg', 0.92);
    } catch {
      setError('Could not freeze frame.');
      return;
    }
    setImgSize({ w, h });
    setFreezeUrl(url);
    setAnchorsSafe([]);
    setCalibPx(null);
    setHover(null);
    // Keep scale if already set so user can re-measure on a new frame after recalibrate only
    if (feetPerPx && feetPerPx > 0) {
      setPhase('measure');
      setStatus('Frame locked. Tap Point A, then Point B to measure. Anchors stay fixed.');
    } else {
      setPhase('calibrate');
      setStatus('Frame locked. Tap Point A on one end of a KNOWN length (door, tape mark).');
    }
    try {
      navigator.vibrate?.(20);
    } catch {
      /* ignore */
    }
  };

  const unfreeze = () => {
    setFreezeUrl(null);
    setPhase('live');
    setAnchorsSafe([]);
    setCalibPx(null);
    setHover(null);
    setStatus('Live camera. Aim again, then Freeze frame.');
    // Video remounts after freeze — reattach live stream
    const gen = openGenRef.current;
    const stream = streamRef.current;
    window.setTimeout(() => {
      if (gen !== openGenRef.current) return;
      if (stream && stream.getTracks().some((t) => t.readyState === 'live')) {
        void attachStream(stream, gen);
      } else {
        void requestCamera(gen);
      }
    }, 50);
  };

  const eventToPoint = (e: React.PointerEvent<HTMLElement>): Point | null => {
    const el = stageRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    // Map click into the letterboxed image (object-fit: contain)
    const stageW = rect.width;
    const stageH = rect.height;
    const iw = imgSize.w;
    const ih = imgSize.h;
    const scale = Math.min(stageW / iw, stageH / ih);
    const drawW = iw * scale;
    const drawH = ih * scale;
    const offX = (stageW - drawW) / 2;
    const offY = (stageH - drawH) / 2;
    const localX = e.clientX - rect.left - offX;
    const localY = e.clientY - rect.top - offY;
    if (localX < 0 || localY < 0 || localX > drawW || localY > drawH) {
      return null; // outside image letterbox
    }
    return {
      x: Math.min(1, Math.max(0, localX / drawW)),
      y: Math.min(1, Math.max(0, localY / drawH)),
    };
  };

  const finishSegment = (a: Point, b: Point) => {
    const px = distPx(a, b, imgSize.w, imgSize.h);
    if (px < 4) {
      setError('Points are too close. Place them farther apart.');
      setAnchorsSafe([a]);
      return;
    }

    if (phase === 'calibrate' || !feetPerPx) {
      setCalibPx(px);
      setPhase('calibrate');
      setStatus(
        `Both anchors locked (${Math.round(px)} px apart). Enter the REAL length of that span, then Set scale.`
      );
      return;
    }

    const feet = px * feetPerPx;
    if (mode === 'area' && measuringWhich === 'width') {
      setWidthFt(feet);
      const parts = feetToParts(feet);
      setManWidFt(String(parts.feet));
      setManWidIn(String(parts.inches));
      setStatus(`Width locked: ${formatFeet(feet)}. Apply to line or measure again.`);
    } else {
      setLengthFt(feet);
      const parts = feetToParts(feet);
      setManLenFt(String(parts.feet));
      setManLenIn(String(parts.inches));
      if (mode === 'area') {
        setMeasuringWhich('width');
        setAnchorsSafe([]);
        setStatus(`Length locked: ${formatFeet(feet)}. Now tap width Point A, then Point B.`);
      } else {
        setStatus(`Measured ${formatFeet(feet)}. Tap Apply to line (or place new A/B).`);
      }
    }
  };

  const placePoint = (p: Point) => {
    const now = Date.now();
    if (now - lastTapMs.current < 280) return; // debounce double-fire
    lastTapMs.current = now;
    setError(null);
    setHover(null);

    const current = anchorsRef.current;

    if (current.length === 0) {
      setAnchorsSafe([p]);
      setStatus('Point A locked. Tap Point B — Point A will not move.');
      try {
        navigator.vibrate?.(12);
      } catch {
        /* ignore */
      }
      return;
    }

    if (current.length === 1) {
      const a = current[0];
      const b = p;
      setAnchorsSafe([a, b]);
      finishSegment(a, b);
      try {
        navigator.vibrate?.([12, 30, 12]);
      } catch {
        /* ignore */
      }
      return;
    }

    // Already have 2 anchors — start a fresh segment, keep first new tap
    setAnchorsSafe([p]);
    setCalibPx(null);
    setStatus('New Point A locked. Tap Point B.');
  };

  const onStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!freezeUrl) return;
    // Only primary button / touch
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    pointerDownId.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    // Do not place on down — place on up so finger slip doesn't drag anchor
  };

  const onStagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!freezeUrl) return;
    if (anchorsRef.current.length !== 1) return;
    const p = eventToPoint(e);
    if (p) setHover(p);
  };

  const onStagePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!freezeUrl) return;
    if (pointerDownId.current != null && e.pointerId !== pointerDownId.current) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    pointerDownId.current = null;
    const p = eventToPoint(e);
    if (!p) {
      setError('Tap on the photo (inside the image).');
      return;
    }
    placePoint(p);
  };

  const onStagePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    pointerDownId.current = null;
    setHover(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  /** Place at exact center of frozen image (reticle) — most reliable. */
  const placeAtCenter = () => {
    if (!freezeUrl) {
      setError('Freeze the frame first.');
      return;
    }
    placePoint({ x: 0.5, y: 0.5 });
  };

  const setScale = () => {
    if (knownCalFeet <= 0) {
      setError('Enter the known real length (ft / in).');
      return;
    }
    const a = anchorsRef.current[0];
    const b = anchorsRef.current[1];
    let px = calibPx;
    if ((!px || px < 4) && a && b) {
      px = distPx(a, b, imgSize.w, imgSize.h);
    }
    if (!px || px < 4) {
      setError('Place Point A and Point B on a known length first.');
      return;
    }
    const scale = knownCalFeet / px;
    setFeetPerPx(scale);
    setCalibPx(px);
    setPhase('measure');
    setAnchorsSafe([]);
    setMeasuringWhich('length');
    setLengthFt(0);
    setWidthFt(0);
    setError(null);
    setStatus(
      mode === 'area'
        ? `Scale set (${formatFeet(knownCalFeet)}). Tap length Point A, then B.`
        : `Scale set (${formatFeet(knownCalFeet)}). Tap Point A, then B to measure.`
    );
  };

  const clearAnchors = () => {
    setAnchorsSafe([]);
    setCalibPx(null);
    setHover(null);
    setStatus(
      phase === 'calibrate'
        ? 'Anchors cleared. Tap Point A on known length.'
        : 'Anchors cleared. Tap Point A, then B.'
    );
  };

  const recalibrate = () => {
    setFeetPerPx(null);
    setCalibPx(null);
    setAnchorsSafe([]);
    setLengthFt(0);
    setWidthFt(0);
    setMeasuringWhich('length');
    setPhase(freezeUrl ? 'calibrate' : 'live');
    setStatus(
      freezeUrl
        ? 'Recalibrate: tap A and B on a known length, enter size, Set scale.'
        : 'Freeze a frame first, then calibrate.'
    );
  };

  const applyMeasurement = () => {
    setError(null);
    const len = parseDim(manLenFt, manLenIn) || effectiveLen;
    const wid = parseDim(manWidFt, manWidIn) || effectiveWid;

    if (mode === 'area') {
      if (len <= 0 || wid <= 0) {
        setError('Need length and width. Measure both or type Manual ft/in.');
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
      setError('Measure A→B after scale, or type Manual ft/in.');
      setShowManual(true);
      return;
    }
    onApply({
      qty: Math.round(len * 1000) / 1000,
      unit: mode === 'height' ? 'ft' : 'lf',
      label: mode === 'height' ? `Height ${formatFeet(len)}` : `Length ${formatFeet(len)}`,
      method: feetPerPx ? 'calibrated' : 'manual',
      ...feetToParts(len),
    });
  };

  const handleClose = () => {
    stopCamera();
    onClose();
  };

  // Live line: A → hover or A → B
  const lineEndpoints: [Point, Point] | null = (() => {
    if (anchors.length === 2) return [anchors[0], anchors[1]];
    if (anchors.length === 1 && hover) return [anchors[0], hover];
    return null;
  })();

  if (!mounted || !open) return null;

  const shell = (
    <div
      id="lidar-measure-root"
      className="device-camera-shell"
      role="dialog"
      aria-modal="true"
      aria-label="Measure"
      style={{ zIndex: 500, background: '#0a0a0a' }}
    >
      <canvas ref={canvasRef} className="hidden" aria-hidden />

      <div className="device-camera-top" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
        <div className="device-camera-top-info">
          <div className="device-camera-title">📡 Measure</div>
          <div className="device-camera-subtitle">
            Freeze photo → lock Point A → lock Point B (A never moves)
          </div>
        </div>
        <button type="button" className="device-camera-done" onClick={handleClose}>
          Close
        </button>
      </div>

      <div className="flex gap-2 px-3 pb-1.5">
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
              setAnchorsSafe([]);
              setHover(null);
              setMeasuringWhich('length');
              setLengthFt(0);
              setWidthFt(0);
              if (freezeUrl && feetPerPx) {
                setPhase('measure');
                setStatus(id === 'area' ? 'Tap length A, then B' : 'Tap Point A, then B');
              } else if (freezeUrl) {
                setPhase('calibrate');
                setStatus('Calibrate: A and B on known length, then Set scale');
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

      {/* Stage */}
      <div className="device-camera-frame px-3" style={{ flex: '1 1 42%', minHeight: '220px', maxHeight: '46vh' }}>
        <div className="device-camera-frame-border relative">
          <div
            ref={stageRef}
            className="device-camera-viewfinder"
            style={{
              touchAction: 'none',
              cursor: freezeUrl ? 'crosshair' : 'default',
              userSelect: 'none',
              WebkitUserSelect: 'none',
            }}
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={onStagePointerUp}
            onPointerCancel={onStagePointerCancel}
          >
            {/* Live video only before freeze */}
            {!freezeUrl && (
              <video
                ref={videoRef}
                className="device-camera-video pointer-events-none"
                playsInline
                muted
                autoPlay
              />
            )}

            {/* Frozen still — object-fit contain so tap math matches letterbox overlay */}
            {freezeUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={freezeUrl}
                alt="Frozen measure frame"
                draggable={false}
                className="absolute inset-0 w-full h-full object-contain object-center pointer-events-none select-none"
                style={{ background: '#000' }}
              />
            )}

            {/* Overlay box matches the contained photo — anchors never drift with letterbox */}
            {freezeUrl && (
              <div
                className="absolute z-20 pointer-events-none"
                style={{
                  left: letterbox.left,
                  top: letterbox.top,
                  width: letterbox.width,
                  height: letterbox.height,
                }}
              >
                {anchors.map((pt, i) => (
                  <div
                    key={`a-${i}-${pt.x.toFixed(4)}-${pt.y.toFixed(4)}`}
                    className="absolute"
                    style={{
                      left: `${pt.x * 100}%`,
                      top: `${pt.y * 100}%`,
                      transform: 'translate(-50%, -50%)',
                    }}
                  >
                    <div
                      className={`w-7 h-7 rounded-full border-[3px] border-white shadow-lg flex items-center justify-center text-[11px] font-bold text-white ${
                        i === 0 ? 'bg-sky-500' : 'bg-[#10b981]'
                      }`}
                    >
                      {i === 0 ? 'A' : 'B'}
                    </div>
                  </div>
                ))}

                {lineEndpoints && (
                  <svg
                    className="absolute inset-0 w-full h-full"
                    viewBox="0 0 1 1"
                    preserveAspectRatio="none"
                  >
                    <line
                      x1={lineEndpoints[0].x}
                      y1={lineEndpoints[0].y}
                      x2={lineEndpoints[1].x}
                      y2={lineEndpoints[1].y}
                      stroke="#10b981"
                      strokeWidth={0.01}
                    />
                  </svg>
                )}

                {hover && anchors.length === 1 && (
                  <div
                    className="absolute opacity-70"
                    style={{
                      left: `${hover.x * 100}%`,
                      top: `${hover.y * 100}%`,
                      transform: 'translate(-50%, -50%)',
                    }}
                  >
                    <div className="w-6 h-6 rounded-full border-2 border-dashed border-emerald-300 bg-emerald-500/30" />
                  </div>
                )}

                {/* Center reticle inside photo bounds */}
                <div className="absolute inset-0 z-[8] flex items-center justify-center">
                  <div className="w-8 h-8 border-2 border-white/85 rounded-full" />
                  <div className="absolute w-0.5 h-4 bg-white/85" />
                  <div className="absolute h-0.5 w-4 bg-white/85" />
                </div>
              </div>
            )}

            {!cameraReady && !freezeUrl && (
              <div className="device-camera-loading">
                <p className="text-sm text-white/85">{cameraBusy ? 'Starting camera…' : 'Starting camera…'}</p>
                <button
                  type="button"
                  className="device-camera-retry mt-3"
                  onClick={() => void requestCamera(openGenRef.current)}
                >
                  Enable camera
                </button>
              </div>
            )}

            <div className="absolute bottom-2 left-2 right-2 z-30 rounded-lg bg-black/75 px-3 py-2 text-[11px] text-white leading-snug pointer-events-none">
              {status}
            </div>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div
        className="px-3 pt-2 space-y-2 overflow-y-auto"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        <div className="flex gap-2">
          {!freezeUrl ? (
            <button
              type="button"
              onClick={freezeFrame}
              disabled={!cameraReady}
              className="flex-1 rounded-xl py-3 text-sm font-bold bg-sky-500 text-white disabled:opacity-40"
            >
              1. Freeze frame
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={unfreeze}
                className="rounded-xl py-3 px-3 text-xs font-semibold bg-white/10 text-white border border-white/20"
              >
                New frame
              </button>
              <button
                type="button"
                onClick={placeAtCenter}
                className="flex-1 rounded-xl py-3 text-sm font-bold bg-[#10b981] text-white"
              >
                {anchors.length === 0
                  ? '2. Place Point A (center)'
                  : anchors.length === 1
                    ? '3. Place Point B (center)'
                    : 'Place new Point A (center)'}
              </button>
              <button
                type="button"
                onClick={clearAnchors}
                className="rounded-xl py-3 px-3 text-xs font-semibold bg-white/10 text-white border border-white/20"
              >
                Clear
              </button>
            </>
          )}
        </div>

        {freezeUrl && (
          <p className="text-[11px] text-white/60 text-center">
            Or tap the photo: Point A locks and stays. Then tap Point B.
          </p>
        )}

        {(phase === 'calibrate' || (freezeUrl && !feetPerPx)) && anchors.length === 2 && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
            <p className="text-xs text-amber-100 font-medium">
              Real length of A→B (from your tape)
            </p>
            <div className="flex gap-2 items-center">
              <input
                inputMode="decimal"
                value={calFt}
                onChange={(e) => setCalFt(e.target.value)}
                className="flex-1 h-11 rounded-lg bg-black/50 border border-white/25 text-white text-center text-lg font-semibold"
              />
              <span className="text-white/60 text-sm">ft</span>
              <input
                inputMode="decimal"
                value={calIn}
                onChange={(e) => setCalIn(e.target.value)}
                className="flex-1 h-11 rounded-lg bg-black/50 border border-white/25 text-white text-center text-lg font-semibold"
              />
              <span className="text-white/60 text-sm">in</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[
                { l: 'Door 3′', f: '3', i: '0' },
                { l: '2′', f: '2', i: '0' },
                { l: '4′', f: '4', i: '0' },
                { l: '1′', f: '1', i: '0' },
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
              Set scale
            </button>
          </div>
        )}

        {feetPerPx != null && feetPerPx > 0 && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
            <div className="flex justify-between items-start gap-2">
              <div className="grid grid-cols-2 gap-3 text-white flex-1">
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
              <button type="button" onClick={recalibrate} className="text-[11px] text-white/60 underline shrink-0">
                Recalibrate
              </button>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setShowManual((v) => !v)}
          className="w-full text-left text-xs text-white/55 py-0.5"
        >
          {showManual ? '▼ Hide manual ft/in' : '▶ Type tape reading (manual)'}
        </button>

        {showManual && (
          <div className="rounded-xl border border-white/15 bg-white/5 p-3 space-y-2">
            <div className="flex gap-2 items-center">
              <span className="text-[10px] text-white/50 w-12">
                {mode === 'height' ? 'Ht' : 'Len'}
              </span>
              <input
                inputMode="decimal"
                value={manLenFt}
                onChange={(e) => setManLenFt(e.target.value)}
                className="flex-1 h-10 rounded-lg bg-black/50 border border-white/25 text-white text-center font-semibold"
                placeholder="ft"
              />
              <span className="text-white/50 text-xs">ft</span>
              <input
                inputMode="decimal"
                value={manLenIn}
                onChange={(e) => setManLenIn(e.target.value)}
                className="flex-1 h-10 rounded-lg bg-black/50 border border-white/25 text-white text-center font-semibold"
                placeholder="in"
              />
              <span className="text-white/50 text-xs">in</span>
            </div>
            {mode === 'area' && (
              <div className="flex gap-2 items-center">
                <span className="text-[10px] text-white/50 w-12">Wid</span>
                <input
                  inputMode="decimal"
                  value={manWidFt}
                  onChange={(e) => setManWidFt(e.target.value)}
                  className="flex-1 h-10 rounded-lg bg-black/50 border border-white/25 text-white text-center font-semibold"
                  placeholder="ft"
                />
                <span className="text-white/50 text-xs">ft</span>
                <input
                  inputMode="decimal"
                  value={manWidIn}
                  onChange={(e) => setManWidIn(e.target.value)}
                  className="flex-1 h-10 rounded-lg bg-black/50 border border-white/25 text-white text-center font-semibold"
                  placeholder="in"
                />
                <span className="text-white/50 text-xs">in</span>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <div className="text-white min-w-0">
            <div className="text-[10px] uppercase text-white/50">Result → qty</div>
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
          Point A is locked on a frozen photo so it cannot follow your finger. Best accuracy: put a
          tape or known door in the same photo, calibrate on that, then measure other spans in that
          photo without moving.
        </p>
      </div>
    </div>
  );

  return createPortal(shell, document.body);
}
