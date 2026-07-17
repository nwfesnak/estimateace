'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

export type DeviceCameraMode = 'photo' | 'video';

type DeviceCameraProps = {
  open: boolean;
  mode?: DeviceCameraMode;
  onClose: (capturedCount: number) => void;
  onPhoto?: (file: File) => void | Promise<void>;
  onVideo?: (file: File) => void | Promise<void>;
};

function clampZoom(z: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
}

/** Center crop matching object-fit:cover + digital zoom (FILL_CENTER). */
function aspectFillCrop(
  videoW: number,
  videoH: number,
  viewW: number,
  viewH: number,
  zoom: number
) {
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
  const z = Math.max(1, zoom);
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
 * Device-style camera UI:
 * - Stationary outer shell + frame border (never scales)
 * - Capture / Done controls attached to that shell (never zoom away)
 * - Only the live preview inside the frame digitally zooms
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
  const flashRef = React.useRef<HTMLDivElement>(null);
  const zoomRef = React.useRef(1);
  const capturedRef = React.useRef(0);
  const viewportMetaPrev = React.useRef<string | null>(null);
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const recordedChunksRef = React.useRef<Blob[]>([]);
  const recordTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

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
    if (videoRef.current) videoRef.current.srcObject = null;
    setRecording(false);
    setRecordMs(0);
  }, []);

  const setZoomLevel = React.useCallback((value: number) => {
    const next = clampZoom(value);
    zoomRef.current = next;
    setZoom(next);
  }, []);

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

    const portrait =
      typeof window !== 'undefined' && window.matchMedia('(orientation: portrait)').matches;

    const attempts: MediaStreamConstraints[] = [
      {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: portrait ? 1080 : 1920 },
          height: { ideal: portrait ? 1920 : 1080 },
        },
        audio: mode === 'video',
      },
      { video: { facingMode: { ideal: 'environment' } }, audio: mode === 'video' },
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
        setReady(true);
      } catch (e) {
        console.warn(e);
        setError('Could not start preview. Tap retry.');
      }
    };
    await attach();
  }, [mode, stopStream]);

  // Open / close: lock page zoom so only the preview inside the frame can scale
  React.useEffect(() => {
    if (!open) {
      stopStream();
      setReady(false);
      setError(null);
      setZoomLevel(1);
      setCaptured(0);
      capturedRef.current = 0;
      setBusy(false);
      setFlashOn(false);
      return;
    }

    document.documentElement.classList.add('device-camera-lock');
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta) {
      viewportMetaPrev.current = meta.getAttribute('content');
      meta.setAttribute(
        'content',
        'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover'
      );
    }

    // Block browser pinch-zoom entirely (capture button must never leave the screen)
    const blockMultiTouch = (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    };
    const blockGesture = (e: Event) => e.preventDefault();
    const blockWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    const opts: AddEventListenerOptions = { passive: false, capture: true };
    document.addEventListener('touchmove', blockMultiTouch, opts);
    document.addEventListener('touchstart', blockMultiTouch, opts);
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
      document.removeEventListener('touchmove', blockMultiTouch, opts);
      document.removeEventListener('touchstart', blockMultiTouch, opts);
      document.removeEventListener('gesturestart', blockGesture, opts);
      document.removeEventListener('gesturechange', blockGesture, opts);
      document.removeEventListener('wheel', blockWheel, opts);
    };
  }, [open, startCamera, stopStream, setZoomLevel]);

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
      const { sx, sy, cropW, cropH } = aspectFillCrop(
        video.videoWidth,
        video.videoHeight,
        viewW,
        viewH,
        zoomRef.current
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

  const ui = (
    <div
      className="device-camera-shell"
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'photo' ? 'Camera' : 'Video camera'}
    >
      {/* Full-screen flash — does not move with zoom */}
      <div
        ref={flashRef}
        className="device-camera-flash-layer"
        style={{ opacity: flashOn ? 1 : 0 }}
        aria-hidden
      />

      {/* ===== STATIONARY CHROME (never transformed / never zooms) ===== */}
      <header className="device-camera-top">
        <div className="device-camera-top-info">
          <div className="device-camera-title">
            {mode === 'photo' ? '📸 Camera' : '🎥 Video'}
          </div>
          <div className="device-camera-subtitle">
            {captured > 0
              ? `${captured} saved · keep going or Done`
              : mode === 'photo'
                ? 'Zoom the shot only · shutter stays put'
                : 'Tap to record · tap again to stop'}
          </div>
        </div>
        <button type="button" className="device-camera-done" onClick={handleDone}>
          Done
        </button>
      </header>

      {/* Frame border is stationary; only the video inside scales */}
      <div className="device-camera-frame">
        <div className="device-camera-frame-border">
          <div ref={viewfinderRef} className="device-camera-viewfinder">
            <video
              ref={videoRef}
              className="device-camera-video"
              style={{
                // ONLY the live feed zooms — not the border, not the shutter
                transform: `translate(-50%, -50%) scale(${zoom})`,
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

            {/* Zoom controls sit on the frame, not on the scaled video */}
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

      {/* Capture control bar — attached to shell, never zooms with the shot */}
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
            >
              1×
            </button>
          </div>
        </div>
        <p className="device-camera-hint">
          {mode === 'photo'
            ? 'White flash = saved · border & shutter stay fixed while you zoom'
            : recording
              ? 'Recording… tap the red button to stop and save'
              : 'Border & shutter stay fixed · only the preview zooms'}
        </p>
      </footer>
    </div>
  );

  return createPortal(ui, document.body);
}
