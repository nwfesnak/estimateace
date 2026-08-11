'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';

/** UI zoom: 1 = widest / normal FOV; user can go higher like a phone camera */
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.25;

export type DeviceCameraMode = 'photo' | 'video';

type DeviceCameraProps = {
  open: boolean;
  mode?: DeviceCameraMode;
  onClose: (capturedCount: number) => void;
  onPhoto?: (file: File) => void | Promise<void>;
  onVideo?: (file: File) => void | Promise<void>;
};

type ZoomCaps = {
  min: number;
  max: number;
  step: number;
  /** True when the track accepts the `zoom` constraint (optical / continuous zoom). */
  hardware: boolean;
};

function clampZoom(z: number, max = MAX_ZOOM) {
  return Math.min(max, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
}

function readZoomCaps(track: MediaStreamTrack | null | undefined): ZoomCaps {
  const fallback: ZoomCaps = { min: 1, max: 1, step: 0.1, hardware: false };
  if (!track?.getCapabilities) return fallback;
  try {
    const caps = track.getCapabilities() as MediaTrackCapabilities & {
      zoom?: number | { min?: number; max?: number; step?: number };
    };
    const z = caps.zoom;
    if (z == null) return fallback;
    if (typeof z === 'number') {
      return { min: z, max: z, step: 0.1, hardware: true };
    }
    const min = Number(z.min);
    const max = Number(z.max);
    const step = Number(z.step);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
      return fallback;
    }
    return {
      min,
      max,
      step: Number.isFinite(step) && step > 0 ? step : 0.1,
      hardware: true,
    };
  } catch {
    return fallback;
  }
}

/**
 * Map UI zoom (1 = normal wide) onto hardware zoom.
 * UI 1 → hardware min (widest FOV). Higher UI values stretch toward hardware max,
 * then remaining zoom is done digitally via CSS.
 */
function uiToHardwareZoom(uiZoom: number, caps: ZoomCaps): number {
  if (!caps.hardware) return caps.min;
  const ui = Math.max(MIN_ZOOM, uiZoom);
  // Hardware range expressed as multipliers from min: e.g. min=1 max=5 → up to 5× optical
  const hwSpan = caps.max / Math.max(caps.min, 0.001);
  // Use hardware for the first portion of zoom (up to hwSpan ×), rest is digital
  const hwFactor = Math.min(ui, hwSpan);
  let hw = caps.min * hwFactor;
  hw = Math.min(caps.max, Math.max(caps.min, hw));
  // Snap to step when available
  if (caps.step > 0) {
    const steps = Math.round((hw - caps.min) / caps.step);
    hw = caps.min + steps * caps.step;
    hw = Math.min(caps.max, Math.max(caps.min, hw));
  }
  return hw;
}

/** Digital CSS scale after hardware has done as much as it can. */
function digitalScaleFromUi(uiZoom: number, caps: ZoomCaps): number {
  const ui = Math.max(MIN_ZOOM, uiZoom);
  if (!caps.hardware) return ui;
  const hwSpan = caps.max / Math.max(caps.min, 0.001);
  if (ui <= hwSpan) return 1;
  return ui / hwSpan;
}

async function applyHardwareZoom(track: MediaStreamTrack, zoomValue: number) {
  try {
    await track.applyConstraints({
      advanced: [{ zoom: zoomValue } as MediaTrackConstraintSet],
    });
  } catch {
    try {
      await track.applyConstraints({
        // Some browsers accept zoom at the top level
        // @ts-expect-error zoom is non-standard but widely supported on mobile
        zoom: zoomValue,
      });
    } catch {
      // ignore
    }
  }
}

/**
 * Capture crop for the viewfinder.
 * zoom === 1 (and digital scale 1) → full video frame.
 * digital zoom > 1 → center crop matching CSS scale + object-fit cover.
 */
