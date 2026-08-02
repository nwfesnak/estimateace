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
  /**
   * Stream acquired during the Measure button click (required for iOS Safari).
   * Component takes ownership and stops tracks on close.
   */
  initialStream?: MediaStream | null;
};

const M_TO_FT = 3.280839895;
const FT_TO_IN = 12;

function metersToFeetInches(meters: number): { feet: number; inches: number; totalFeet: number } {
  const totalInches = Math.max(0, meters * M_TO_FT * FT_TO_IN);
  const feet = Math.floor(totalInches / FT_TO_IN);
  const inches = Math.round((totalInches % FT_TO_IN) * 10) / 10;
  const totalFeet = Math.round((totalInches / FT_TO_IN) * 1000) / 1000;
  return { feet, inches, totalFeet };
}

function parseDim(feetStr: string, inchesStr: string): number {
  const f = parseFloat(String(feetStr).replace(/,/g, '')) || 0;
  const i = parseFloat(String(inchesStr).replace(/,/g, '')) || 0;
  if (!Number.isFinite(f) && !Number.isFinite(i)) return 0;
  return Math.max(0, f + i / 12);
}

function formatFeet(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const totalIn = n * 12;
  const ft = Math.floor(totalIn / 12);
  const inches = Math.round((totalIn % 12) * 10) / 10;
  if (ft === 0) return `${inches}"`;
  if (inches === 0) return `${ft}'`;
  return `${ft}' ${inches}"`;
}

function hasWebXr(): boolean {
  try {
    return !!(typeof navigator !== 'undefined' && (navigator as Navigator & { xr?: unknown }).xr);
  } catch {
    return false;
  }
}

