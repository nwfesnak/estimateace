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
  /** Prefer SF when line is already area-priced */
  preferArea?: boolean;
};

type Capability = {
  webxr: boolean;
  camera: boolean;
  depthHint: string;
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
  const f = parseFloat(feetStr) || 0;
  const i = parseFloat(inchesStr) || 0;
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

function detectCapability(): Capability {
  if (typeof window === 'undefined') {
    return { webxr: false, camera: false, depthHint: 'Checking device…' };
  }
  const camera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const xr = !!(navigator as Navigator & { xr?: unknown }).xr;
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  const isProLike = /iPhone1[3-9]|iPhone[2-9]\d|iPadPro|iPad.*OS 1[5-9]/i.test(ua) || /Pro/i.test(ua);
  let depthHint = 'Camera measure · enter dimensions while viewing the job';
  if (xr) depthHint = 'AR measuring available (WebXR) · uses device depth / motion tracking';
  else if (isIOS && isProLike) {
    depthHint =
      'iPhone/iPad Pro has LiDAR hardware — Safari cannot open raw LiDAR yet. Use guided measure or AR on Android Chrome.';
  } else if (isIOS) {
    depthHint = 'Guided camera measure (enter ft/in while looking at the space)';
  }
  return { webxr: xr, camera, depthHint };
}

/**
 * LiDAR / AR measure tool for line-item quantities.
 * - WebXR immersive-ar + hit-test when the browser supports it (often Android ARCore)
 * - Always: live camera + feet/inches entry for length, area, or height
 * - Applies qty + unit (ft / SF / lf) back to the estimate line
 */
export function LidarMeasure({ open, onClose, onApply, preferArea = false }: LidarMeasureProps) {
  const [mounted, setMounted] = React.useState(false);
  const [mode, setMode] = React.useState<LidarMeasureMode>(preferArea ? 'area' : 'length');
  const [cap, setCap] = React.useState<Capability>({ webxr: false, camera: false, depthHint: '' });
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState('Ready');
  const [cameraReady, setCameraReady] = React.useState(false);
  const [arActive, setArActive] = React.useState(false);
  const [arPoints, setArPoints] = React.useState<number>(0);
  const [lastArMeters, setLastArMeters] = React.useState<number | null>(null);

  // Dimension fields (feet + inches)
  const [lenFt, setLenFt] = React.useState('');
  const [lenIn, setLenIn] = React.useState('');
  const [widFt, setWidFt] = React.useState('');
  const [widIn, setWidIn] = React.useState('');

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const xrSessionRef = React.useRef<XRSession | null>(null);
  const xrRefSpaceRef = React.useRef<XRReferenceSpace | null>(null);
  const hitTestSourceRef = React.useRef<XRHitTestSource | null>(null);
  const glRef = React.useRef<WebGLRenderingContext | null>(null);
  const anchorsRef = React.useRef<DOMPointReadOnly[]>([]);
  const lastHitPoseRef = React.useRef<DOMPointReadOnly | null>(null);
  const rafRef = React.useRef<number>(0);
  const viewportMetaPrev = React.useRef<string | null>(null);

  React.useEffect(() => setMounted(true), []);

  const lengthTotalFt = parseDim(lenFt, lenIn);
  const widthTotalFt = parseDim(widFt, widIn);
  const areaSqft =
    mode === 'area' && lengthTotalFt > 0 && widthTotalFt > 0
      ? Math.round(lengthTotalFt * widthTotalFt * 100) / 100
      : 0;

  const previewQty =
    mode === 'area'
      ? areaSqft
      : Math.round(lengthTotalFt * 1000) / 1000;

  const previewUnit = mode === 'area' ? 'SF' : mode === 'height' ? 'ft' : 'lf';

  const stopCamera = React.useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraReady(false);
  }, []);

  const stopAr = React.useCallback(async () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    try {
      hitTestSourceRef.current?.cancel?.();
    } catch {
      /* ignore */
    }
    hitTestSourceRef.current = null;
    try {
      await xrSessionRef.current?.end();
    } catch {
      /* ignore */
    }
    xrSessionRef.current = null;
    xrRefSpaceRef.current = null;
    glRef.current = null;
    anchorsRef.current = [];
    lastHitPoseRef.current = null;
    setArActive(false);
    setArPoints(0);
  }, []);

  const startCamera = React.useCallback(async () => {
    setError(null);
    setCameraReady(false);
    stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera not available. You can still enter dimensions below.');
      return;
    }
    const attempts: MediaStreamConstraints[] = [
      {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      },
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
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
      setError('Could not open camera. Enter ft/in manually — still works offline.');
      return;
    }
    streamRef.current = stream;
    const attach = async (n = 0): Promise<void> => {
      const video = videoRef.current;
      if (!video) {
        if (n < 40) {
          await new Promise((r) => requestAnimationFrame(() => r(undefined)));
          return attach(n + 1);
        }
        return;
      }
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', 'true');
      try {
        await video.play();
        setCameraReady(true);
        setStatus('Camera live — enter dimensions or start AR measure');
      } catch {
        setError('Preview blocked. Allow camera and retry.');
      }
    };
    await attach();
  }, [stopCamera]);

  const placeArPoint = React.useCallback(() => {
    const hit = lastHitPoseRef.current;
    if (!hit) {
      setStatus('No surface yet — aim at a floor/wall and try again');
      return;
    }
    const next = [...anchorsRef.current, hit];
    if (next.length > 2) next.shift();
    anchorsRef.current = next;
    setArPoints(next.length);

    if (next.length === 1) {
      setStatus('Point 1 set — aim at the far end and tap Place point');
      return;
    }

    const a = next[0];
    const b = next[1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const meters = Math.sqrt(dx * dx + dy * dy + dz * dz);
    setLastArMeters(meters);
    const { feet, inches, totalFeet } = metersToFeetInches(meters);
    setLenFt(String(feet));
    setLenIn(String(inches));
    setStatus(`AR measured ${formatFeet(totalFeet)} (${meters.toFixed(3)} m)`);
    try {
      navigator.vibrate?.([20, 40, 20]);
    } catch {
      /* ignore */
    }
  }, []);

  const startAr = React.useCallback(async () => {
    setError(null);
    await stopAr();
    stopCamera();

    const navXr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!navXr) {
      setError('AR not supported in this browser. Use camera + ft/in entry (works everywhere).');
      void startCamera();
      return;
    }

    try {
      const supported = await navXr.isSessionSupported('immersive-ar');
      if (!supported) {
        setError('Immersive AR not available on this device. Use guided measure below.');
        void startCamera();
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) {
        setError('AR canvas missing.');
        return;
      }
      const gl = canvas.getContext('webgl', { xrCompatible: true }) as WebGLRenderingContext | null;
      if (!gl) {
        setError('WebGL required for AR measure.');
        void startCamera();
        return;
      }
      glRef.current = gl;

      const overlayRoot = document.getElementById('lidar-measure-root') || undefined;
      const sessionOpts: Record<string, unknown> = {
        requiredFeatures: ['hit-test', 'local-floor'],
        optionalFeatures: ['dom-overlay', 'depth-sensing', 'light-estimation'],
      };
      if (overlayRoot) sessionOpts.domOverlay = { root: overlayRoot };

      const session = await navXr.requestSession('immersive-ar', sessionOpts);
      xrSessionRef.current = session;
      setArActive(true);
      setStatus('AR live — aim reticle at surface, Place point A then B');
      anchorsRef.current = [];
      setArPoints(0);
      setLastArMeters(null);

      const glAny = gl as WebGLRenderingContext & { makeXRCompatible?: () => Promise<void> };
      if (typeof glAny.makeXRCompatible === 'function') {
        await glAny.makeXRCompatible();
      }

      const XRLayerCtor = (globalThis as unknown as { XRWebGLLayer?: new (s: XRSession, g: WebGLRenderingContext) => XRWebGLLayer }).XRWebGLLayer;
      if (!XRLayerCtor) {
        throw new Error('XRWebGLLayer not available');
      }
      const layer = new XRLayerCtor(session, gl);
      await session.updateRenderState({ baseLayer: layer });

      const refSpace = await session.requestReferenceSpace('local-floor');
      xrRefSpaceRef.current = refSpace;

      const viewerSpace = await session.requestReferenceSpace('viewer');
      if (typeof session.requestHitTestSource !== 'function') {
        throw new Error('Hit-test not available in this AR session');
      }
      const hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
      hitTestSourceRef.current = hitTestSource;

      session.addEventListener('end', () => {
        xrSessionRef.current = null;
        setArActive(false);
        setStatus('AR session ended');
      });

      const onFrame: XRFrameRequestCallback = (time, frame) => {
        if (!xrSessionRef.current) return;
        rafRef.current = session.requestAnimationFrame(onFrame);
        const pose = frame.getViewerPose(refSpace);
        const baseLayer = session.renderState.baseLayer;
        if (pose && baseLayer && gl) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        }
        if (hitTestSource) {
          const hits = frame.getHitTestResults(hitTestSource);
          if (hits.length > 0) {
            const hitPose = hits[0].getPose(refSpace);
            if (hitPose) {
              lastHitPoseRef.current = hitPose.transform.position;
            }
          }
        }
        void time;
      };
      session.requestAnimationFrame(onFrame);
    } catch (e) {
      console.warn(e);
      setError(
        e instanceof Error
          ? `AR could not start: ${e.message}. Use guided ft/in measure instead.`
          : 'AR could not start. Use guided measure.'
      );
      setArActive(false);
      void startCamera();
    }
  }, [startCamera, stopAr, stopCamera]);

  // Open / close lifecycle
  React.useEffect(() => {
    if (!open) {
      void stopAr();
      stopCamera();
      setError(null);
      setStatus('Ready');
      setLastArMeters(null);
      setArPoints(0);
      return;
    }

    setCap(detectCapability());
    setMode(preferArea ? 'area' : 'length');
    setLenFt('');
    setLenIn('');
    setWidFt('');
    setWidIn('');
    setError(null);
    document.documentElement.classList.add('device-camera-lock');
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta) {
      viewportMetaPrev.current = meta.getAttribute('content');
      meta.setAttribute(
        'content',
        'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover'
      );
    }

    const t = window.setTimeout(() => {
      void startCamera();
    }, 50);

    return () => {
      window.clearTimeout(t);
      void stopAr();
      stopCamera();
      document.documentElement.classList.remove('device-camera-lock');
      const m = document.querySelector('meta[name="viewport"]');
      if (m && viewportMetaPrev.current != null) {
        m.setAttribute('content', viewportMetaPrev.current);
      }
    };
  }, [open, preferArea, startCamera, stopAr, stopCamera]);

  const applyMeasurement = () => {
    if (mode === 'area') {
      if (areaSqft <= 0) {
        setError('Enter length and width (ft / in) for area.');
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
      onClose();
      return;
    }

    if (lengthTotalFt <= 0) {
      setError(mode === 'height' ? 'Enter height in feet / inches.' : 'Enter length in feet / inches.');
      return;
    }
    const unit = mode === 'height' ? 'ft' : 'lf';
    const label =
      mode === 'height'
        ? `Height ${formatFeet(lengthTotalFt)}`
        : `Length ${formatFeet(lengthTotalFt)}`;
    onApply({
      qty: Math.round(lengthTotalFt * 1000) / 1000,
      unit,
      label,
      method: lastArMeters != null ? 'webxr' : 'manual',
      feet: Math.floor(lengthTotalFt),
      inches: Math.round((lengthTotalFt % 1) * 12 * 10) / 10,
    });
    onClose();
  };

  const useArAsLength = () => {
    if (lastArMeters == null) return;
    const { feet, inches } = metersToFeetInches(lastArMeters);
    setLenFt(String(feet));
    setLenIn(String(inches));
    setStatus('AR length loaded into fields — apply or measure width for area');
  };

  if (!mounted || !open) return null;

  const shell = (
    <div
      id="lidar-measure-root"
      className="device-camera-shell"
      role="dialog"
      aria-modal="true"
      aria-label="LiDAR measure"
      style={{ zIndex: 450, background: '#0a0a0a' }}
    >
      <canvas ref={canvasRef} className="absolute opacity-0 pointer-events-none w-px h-px" aria-hidden />

      {/* Top bar */}
      <div className="device-camera-top" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
        <div className="device-camera-top-info">
          <div className="device-camera-title">📡 LiDAR / AR Measure</div>
          <div className="device-camera-subtitle">{cap.depthHint}</div>
        </div>
        <button type="button" className="device-camera-done" onClick={onClose}>
          Close
        </button>
      </div>

      {/* Mode tabs */}
      <div className="flex gap-2 px-3 pb-2">
        {(
          [
            ['length', 'Length (LF)'],
            ['area', 'Area (SF)'],
            ['height', 'Height'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setMode(id)}
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

      {/* Viewfinder */}
      <div className="device-camera-frame px-3">
        <div className="device-camera-frame-border relative">
          <div className="device-camera-viewfinder">
            {!arActive && (
              <video
                ref={videoRef}
                className="device-camera-video"
                playsInline
                muted
                autoPlay
              />
            )}
            {arActive && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                <div className="text-center text-white px-4">
                  <div className="text-4xl mb-2">⌖</div>
                  <p className="text-sm font-medium">AR surface tracking</p>
                  <p className="text-xs text-white/70 mt-1">
                    Points placed: {arPoints}/2
                    {lastArMeters != null && (
                      <> · {formatFeet(metersToFeetInches(lastArMeters).totalFeet)}</>
                    )}
                  </p>
                </div>
              </div>
            )}

            {/* Center reticle */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
              <div className="w-10 h-10 border-2 border-[#10b981] rounded-full opacity-90 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]" />
              <div className="absolute w-0.5 h-5 bg-[#10b981]" />
              <div className="absolute h-0.5 w-5 bg-[#10b981]" />
            </div>

            {!cameraReady && !arActive && (
              <div className="device-camera-loading">
                <p className="text-sm text-white/80">{error || 'Starting camera…'}</p>
                {error && (
                  <button type="button" className="device-camera-retry mt-3" onClick={() => void startCamera()}>
                    Retry camera
                  </button>
                )}
              </div>
            )}

            <div className="absolute bottom-2 left-2 right-2 z-10 rounded-lg bg-black/55 px-3 py-2 text-[11px] text-white/90">
              {status}
            </div>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div
        className="px-3 pb-3 pt-2 space-y-3"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        <div className="flex gap-2">
          {cap.webxr && (
            <button
              type="button"
              onClick={() => (arActive ? void stopAr().then(() => startCamera()) : void startAr())}
              className={`flex-1 rounded-xl py-2.5 text-sm font-semibold border ${
                arActive
                  ? 'bg-amber-500/90 border-amber-400 text-black'
                  : 'bg-sky-500/90 border-sky-400 text-white'
              }`}
            >
              {arActive ? 'Stop AR' : 'Start AR / LiDAR'}
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
          {!cap.webxr && (
            <div className="flex-1 rounded-xl py-2 px-3 text-[11px] text-white/70 bg-white/5 border border-white/10">
              AR session not in this browser. Enter dimensions while viewing the job — same workflow as tape + phone.
            </div>
          )}
        </div>

        {lastArMeters != null && (
          <button
            type="button"
            onClick={useArAsLength}
            className="w-full text-xs text-emerald-300 underline"
          >
            Use last AR distance as length ({formatFeet(metersToFeetInches(lastArMeters).totalFeet)})
          </button>
        )}

        {/* Dimension inputs */}
        <div className="rounded-xl border border-white/15 bg-white/5 p-3 space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-white/50 mb-1.5">
              {mode === 'area' ? 'Length' : mode === 'height' ? 'Height' : 'Length'}
            </label>
            <div className="flex gap-2 items-center">
              <input
                inputMode="decimal"
                value={lenFt}
                onChange={(e) => setLenFt(e.target.value)}
                placeholder="0"
                className="flex-1 h-11 rounded-lg bg-black/40 border border-white/20 text-white text-center text-lg font-semibold"
              />
              <span className="text-white/60 text-sm">ft</span>
              <input
                inputMode="decimal"
                value={lenIn}
                onChange={(e) => setLenIn(e.target.value)}
                placeholder="0"
                className="flex-1 h-11 rounded-lg bg-black/40 border border-white/20 text-white text-center text-lg font-semibold"
              />
              <span className="text-white/60 text-sm">in</span>
            </div>
          </div>

          {mode === 'area' && (
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-white/50 mb-1.5">
                Width
              </label>
              <div className="flex gap-2 items-center">
                <input
                  inputMode="decimal"
                  value={widFt}
                  onChange={(e) => setWidFt(e.target.value)}
                  placeholder="0"
                  className="flex-1 h-11 rounded-lg bg-black/40 border border-white/20 text-white text-center text-lg font-semibold"
                />
                <span className="text-white/60 text-sm">ft</span>
                <input
                  inputMode="decimal"
                  value={widIn}
                  onChange={(e) => setWidIn(e.target.value)}
                  placeholder="0"
                  className="flex-1 h-11 rounded-lg bg-black/40 border border-white/20 text-white text-center text-lg font-semibold"
                />
                <span className="text-white/60 text-sm">in</span>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <div className="text-white">
              <div className="text-[10px] uppercase text-white/50">Result</div>
              <div className="text-xl font-bold tabular-nums">
                {previewQty > 0 ? (
                  <>
                    {previewQty.toLocaleString()}{' '}
                    <span className="text-base font-semibold text-emerald-400">{previewUnit}</span>
                  </>
                ) : (
                  <span className="text-white/40">—</span>
                )}
              </div>
              {mode === 'area' && lengthTotalFt > 0 && widthTotalFt > 0 && (
                <div className="text-[11px] text-white/55">
                  {formatFeet(lengthTotalFt)} × {formatFeet(widthTotalFt)}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={applyMeasurement}
              disabled={previewQty <= 0}
              className="rounded-xl px-5 py-3 text-sm font-bold bg-[#10b981] text-white disabled:opacity-40 disabled:cursor-not-allowed shadow-lg"
            >
              Apply to line
            </button>
          </div>
        </div>

        {error && !cameraReady && (
          <p className="text-xs text-amber-300/90 px-1">{error}</p>
        )}
        {error && cameraReady && (
          <p className="text-xs text-amber-300/90 px-1">{error}</p>
        )}
      </div>
    </div>
  );

  return createPortal(shell, document.body);
}

/* Minimal XR type shims so we don't need @types/webxr as a hard dep */
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
    getPose(space: XRReferenceSpace): { transform: { position: DOMPointReadOnly } } | null;
  }>;
};
type XRWebGLLayer = {
  framebuffer: WebGLFramebuffer | null;
};