function cropForCapture(
  videoW: number,
  videoH: number,
  viewW: number,
  viewH: number,
  digitalScale: number
) {
  const z = Math.max(1, digitalScale);
  if (z <= 1.001) {
    return {
      sx: 0,
      sy: 0,
      cropW: Math.round(videoW),
      cropH: Math.round(videoH),
    };
  }

  const va = videoW / Math.max(1, videoH);
  const ba = viewW / Math.max(1, viewH);
  let cropW: number;
  let cropH: number;
  if (va > ba) {
    cropH = videoH;
    cropW = videoH * ba;
  } else {
    cropW = videoW;
    cropH = videoW / ba;
  }
  cropW = Math.max(1, cropW / z);
  cropH = Math.max(1, cropH / z);
  const sx = Math.max(0, (videoW - cropW) / 2);
  const sy = Math.max(0, (videoH - cropH) / 2);
  return {
    sx: Math.round(sx),
    sy: Math.round(sy),
    cropW: Math.round(Math.min(cropW, videoW - sx)),
    cropH: Math.round(Math.min(cropH, videoH - sy)),
  };
}

/**
 * Device-style camera:
 * - Opens at normal wide FOV (hardware min zoom, no forced telephoto resolution)
 * - Pinch + ± controls zoom like a phone camera
 * - Shell / border / shutter never scale
 */