/**
 * Job-site measure tool: fill line-item qty from length / area / height.
 * Camera + optional WebXR AR. Manual ft/in always works.
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
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState('Enter dimensions below');
  const [cameraReady, setCameraReady] = React.useState(false);
  const [cameraBusy, setCameraBusy] = React.useState(false);
  const [arSupported, setArSupported] = React.useState(false);
  const [arActive, setArActive] = React.useState(false);
  const [arPoints, setArPoints] = React.useState(0);
  const [lastArMeters, setLastArMeters] = React.useState<number | null>(null);
  const [webxrHint, setWebxrHint] = React.useState('');

  const [lenFt, setLenFt] = React.useState('');
  const [lenIn, setLenIn] = React.useState('');
  const [widFt, setWidFt] = React.useState('');
  const [widIn, setWidIn] = React.useState('');

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const xrSessionRef = React.useRef<XRSession | null>(null);
  const hitTestSourceRef = React.useRef<XRHitTestSource | null>(null);
  const anchorsRef = React.useRef<Array<{ x: number; y: number; z: number }>>([]);
  const lastHitPoseRef = React.useRef<{ x: number; y: number; z: number } | null>(null);
  const viewportMetaPrev = React.useRef<string | null>(null);
  const openGenRef = React.useRef(0);

  React.useEffect(() => setMounted(true), []);

  const lengthTotalFt = parseDim(lenFt, lenIn);
  const widthTotalFt = parseDim(widFt, widIn);
  const areaSqft =
    mode === 'area' && lengthTotalFt > 0 && widthTotalFt > 0
      ? Math.round(lengthTotalFt * widthTotalFt * 100) / 100
      : 0;
  const previewQty = mode === 'area' ? areaSqft : Math.round(lengthTotalFt * 1000) / 1000;
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

  const stopAr = React.useCallback(async () => {
    try {
      hitTestSourceRef.current?.cancel?.();
    } catch {
      /* ignore */
    }
    hitTestSourceRef.current = null;
    try {
      if (xrSessionRef.current) await xrSessionRef.current.end();
    } catch {
      /* ignore */
    }
    xrSessionRef.current = null;
    anchorsRef.current = [];
    lastHitPoseRef.current = null;
    setArActive(false);
    setArPoints(0);
  }, []);

  const attachStreamToVideo = React.useCallback(async (stream: MediaStream, gen: number) => {
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
            setStatus('Camera live — enter ft/in, then Apply to line');
            setError(null);
          }
          return;
        } catch (e) {
          console.warn('video.play failed', e);
          if (gen === openGenRef.current) {
            setError('Camera preview blocked. Dimensions still work — enter ft/in below.');
            setStatus('Enter dimensions below');
          }
          return;
        }
      }
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    }
    if (gen === openGenRef.current) {
      setError('Camera view failed to attach. Enter ft/in below — measuring still works.');
    }
  }, []);

  const requestCamera = React.useCallback(
    async (gen: number) => {
      setCameraBusy(true);
      setError(null);
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setError('Camera not supported here. Enter feet and inches below.');
          setStatus('Manual measure');
          return;
        }
        // Prefer rear camera; fall back progressively
        const attempts: MediaStreamConstraints[] = [
          { video: { facingMode: { ideal: 'environment' } }, audio: false },
          { video: { facingMode: 'environment' }, audio: false },
          { video: true, audio: false },
        ];
        let stream: MediaStream | null = null;
        let lastErr: unknown;
        for (const c of attempts) {
          try {
            stream = await navigator.mediaDevices.getUserMedia(c);
            break;
          } catch (e) {
            lastErr = e;
          }
        }
        if (!stream) {
          console.warn(lastErr);
          setError('Camera permission denied or unavailable. Enter ft/in below — still works.');
          setStatus('Manual measure');
          return;
        }
        if (gen !== openGenRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        // Replace any previous stream
        if (streamRef.current && streamRef.current !== stream) {
          streamRef.current.getTracks().forEach((t) => t.stop());
        }
        await attachStreamToVideo(stream, gen);
      } finally {
        if (gen === openGenRef.current) setCameraBusy(false);
      }
    },
    [attachStreamToVideo]
  );

  // Open / close
  React.useEffect(() => {
    if (!open) {
      openGenRef.current += 1;
      void stopAr();
      stopCamera();
      setError(null);
      setStatus('Enter dimensions below');
      setLastArMeters(null);
      setArPoints(0);
      setArActive(false);
      setCameraBusy(false);
      return;
    }

    const gen = ++openGenRef.current;
    setMode(preferArea ? 'area' : 'length');
    setLenFt('');
    setLenIn('');
    setWidFt('');
    setWidIn('');
    setError(null);
    setLastArMeters(null);
    setArPoints(0);
    setStatus('Enter dimensions below');

    document.documentElement.classList.add('device-camera-lock');
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta) {
      viewportMetaPrev.current = meta.getAttribute('content');
      meta.setAttribute(
        'content',
        'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover'
      );
    }

    // Detect AR support (async, non-blocking)
    setArSupported(hasWebXr());
    setWebxrHint(
      hasWebXr()
        ? 'AR available on this browser when Start AR works'
        : 'AR not in this browser — use camera + ft/in (same as tape + phone)'
    );
    void (async () => {
      try {
        const xr = (navigator as Navigator & { xr?: { isSessionSupported?: (m: string) => Promise<boolean> } }).xr;
        if (xr?.isSessionSupported) {
          const ok = await xr.isSessionSupported('immersive-ar');
          if (gen === openGenRef.current) {
            setArSupported(!!ok);
            setWebxrHint(
              ok
                ? 'Tap Start AR, aim at floor/wall, place 2 points'
                : 'Immersive AR not on this device — use ft/in fields'
            );
          }
        }
      } catch {
        /* ignore */
      }
    })();

    // Use stream from Measure button click first (iOS needs user gesture)
    if (initialStream && initialStream.getTracks().some((t) => t.readyState === 'live')) {
      void attachStreamToVideo(initialStream, gen);
    } else {
      // Still try after a tick (Android / desktop often allow this)
      const t = window.setTimeout(() => {
        if (gen === openGenRef.current && !streamRef.current) {
          void requestCamera(gen);
        }
      }, 80);
      return () => {
        window.clearTimeout(t);
        openGenRef.current += 1;
        void stopAr();
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
      void stopAr();
      stopCamera();
      document.documentElement.classList.remove('device-camera-lock');
      const m = document.querySelector('meta[name="viewport"]');
      if (m && viewportMetaPrev.current != null) {
        m.setAttribute('content', viewportMetaPrev.current);
        viewportMetaPrev.current = null;
      }
    };
    // initialStream only used on open transition
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preferArea]);

  const placeArPoint = () => {
    const hit = lastHitPoseRef.current;
    if (!hit) {
      setStatus('No surface lock yet — move phone slowly over floor/wall, then Place again');
      setError(null);
      return;
    }
    const next = [...anchorsRef.current, hit];
    if (next.length > 2) next.shift();
    anchorsRef.current = next;
    setArPoints(next.length);

    if (next.length === 1) {
      setStatus('Point 1 set — aim at the other end, then Place point');
      return;
    }

    const a = next[0];
    const b = next[1];
    const meters = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2);
    setLastArMeters(meters);
    const { feet, inches, totalFeet } = metersToFeetInches(meters);
    setLenFt(String(feet));
    setLenIn(String(inches));
    setStatus(`Measured ${formatFeet(totalFeet)} — tap Apply to line`);
    setError(null);
    try {
      navigator.vibrate?.([15, 30, 15]);
    } catch {
      /* ignore */
    }
  };

  const startAr = async () => {
    setError(null);
    await stopAr();
    // Keep camera stream? WebXR usually takes the camera — stop ours
    stopCamera();

    const navXr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!navXr) {
      setError('WebXR not available. Enter ft/in and Apply — that always works.');
      void requestCamera(openGenRef.current);
      return;
    }

    try {
      const supported = await navXr.isSessionSupported('immersive-ar');
      if (!supported) {
        setError('AR session not supported on this phone/browser. Use ft/in fields.');
        void requestCamera(openGenRef.current);
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) {
        setError('AR canvas missing — refresh and try again.');
        return;
      }

      const gl = canvas.getContext('webgl', { xrCompatible: true }) as
        | (WebGLRenderingContext & { makeXRCompatible?: () => Promise<void> })
        | null;
      if (!gl) {
        setError('WebGL needed for AR. Use ft/in fields instead.');
        void requestCamera(openGenRef.current);
        return;
      }

      const overlayRoot = document.getElementById('lidar-measure-root') || undefined;
      const sessionOpts: Record<string, unknown> = {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['local-floor', 'local', 'dom-overlay', 'depth-sensing'],
      };
      if (overlayRoot) sessionOpts.domOverlay = { root: overlayRoot };

      let session: XRSession;
      try {
        session = await navXr.requestSession('immersive-ar', {
          ...sessionOpts,
          requiredFeatures: ['hit-test', 'local-floor'],
        });
      } catch {
        // Retry without local-floor / dom-overlay
        session = await navXr.requestSession('immersive-ar', {
          requiredFeatures: ['hit-test'],
          optionalFeatures: ['local'],
        });
      }

      xrSessionRef.current = session;
      setArActive(true);
      setStatus('AR on — aim reticle, Place point twice');
      anchorsRef.current = [];
      setArPoints(0);
      setLastArMeters(null);

      if (typeof gl.makeXRCompatible === 'function') {
        await gl.makeXRCompatible();
      }

      const XRLayerCtor = (
        globalThis as unknown as {
          XRWebGLLayer?: new (s: XRSession, g: WebGLRenderingContext) => XRWebGLLayer;
        }
      ).XRWebGLLayer;
      if (!XRLayerCtor) throw new Error('XRWebGLLayer missing');

      const layer = new XRLayerCtor(session, gl);
      await session.updateRenderState({ baseLayer: layer });

      let refSpace: XRReferenceSpace;
      try {
        refSpace = await session.requestReferenceSpace('local-floor');
      } catch {
        refSpace = await session.requestReferenceSpace('local');
      }

      const viewerSpace = await session.requestReferenceSpace('viewer');
      if (typeof session.requestHitTestSource !== 'function') {
        throw new Error('Hit-test not available');
      }
      const hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
      hitTestSourceRef.current = hitTestSource;

      session.addEventListener('end', () => {
        xrSessionRef.current = null;
        setArActive(false);
        setStatus('AR ended — enter or edit ft/in below');
      });

      const onFrame: XRFrameRequestCallback = (_time, frame) => {
        if (!xrSessionRef.current) return;
        session.requestAnimationFrame(onFrame);
        const baseLayer = session.renderState.baseLayer;
        const pose = frame.getViewerPose(refSpace);
        if (pose && baseLayer) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        }
        const hits = frame.getHitTestResults(hitTestSource);
        if (hits.length > 0) {
          const hitPose = hits[0].getPose(refSpace);
          if (hitPose?.transform?.position) {
            const p = hitPose.transform.position;
            lastHitPoseRef.current = { x: p.x, y: p.y, z: p.z };
          }
        }
      };
      session.requestAnimationFrame(onFrame);
    } catch (e) {
      console.warn(e);
      setArActive(false);
      setError(
        e instanceof Error
          ? `AR failed (${e.message}). Use feet/inches below — Apply still works.`
          : 'AR failed. Use feet/inches below.'
      );
      void requestCamera(openGenRef.current);
    }
  };

  const applyMeasurement = () => {
    setError(null);
    if (mode === 'area') {
      if (areaSqft <= 0) {
        setError('Enter length AND width (feet / inches).');
        return;
      }
      onApply({
        qty: areaSqft,
        unit: 'SF',
        label: `${formatFeet(lengthTotalFt)} × ${formatFeet(widthTotalFt)} = ${areaSqft.toLocaleString()} SF`,
        method: lastArMeters != null ? 'webxr' : 'manual',
        lengthFt: lengthTotalFt,
        widthFt: widthTotalFt,
      });
      return;
    }
    if (lengthTotalFt <= 0) {
      setError(mode === 'height' ? 'Enter height (feet / inches).' : 'Enter length (feet / inches).');
      return;
    }
    const unit = mode === 'height' ? 'ft' : 'lf';
    onApply({
      qty: Math.round(lengthTotalFt * 1000) / 1000,
      unit,
      label: mode === 'height' ? `Height ${formatFeet(lengthTotalFt)}` : `Length ${formatFeet(lengthTotalFt)}`,
      method: lastArMeters != null ? 'webxr' : 'manual',
      feet: Math.floor(lengthTotalFt),
      inches: Math.round((lengthTotalFt % 1) * 12 * 10) / 10,
    });
  };

  const handleClose = () => {
    void stopAr();
    stopCamera();
    onClose();
  };

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
      <canvas ref={canvasRef} className="absolute opacity-0 pointer-events-none w-px h-px" aria-hidden />

      <div className="device-camera-top" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
        <div className="device-camera-top-info">
          <div className="device-camera-title">📡 Measure</div>
          <div className="device-camera-subtitle">{webxrHint || 'Camera + ft/in → line item qty'}</div>
        </div>
        <button type="button" className="device-camera-done" onClick={handleClose}>
          Close
        </button>
      </div>

      <div className="flex gap-2 px-3 pb-2">
        {(
          [
            ['length', 'Length'],
            ['area', 'Area (SF)'],
            ['height', 'Height'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setMode(id);
              setError(null);
            }}
            className={`flex-1 rounded-full py-2 text-xs font-semibold border transition ${
              mode === id
                ? 'bg-[#10b981] border-[#10b981] text-white'
                : 'bg-white/10 border-white/20 text-white/80'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="device-camera-frame px-3" style={{ maxHeight: '32vh' }}>
        <div className="device-camera-frame-border relative">
          <div className="device-camera-viewfinder">
            {!arActive && (
              <video ref={videoRef} className="device-camera-video" playsInline muted autoPlay />
            )}
            {arActive && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-[2]">
                <div className="text-center text-white px-4">
                  <div className="text-3xl mb-1">⌖</div>
                  <p className="text-sm font-medium">AR tracking</p>
                  <p className="text-xs text-white/70">
                    Points {arPoints}/2
                    {lastArMeters != null && <> · {formatFeet(metersToFeetInches(lastArMeters).totalFeet)}</>}
                  </p>
                </div>
              </div>
            )}

            <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
              <div className="w-9 h-9 border-2 border-[#10b981] rounded-full opacity-90" />
              <div className="absolute w-0.5 h-4 bg-[#10b981]" />
              <div className="absolute h-0.5 w-4 bg-[#10b981]" />
            </div>

            {!cameraReady && !arActive && (
              <div className="device-camera-loading">
                <p className="text-sm text-white/85 text-center px-4">
                  {cameraBusy ? 'Starting camera…' : error || 'Camera optional — enter ft/in below'}
                </p>
                <button
                  type="button"
                  className="device-camera-retry mt-3"
                  onClick={() => void requestCamera(openGenRef.current)}
                  disabled={cameraBusy}
                >
                  {cameraBusy ? 'Please wait…' : 'Enable camera'}
                </button>
              </div>
            )}

            <div className="absolute bottom-2 left-2 right-2 z-10 rounded-lg bg-black/60 px-3 py-1.5 text-[11px] text-white/90">
              {status}
            </div>
          </div>
        </div>
      </div>

      <div
        className="px-3 pt-2 space-y-3 overflow-y-auto"
        style={{ paddingBottom: 'max(0.85rem, env(safe-area-inset-bottom))', flex: '1 1 auto' }}
      >
        <div className="flex gap-2">
          {arSupported && (
            <button
              type="button"
              onClick={() => (arActive ? void stopAr().then(() => requestCamera(openGenRef.current)) : void startAr())}
              className={`flex-1 rounded-xl py-2.5 text-sm font-semibold border ${
                arActive
                  ? 'bg-amber-500 border-amber-400 text-black'
                  : 'bg-sky-600 border-sky-500 text-white'
              }`}
            >
              {arActive ? 'Stop AR' : 'Start AR'}
            </button>
          )}
          {arActive && (
            <button
              type="button"
              onClick={placeArPoint}
              className="flex-1 rounded-xl py-2.5 text-sm font-semibold bg-[#10b981] text-white border border-emerald-400"
            >
              Place point ({arPoints}/2)
            </button>
          )}
          {!arSupported && (
            <button
              type="button"
              onClick={() => void requestCamera(openGenRef.current)}
              className="flex-1 rounded-xl py-2.5 text-sm font-semibold bg-white/10 border border-white/20 text-white"
            >
              {cameraReady ? 'Restart camera' : 'Enable camera'}
            </button>
          )}
        </div>

        <div className="rounded-xl border border-white/15 bg-white/5 p-3 space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-white/50 mb-1.5">
              {mode === 'height' ? 'Height' : 'Length'}
            </label>
            <div className="flex gap-2 items-center">
              <input
                inputMode="decimal"
                value={lenFt}
                onChange={(e) => setLenFt(e.target.value)}
                placeholder="0"
                className="flex-1 h-12 rounded-lg bg-black/50 border border-white/25 text-white text-center text-lg font-semibold"
                autoComplete="off"
              />
              <span className="text-white/60 text-sm w-6">ft</span>
              <input
                inputMode="decimal"
                value={lenIn}
                onChange={(e) => setLenIn(e.target.value)}
                placeholder="0"
                className="flex-1 h-12 rounded-lg bg-black/50 border border-white/25 text-white text-center text-lg font-semibold"
                autoComplete="off"
              />
              <span className="text-white/60 text-sm w-6">in</span>
            </div>
          </div>

          {mode === 'area' && (
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-white/50 mb-1.5">Width</label>
              <div className="flex gap-2 items-center">
                <input
                  inputMode="decimal"
                  value={widFt}
                  onChange={(e) => setWidFt(e.target.value)}
                  placeholder="0"
                  className="flex-1 h-12 rounded-lg bg-black/50 border border-white/25 text-white text-center text-lg font-semibold"
                  autoComplete="off"
                />
                <span className="text-white/60 text-sm w-6">ft</span>
                <input
                  inputMode="decimal"
                  value={widIn}
                  onChange={(e) => setWidIn(e.target.value)}
                  placeholder="0"
                  className="flex-1 h-12 rounded-lg bg-black/50 border border-white/25 text-white text-center text-lg font-semibold"
                  autoComplete="off"
                />
                <span className="text-white/60 text-sm w-6">in</span>
              </div>
            </div>
          )}

          {/* Quick fill chips */}
          <div className="flex flex-wrap gap-1.5">
            {(mode === 'area'
              ? [
                  { l: '10×12', lf: '10', li: '0', wf: '12', wi: '0' },
                  { l: '12×12', lf: '12', li: '0', wf: '12', wi: '0' },
                  { l: '12×14', lf: '12', li: '0', wf: '14', wi: '0' },
                  { l: '15×15', lf: '15', li: '0', wf: '15', wi: '0' },
                ]
              : [
                  { l: '8 ft', lf: '8', li: '0' },
                  { l: '10 ft', lf: '10', li: '0' },
                  { l: '12 ft', lf: '12', li: '0' },
                  { l: '16 ft', lf: '16', li: '0' },
                  { l: '20 ft', lf: '20', li: '0' },
                ]
            ).map((chip) => (
              <button
                key={chip.l}
                type="button"
                onClick={() => {
                  setLenFt(chip.lf);
                  setLenIn(chip.li);
                  if ('wf' in chip && chip.wf != null) {
                    setWidFt(chip.wf);
                    setWidIn(chip.wi || '0');
                  }
                  setError(null);
                }}
                className="rounded-full px-2.5 py-1 text-[11px] font-medium bg-white/10 text-white/85 border border-white/15"
              >
                {chip.l}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            <div className="text-white min-w-0">
              <div className="text-[10px] uppercase text-white/50">Result</div>
              <div className="text-xl font-bold tabular-nums truncate">
                {previewQty > 0 ? (
                  <>
                    {previewQty.toLocaleString()}{' '}
                    <span className="text-base font-semibold text-emerald-400">{previewUnit}</span>
                  </>
                ) : (
                  <span className="text-white/35">—</span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={applyMeasurement}
              disabled={previewQty <= 0}
              className="shrink-0 rounded-xl px-5 py-3.5 text-sm font-bold bg-[#10b981] text-white disabled:opacity-40 disabled:cursor-not-allowed shadow-lg active:scale-[0.98]"
            >
              Apply to line
            </button>
          </div>
        </div>

        {error && <p className="text-xs text-amber-300 px-1 leading-snug">{error}</p>}
        <p className="text-[10px] text-white/40 px-1 leading-snug">
          Tip: enter tape measurements in ft/in and Apply. True AR works on some Android Chrome phones; iPhone
          Safari cannot use hardware LiDAR yet.
        </p>
      </div>
    </div>
  );

  return createPortal(shell, document.body);
}

/* Minimal XR shims */
type XRSystem = {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(mode: string, options?: Record<string, unknown>): Promise<XRSession>;
};
type XRSession = {
  requestReferenceSpace(type: string): Promise<XRReferenceSpace>;
  requestHitTestSource?(opts: { space: XRReferenceSpace }): Promise<XRHitTestSource>;
  updateRenderState(state: { baseLayer?: XRWebGLLayer }): Promise<void> | void;
  requestAnimationFrame(cb: XRFrameRequestCallback): number;
  end(): Promise<void>;
  addEventListener(type: string, listener: () => void): void;
  renderState: { baseLayer: XRWebGLLayer | null };
};
type XRReferenceSpace = unknown;
type XRHitTestSource = { cancel?: () => void };
type XRFrameRequestCallback = (time: number, frame: XRFrame) => void;
type XRFrame = {
  getViewerPose(space: XRReferenceSpace): { transform: unknown } | null;
  getHitTestResults(source: XRHitTestSource): Array<{
    getPose(space: XRReferenceSpace): { transform: { position: { x: number; y: number; z: number } } } | null;
  }>;
};
type XRWebGLLayer = { framebuffer: WebGLFramebuffer | null };