export function DeviceCamera({
  open,
  mode = 'photo',
  onClose,
  onPhoto,
  onVideo,
}: DeviceCameraProps) {
  const [mounted, setMounted] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [zoom, setZoom] = React.useState(1);
  const [captured, setCaptured] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [flashOn, setFlashOn] = React.useState(false);
  const [recording, setRecording] = React.useState(false);
  const [recordMs, setRecordMs] = React.useState(0);

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const viewfinderRef = React.useRef<HTMLDivElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const trackRef = React.useRef<MediaStreamTrack | null>(null);
  const zoomCapsRef = React.useRef<ZoomCaps>({ min: 1, max: 1, step: 0.1, hardware: false });
  const flashRef = React.useRef<HTMLDivElement>(null);
  const zoomRef = React.useRef(1);
  const capturedRef = React.useRef(0);
  const viewportMetaPrev = React.useRef<string | null>(null);
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const recordedChunksRef = React.useRef<Blob[]>([]);
  const recordTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  // Pinch state
  const pinchStartDistRef = React.useRef(0);
  const pinchStartZoomRef = React.useRef(1);

  React.useEffect(() => setMounted(true), []);

  const stopStream = React.useCallback(() => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    } catch {
      // ignore
    }
    mediaRecorderRef.current = null;
    recordedChunksRef.current = [];
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    trackRef.current = null;
    zoomCapsRef.current = { min: 1, max: 1, step: 0.1, hardware: false };
    if (videoRef.current) videoRef.current.srcObject = null;
    setRecording(false);
    setRecordMs(0);
  }, []);

  const applyZoom = React.useCallback(async (value: number) => {
    const next = clampZoom(value);
    zoomRef.current = next;
    setZoom(next);

    const track = trackRef.current;
    const caps = zoomCapsRef.current;
    if (track && caps.hardware) {
      const hw = uiToHardwareZoom(next, caps);
      await applyHardwareZoom(track, hw);
    }
  }, []);

  const setZoomLevel = React.useCallback(
    (value: number) => {
      void applyZoom(value);
    },
    [applyZoom]
  );

  const fireFlash = React.useCallback(() => {
    setFlashOn(true);
    const el = flashRef.current;
    if (el) {
      el.classList.remove('device-camera-flash');
      void el.offsetWidth;
      el.classList.add('device-camera-flash');
    }
    window.setTimeout(() => setFlashOn(false), 220);
    try {
      navigator.vibrate?.(40);
    } catch {
      // ignore
    }
  }, []);

  const startCamera = React.useCallback(async () => {
    setError(null);
    setReady(false);
    stopStream();

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera not supported in this browser. Use HTTPS on a phone/tablet.');
      return;
    }

    /*
     * IMPORTANT: Do NOT force 1080×1920 (or similar). On multi-lens phones that
     * often selects a telephoto / cropped sensor, so "1×" already looks zoomed-in.
     * Request rear camera only and let the device pick its normal wide default.
     */
    const attempts: MediaStreamConstraints[] = [
      {
        video: {
          facingMode: { ideal: 'environment' },
          // Prefer a normal working resolution without locking a tall portrait crop
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: mode === 'video',
      },
      {
        video: { facingMode: { ideal: 'environment' } },
        audio: mode === 'video',
      },
      { video: true, audio: mode === 'video' },
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
      console.error(lastErr);
      setError('Could not open camera. Allow camera permission and try again.');
      return;
    }

    streamRef.current = stream;
    const track = stream.getVideoTracks()[0] ?? null;
    trackRef.current = track;

    const caps = readZoomCaps(track);
    zoomCapsRef.current = caps;

    // Always open at widest hardware FOV (true normal range)
    if (track && caps.hardware) {
      await applyHardwareZoom(track, caps.min);
    }

    zoomRef.current = 1;
    setZoom(1);

    const attach = async (n = 0): Promise<void> => {
      const video = videoRef.current;
      if (!video) {
        if (n < 50) {
          await new Promise((r) => requestAnimationFrame(() => r(undefined)));
          return attach(n + 1);
        }
        setError('Camera view failed to load.');
        return;
      }
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', 'true');
      video.setAttribute('webkit-playsinline', 'true');
      try {
        await video.play();
        // Re-assert min zoom after play — some devices reset mid-start
        if (track && caps.hardware) {
          await applyHardwareZoom(track, caps.min);
        }
        setReady(true);
      } catch (e) {
        console.warn(e);
        setError('Could not start preview. Tap retry.');
      }
    };
    await attach();
  }, [mode, stopStream]);

  // Pinch-to-zoom on the viewfinder (phone-like)
  React.useEffect(() => {
    if (!open) return;
    const el = viewfinderRef.current;
    if (!el) return;

    const dist = (t: TouchList) => {
      if (t.length < 2) return 0;
      const a = t[0];
      const b = t[1];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        pinchStartDistRef.current = dist(e.touches);
        pinchStartZoomRef.current = zoomRef.current;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchStartDistRef.current > 0) {
        e.preventDefault();
        const d = dist(e.touches);
        if (d <= 0) return;
        const ratio = d / pinchStartDistRef.current;
        const next = clampZoom(pinchStartZoomRef.current * ratio);
        void applyZoom(next);
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        pinchStartDistRef.current = 0;
      }
    };

    const opts: AddEventListenerOptions = { passive: false };
    el.addEventListener('touchstart', onTouchStart, opts);
    el.addEventListener('touchmove', onTouchMove, opts);
    el.addEventListener('touchend', onTouchEnd, opts);
    el.addEventListener('touchcancel', onTouchEnd, opts);

    return () => {
      el.removeEventListener('touchstart', onTouchStart, opts);
      el.removeEventListener('touchmove', onTouchMove, opts);
      el.removeEventListener('touchend', onTouchEnd, opts);
      el.removeEventListener('touchcancel', onTouchEnd, opts);
    };
  }, [open, ready, applyZoom]);

  // Open / close: lock page zoom so browser chrome doesn't steal pinch
  React.useEffect(() => {
    if (!open) {
      stopStream();
      setReady(false);
      setError(null);
      zoomRef.current = 1;
      setZoom(1);
      setCaptured(0);
      capturedRef.current = 0;
      setBusy(false);
      setFlashOn(false);
      return;
    }

    zoomRef.current = 1;
    setZoom(1);

    document.documentElement.classList.add('device-camera-lock');
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta) {
      viewportMetaPrev.current = meta.getAttribute('content');
      meta.setAttribute(
        'content',
        'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover'
      );
    }

    // Block page-level pinch / gesture zoom outside the viewfinder
    const blockPagePinch = (e: TouchEvent) => {
      if (e.touches.length < 2) return;
      const vf = viewfinderRef.current;
      if (vf && e.target instanceof Node && vf.contains(e.target)) return;
      e.preventDefault();
    };
    const blockGesture = (e: Event) => e.preventDefault();
    const blockWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    const opts: AddEventListenerOptions = { passive: false, capture: true };
    document.addEventListener('touchmove', blockPagePinch, opts);
    document.addEventListener('touchstart', blockPagePinch, opts);
    document.addEventListener('gesturestart', blockGesture, opts);
    document.addEventListener('gesturechange', blockGesture, opts);
    document.addEventListener('wheel', blockWheel, opts);

    const t = window.setTimeout(() => void startCamera(), 40);

    return () => {
      window.clearTimeout(t);
      stopStream();
      document.documentElement.classList.remove('device-camera-lock');
      const m = document.querySelector('meta[name="viewport"]');
      if (m && viewportMetaPrev.current != null) {
        m.setAttribute('content', viewportMetaPrev.current);
        viewportMetaPrev.current = null;
      }
      document.removeEventListener('touchmove', blockPagePinch, opts);
      document.removeEventListener('touchstart', blockPagePinch, opts);
      document.removeEventListener('gesturestart', blockGesture, opts);
      document.removeEventListener('gesturechange', blockGesture, opts);
      document.removeEventListener('wheel', blockWheel, opts);
    };
  }, [open, startCamera, stopStream]);

  const digitalScale = digitalScaleFromUi(zoom, zoomCapsRef.current);

  const takePhoto = React.useCallback(async () => {
    if (busy || mode !== 'photo') return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const box = viewfinderRef.current;
    if (!video || !canvas || !ready || !video.videoWidth) {
      setError('Camera not ready yet.');
      return;
    }

    setBusy(true);
    setError(null);
    fireFlash();

    try {
      const viewW = box?.clientWidth || window.innerWidth;
      const viewH = box?.clientHeight || window.innerHeight;
      // Hardware zoom already baked into the stream; only crop for digital scale
      const dig = digitalScaleFromUi(zoomRef.current, zoomCapsRef.current);
      const { sx, sy, cropW, cropH } = cropForCapture(
        video.videoWidth,
        video.videoHeight,
        viewW,
        viewH,
        dig
      );
      canvas.width = cropW;
      canvas.height = cropH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no canvas');
      ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, cropW, cropH);

      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
      if (!blob) throw new Error('encode failed');

      const file = new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
      if (onPhoto) await onPhoto(file);

      const n = capturedRef.current + 1;
      capturedRef.current = n;
      setCaptured(n);
    } catch (e) {
      console.error(e);
      setError('Capture failed. Try again.');
    } finally {
      window.setTimeout(() => setBusy(false), 250);
    }
  }, [busy, mode, ready, fireFlash, onPhoto]);

  const startRecording = React.useCallback(() => {
    if (mode !== 'video' || !streamRef.current || recording || busy) return;
    setError(null);
    recordedChunksRef.current = [];

    let recorder: MediaRecorder;
    try {
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : MediaRecorder.isTypeSupported('video/webm')
          ? 'video/webm'
          : MediaRecorder.isTypeSupported('video/mp4')
            ? 'video/mp4'
            : '';
      recorder = mime
        ? new MediaRecorder(streamRef.current, { mimeType: mime })
        : new MediaRecorder(streamRef.current);
    } catch (e) {
      console.error(e);
      setError('Video recording not supported on this device.');
      return;
    }

    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) recordedChunksRef.current.push(ev.data);
    };
    recorder.onstop = async () => {
      if (recordTimerRef.current) {
        clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      setRecording(false);
      const chunks = recordedChunksRef.current;
      recordedChunksRef.current = [];
      if (!chunks.length) {
        setError('No video recorded.');
        return;
      }
      const type = chunks[0].type || 'video/webm';
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const file = new File(chunks, `video-${Date.now()}.${ext}`, { type });
      fireFlash();
      try {
        if (onVideo) await onVideo(file);
        const n = capturedRef.current + 1;
        capturedRef.current = n;
        setCaptured(n);
      } catch (err) {
        console.error(err);
        setError('Could not save video.');
      }
      setRecordMs(0);
    };

    recorder.start(200);
    setRecording(true);
    setRecordMs(0);
    recordTimerRef.current = setInterval(() => setRecordMs((ms) => ms + 200), 200);
  }, [mode, recording, busy, onVideo, fireFlash]);

  const stopRecording = React.useCallback(() => {
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    } catch {
      // ignore
    }
  }, []);

  const handleShutter = () => {
    if (mode === 'photo') void takePhoto();
    else if (recording) stopRecording();
    else startRecording();
  };

  const handleDone = () => {
    if (recording) stopRecording();
    onClose(capturedRef.current);
  };

  if (!mounted || !open) return null;

  const recordLabel = `${Math.floor(recordMs / 60000)}:${String(Math.floor((recordMs % 60000) / 1000)).padStart(2, '0')}`;
  const scale = Math.max(1, digitalScale);

  const ui = (
    <div
      className="device-camera-shell"
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'photo' ? 'Camera' : 'Video camera'}
    >
      <div
        ref={flashRef}
        className="device-camera-flash-layer"
        style={{ opacity: flashOn ? 1 : 0 }}
        aria-hidden
      />

      <header className="device-camera-top">
        <div className="device-camera-top-info">
          <div className="device-camera-title">
            {mode === 'photo' ? '📸 Camera' : '🎥 Video'}
          </div>
          <div className="device-camera-subtitle">
            {captured > 0
              ? `${captured} saved · keep going or Done`
              : mode === 'photo'
                ? 'Pinch or + / − to zoom · shutter stays put'
                : 'Tap to record · pinch to zoom'}
          </div>
        </div>
        <button type="button" className="device-camera-done" onClick={handleDone}>
          Done
        </button>
      </header>

      <div className="device-camera-frame">
        <div className="device-camera-frame-border">
          <div ref={viewfinderRef} className="device-camera-viewfinder">
            <video
              ref={videoRef}
              className={`device-camera-video ${
                scale <= 1.001 ? 'device-camera-video-wide' : 'device-camera-video-zoom'
              }`}
              style={{
                // Digital scale only when past hardware max; at 1× no CSS zoom crop
                transform: `translate(-50%, -50%) scale(${scale})`,
              }}
              autoPlay
              playsInline
              muted
              controls={false}
              disablePictureInPicture
              onLoadedMetadata={() => setReady(true)}
            />
            <canvas ref={canvasRef} className="hidden" />

            {!ready && !error && (
              <div className="device-camera-loading">Starting camera…</div>
            )}
            {error && (
              <div className="device-camera-loading">
                <p className="mb-3 px-4 text-center text-sm text-amber-200">{error}</p>
                <button type="button" className="device-camera-retry" onClick={() => void startCamera()}>
                  Retry camera
                </button>
              </div>
            )}

            {recording && (
              <div className="device-camera-rec-badge">
                <span className="device-camera-rec-dot" />
                REC {recordLabel}
              </div>
            )}

            <div className="device-camera-zoom-bar">
              <button
                type="button"
                className="device-camera-zoom-btn"
                disabled={zoom <= MIN_ZOOM}
                onClick={() => setZoomLevel(zoom - ZOOM_STEP)}
                aria-label="Zoom out"
              >
                −
              </button>
              <span className="device-camera-zoom-label">{zoom.toFixed(1)}×</span>
              <button
                type="button"
                className="device-camera-zoom-btn"
                disabled={zoom >= MAX_ZOOM}
                onClick={() => setZoomLevel(zoom + ZOOM_STEP)}
                aria-label="Zoom in"
              >
                +
              </button>
            </div>
          </div>
        </div>
      </div>

      <footer className="device-camera-bottom">
        <div className="device-camera-shutter-row">
          <div className="device-camera-side-slot">
            {captured > 0 && (
              <span className="device-camera-count">{captured}</span>
            )}
          </div>

          <button
            type="button"
            className={`device-camera-shutter ${recording ? 'device-camera-shutter-recording' : ''} ${busy ? 'opacity-50' : ''}`}
            onClick={handleShutter}
            disabled={!ready || busy}
            aria-label={mode === 'photo' ? 'Take photo' : recording ? 'Stop recording' : 'Start recording'}
          >
            <span className="device-camera-shutter-inner" />
          </button>

          <div className="device-camera-side-slot">
            <button
              type="button"
              className="device-camera-zoom-reset"
              onClick={() => setZoomLevel(1)}
              disabled={zoom === 1}
              aria-label="Reset zoom to 1×"
            >
              1×
            </button>
          </div>
        </div>
        <p className="device-camera-hint">
          {mode === 'photo'
            ? 'Opens wide · pinch to zoom in · flash = saved'
            : recording
              ? 'Recording… tap the red button to stop and save'
              : 'Opens wide · pinch or + to zoom · shutter stays fixed'}
        </p>
      </footer>
    </div>
  );

  return createPortal(ui, document.body);
}
