'use client';

/**
 * 📸 Photo estimate: 1-5 job photos (+ note, + optional room measurements from a LiDAR
 * scan or typed in) → itemized lines with materials + labor and optional upsells.
 * Everything is editable here; nothing touches the estimate until "Add to estimate".
 */
import * as React from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  applyLineEdit,
  photoEstimateErrorMessage,
  PHOTO_ESTIMATE_LIMITS,
  TRADE_PRICING_DEFAULTS,
  toEstimateItem,
  type PricedLine,
  type RoomMeasurements,
} from '@/lib/photo-estimate';
import { compressPhotoForUpload, looksLikeImageFile, perPhotoBudget } from '@/lib/photo-compress';
import { isRoomScanAvailable, manualMeasurements, scanRoom, scanToMeasurements } from '@/lib/room-scan';

type Location = { address?: string; city?: string; state?: string; zipCode?: string };

type Props = {
  open: boolean;
  onClose: () => void;
  getAccessToken: () => Promise<string | null>;
  tradeId?: string;
  jobLocation?: Location;
  companyLocation?: Location;
  priceMemory?: unknown;
  /** Rows in the estimate's item format (see toEstimateItem). */
  onApply: (items: ReturnType<typeof toEstimateItem>[], summary: string) => void;
};

type Result = {
  scopeSummary: string;
  trade: string;
  confidence: string;
  lines: PricedLine[];
  upsells: PricedLine[];
  assumptions: string[];
  questions: string[];
  laborRate: number;
  markupPercent: number;
};

const money = (n: number) => `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MARKUP_KEY = 'ea.photoEstimate.markupPercent';

const STAGES = ['Uploading photos…', 'AI is reading the photos…', 'Writing line items…', 'Pricing materials and labor…', 'Almost done…'];
/** Client gives up a little after the server's own AI timeout. */
const CLIENT_TIMEOUT_MS = 170_000;

/**
 * Height of the visible area (shrinks when the iOS keyboard opens) so the sheet and its
 * Build button always stay on screen. Falls back to 100dvh via CSS when unsupported.
 */
function useVisibleViewport(active: boolean) {
  const [vp, setVp] = React.useState<{ height: number; top: number } | null>(null);
  React.useEffect(() => {
    if (!active || typeof window === 'undefined' || !window.visualViewport) return;
    const vv = window.visualViewport;
    const update = () => setVp({ height: Math.round(vv.height), top: Math.round(vv.offsetTop) });
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [active]);
  return vp;
}

export function PhotoEstimateModal(props: Props) {
  const { open, onClose } = props;
  const [photos, setPhotos] = React.useState<string[]>([]);
  const [note, setNote] = React.useState('');
  const [tradeId, setTradeId] = React.useState(props.tradeId || '');
  const [markup, setMarkup] = React.useState(() => {
    if (typeof window === 'undefined') return '';
    try {
      return window.localStorage.getItem(MARKUP_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [busy, setBusy] = React.useState(false);
  const [stage, setStage] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<Result | null>(null);
  const [lines, setLines] = React.useState<PricedLine[]>([]);
  const [keep, setKeep] = React.useState<boolean[]>([]);
  const [upsellPick, setUpsellPick] = React.useState<Record<number, 'off' | 'line' | 'optional'>>({});
  const [measure, setMeasure] = React.useState<RoomMeasurements | null>(null);
  const [manual, setManual] = React.useState({ lengthFt: '', widthFt: '', ceilingFt: '8', doors: '', windows: '' });
  const [lidar, setLidar] = React.useState(false);
  const [scanning, setScanning] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const viewport = useVisibleViewport(open);

  // Lock the page behind the sheet (iOS otherwise scrolls the page instead of the sheet).
  React.useEffect(() => {
    if (!open) return;
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => {
      html.style.overflow = prev;
    };
  }, [open]);

  // Show errors where the user is looking (the footer), and scroll results to the top.
  React.useEffect(() => {
    if (result) scrollRef.current?.scrollTo({ top: 0 });
  }, [result]);

  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    void isRoomScanAvailable().then((ok) => alive && setLidar(ok));
    return () => {
      alive = false;
    };
  }, [open]);

  if (!open) return null;

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    const room = PHOTO_ESTIMATE_LIMITS.maxPhotos - photos.length;
    const all = Array.from(files);
    const picked = all.filter(looksLikeImageFile).slice(0, Math.max(0, room));
    if (!picked.length) {
      setError(room <= 0 ? `Up to ${PHOTO_ESTIMATE_LIMITS.maxPhotos} photos.` : 'Pick a photo (JPEG, PNG, HEIC).');
      return;
    }
    setAdding(true);
    const added: string[] = [];
    let failed = '';
    try {
      // One at a time: decoding several 12 MP photos at once can crash the iOS web view.
      for (const f of picked) {
        try {
          added.push(await compressPhotoForUpload(f, perPhotoBudget(PHOTO_ESTIMATE_LIMITS.maxPhotos)));
        } catch (e) {
          failed = e instanceof Error ? e.message : 'Could not read that photo.';
        }
      }
      setPhotos((p) => [...p, ...added].slice(0, PHOTO_ESTIMATE_LIMITS.maxPhotos));
      if (failed) setError(failed);
      else if (all.length > picked.length) setError(`Only the first ${PHOTO_ESTIMATE_LIMITS.maxPhotos} photos were added.`);
    } finally {
      setAdding(false);
    }
  };

  const runScan = async () => {
    setScanning(true);
    setError(null);
    try {
      setMeasure(scanToMeasurements(await scanRoom()));
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code !== 'CANCELED') setError(e instanceof Error ? e.message : 'Room scan failed.');
    } finally {
      setScanning(false);
    }
  };

  const useManual = () => {
    const m = manualMeasurements({
      lengthFt: Number(manual.lengthFt),
      widthFt: Number(manual.widthFt),
      ceilingFt: Number(manual.ceilingFt),
      doors: Number(manual.doors),
      windows: Number(manual.windows),
    });
    if (!m) {
      setError('Enter the room length and width in feet.');
      return;
    }
    setError(null);
    setMeasure(m);
  };

  const generate = async () => {
    if (!photos.length || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setStage(0);
    setElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(() => {
      const sec = Math.round((Date.now() - started) / 1000);
      setElapsed(sec);
      setStage(sec < 4 ? 0 : sec < 25 ? 1 : sec < 45 ? 2 : sec < 70 ? 3 : 4);
    }, 1000);
    const ctrl = new AbortController();
    const kill = window.setTimeout(() => ctrl.abort(), CLIENT_TIMEOUT_MS);
    try {
      const token = await props.getAccessToken();
      if (!token) throw new Error('Please log in again.');
      try {
        window.localStorage.setItem(MARKUP_KEY, markup);
      } catch {
        /* ignore */
      }
      const res = await fetch('/api/photo-estimate', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          photos,
          note,
          tradeId,
          markupPercent: markup === '' ? null : Number(markup),
          measurements: measure,
          jobLocation: props.jobLocation,
          companyLocation: props.companyLocation,
          priceMemory: props.priceMemory,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(photoEstimateErrorMessage(res.status, json?.error));
      if (!Array.isArray(json.lines) || json.lines.length === 0) {
        throw new Error('No line items came back. Add a short note about the job and try again.');
      }
      setResult(json as Result);
      setLines(json.lines);
      setKeep(json.lines.map(() => true));
      setUpsellPick({});
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      setError(
        aborted
          ? 'The AI took too long. Try again with fewer photos.'
          : e instanceof TypeError
            ? 'Network problem — check your connection and try again.'
            : e instanceof Error
              ? e.message
              : 'Photo estimate failed.'
      );
    } finally {
      window.clearInterval(timer);
      window.clearTimeout(kill);
      setBusy(false);
      setStage(0);
    }
  };

  const edit = (i: number, patch: Parameters<typeof applyLineEdit>[1]) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? applyLineEdit(l, patch) : l)));

  const apply = () => {
    if (!result) return;
    const base = Date.now();
    const rows = [
      ...lines.filter((_, i) => keep[i]).map((l, i) => toEstimateItem(l, { id: base + i })),
      ...result.upsells
        .map((u, i) => ({ u, pick: upsellPick[i] || 'off' }))
        .filter((x) => x.pick !== 'off')
        .map((x, i) => toEstimateItem(x.u, { id: base + 100 + i, optional: x.pick === 'optional' })),
    ];
    if (!rows.length) {
      setError('Select at least one line to add.');
      return;
    }
    props.onApply(rows, result.scopeSummary);
    setPhotos([]);
    setNote('');
    setResult(null);
    setMeasure(null);
    onClose();
  };

  const subtotal = lines.reduce((s, l, i) => s + (keep[i] ? l.total : 0), 0);
  const upsellTotal = (result?.upsells || []).reduce((s, u, i) => s + (upsellPick[i] === 'line' ? u.total : 0), 0);

  const errorBox = error ? (
    <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
      {error}
    </p>
  ) : null;

  const sheet = (
    <div
      className="photo-estimate-overlay fixed inset-x-0 top-0 z-[80] flex h-[100dvh] items-end justify-center bg-black/50 sm:items-center sm:p-4"
      style={viewport ? { height: viewport.height, top: viewport.top } : undefined}
      role="dialog"
      aria-modal="true"
      aria-label="Photo estimate"
      data-testid="photo-estimate-modal"
    >
      <div
        className="flex w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:max-w-3xl sm:rounded-2xl"
        style={{ maxHeight: 'calc(100% - max(env(safe-area-inset-top, 0px), 12px))' }}
      >
        <div className="flex shrink-0 items-center justify-between border-b bg-white px-4 py-3 sm:px-5">
          <h2 className="text-lg font-semibold">📸 Photo estimate</h2>
          <button type="button" onClick={onClose} className="-mr-2 px-3 py-1 text-2xl leading-none text-gray-500" aria-label="Close">×</button>
        </div>

        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          style={{ WebkitOverflowScrolling: 'touch' }}
          data-nested-scroll
          data-testid="photo-estimate-scroll"
        >
        <div className="p-4 sm:p-5 space-y-5">
          {!result && (
            <>
              <div>
                <p className="text-sm text-gray-600 mb-2">
                  Add 1–{PHOTO_ESTIMATE_LIMITS.maxPhotos} photos of the job. AI writes the line items with materials and labor; you review everything before it&apos;s added.
                </p>
                <div className="flex flex-wrap gap-2">
                  {photos.map((p, i) => (
                    <div key={i} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p} alt={`Job photo ${i + 1}`} className="h-20 w-20 object-cover rounded-lg border" />
                      <button
                        type="button"
                        className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-gray-800 text-white text-xs"
                        onClick={() => setPhotos((prev) => prev.filter((_, idx) => idx !== i))}
                        aria-label="Remove photo"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {photos.length < PHOTO_ESTIMATE_LIMITS.maxPhotos && (
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      disabled={adding || busy}
                      className="h-20 w-20 rounded-lg border-2 border-dashed border-emerald-400 text-emerald-700 text-xs font-semibold"
                    >
                      {adding ? 'Adding…' : '+ Photo'}
                    </button>
                  )}
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    void addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <label className="text-sm sm:col-span-2">
                  <span className="font-medium">Note (optional)</span>
                  <Input value={note} maxLength={PHOTO_ESTIMATE_LIMITS.maxNoteChars} onChange={(e) => setNote(e.target.value)} placeholder="e.g. repaint walls and ceiling, replace baseboards" />
                </label>
                <label className="text-sm">
                  <span className="font-medium">Trade</span>
                  <select value={tradeId} onChange={(e) => setTradeId(e.target.value)} className="flex h-10 w-full rounded-md border border-input bg-white px-3 text-sm">
                    <option value="">Auto-detect</option>
                    {Object.entries(TRADE_PRICING_DEFAULTS).map(([id, t]) => (
                      <option key={id} value={id}>{t.label}</option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="font-medium">Material markup %</span>
                  <Input inputMode="decimal" value={markup} onChange={(e) => setMarkup(e.target.value.replace(/[^\d.]/g, ''))} placeholder="trade default" />
                </label>
              </div>

              <div className="rounded-xl border bg-slate-50 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">Room measurements (optional)</span>
                  {lidar && (
                    <Button type="button" size="sm" onClick={() => void runScan()} disabled={scanning} className="bg-slate-900 text-white">
                      {scanning ? 'Scanning…' : '📐 Scan room (LiDAR)'}
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-5">
                  {(
                    [
                      ['lengthFt', 'Length ft'],
                      ['widthFt', 'Width ft'],
                      ['ceilingFt', 'Ceiling ft'],
                      ['doors', 'Doors'],
                      ['windows', 'Windows'],
                    ] as const
                  ).map(([k, label]) => (
                    <label key={k}>
                      {label}
                      <Input inputMode="decimal" value={manual[k]} onChange={(e) => setManual((m) => ({ ...m, [k]: e.target.value.replace(/[^\d.]/g, '') }))} />
                    </label>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={useManual}>Use these measurements</Button>
                  {measure && (
                    <span className="text-xs text-emerald-800">
                      {measure.source === 'lidar' ? 'LiDAR: ' : ''}
                      {measure.floorSqft ? `${measure.floorSqft} sf floor` : ''}
                      {measure.wallSqft ? ` · ${measure.wallSqft} sf walls` : ''}
                      {measure.perimeterLf ? ` · ${measure.perimeterLf} LF` : ''}
                      {measure.ceilingFt ? ` · ${measure.ceilingFt}′ ceiling` : ''}
                    </span>
                  )}
                </div>
              </div>

            </>
          )}

          {result && (
            <>
              <div className="rounded-xl bg-slate-50 border p-3 text-sm">
                <p className="font-medium">{result.scopeSummary || 'Estimate from photos'}</p>
                <p className="text-xs text-slate-600 mt-1">
                  {result.trade} · labor {money(result.laborRate)}/hr · materials +{result.markupPercent}% · confidence {result.confidence}
                </p>
              </div>

              <div className="space-y-3">
                {lines.map((l, i) => (
                  <div key={i} className={`rounded-xl border p-3 ${keep[i] ? '' : 'opacity-50'}`}>
                    <div className="flex items-start gap-2">
                      <input type="checkbox" className="mt-2 h-4 w-4" checked={!!keep[i]} onChange={(e) => setKeep((k) => k.map((v, idx) => (idx === i ? e.target.checked : v)))} aria-label="Include line" />
                      <div className="flex-1 space-y-2">
                        <Input value={l.description} onChange={(e) => edit(i, { description: e.target.value })} />
                        <div className="grid grid-cols-4 gap-2 text-xs">
                          <label>Qty<Input inputMode="decimal" defaultValue={String(l.qty)} onBlur={(e) => edit(i, { qty: Number(e.target.value) })} /></label>
                          <label>Unit<Input value={l.unit} onChange={(e) => edit(i, { unit: e.target.value })} /></label>
                          <label>Unit price<Input inputMode="decimal" defaultValue={String(l.unitPrice)} onBlur={(e) => edit(i, { unitPrice: Number(e.target.value) })} /></label>
                          <div className="flex flex-col justify-end text-right font-semibold text-sm">{money(l.total)}</div>
                        </div>
                        <details className="text-xs text-slate-600">
                          <summary className="cursor-pointer">Materials + labor</summary>
                          <ul className="mt-1 space-y-0.5">
                            {l.materialsList.map((m, j) => (
                              <li key={j}>{m.description} — {m.qty} {m.unit} × {money(m.unitPrice)} = {money(m.total)}</li>
                            ))}
                            {l.laborBreakdown && (
                              <li>Labor — {l.laborBreakdown.hours} hr × {money(l.laborBreakdown.rate)} = {money(l.laborBreakdown.total)}</li>
                            )}
                          </ul>
                        </details>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {result.upsells.length > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2">
                  <p className="text-sm font-semibold">💡 Suggested add-ons</p>
                  {result.upsells.map((u, i) => (
                    <div key={i} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <div className="min-w-0">
                        <span className="font-medium">{u.description}</span> — {money(u.total)}
                        {u.reason && <span className="block text-xs text-slate-600">{u.reason}</span>}
                      </div>
                      <div className="flex gap-1">
                        {(['off', 'optional', 'line'] as const).map((p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setUpsellPick((s) => ({ ...s, [i]: p }))}
                            className={`rounded-full px-2.5 py-1 text-xs border ${(upsellPick[i] || 'off') === p ? 'bg-slate-900 text-white border-slate-900' : 'bg-white'}`}
                          >
                            {p === 'off' ? 'Skip' : p === 'optional' ? 'Customer option' : 'Add'}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  <p className="text-[11px] text-slate-600">&quot;Customer option&quot; adds an optional line your customer can choose to add.</p>
                </div>
              )}

              {(result.assumptions.length > 0 || result.questions.length > 0) && (
                <div className="text-xs text-slate-600 space-y-1">
                  {result.assumptions.map((a, i) => <p key={`a${i}`}>• {a}</p>)}
                  {result.questions.map((q, i) => <p key={`q${i}`}>❓ {q}</p>)}
                </div>
              )}

            </>
          )}

        </div>
        </div>

        {/* Always-visible footer: progress, errors and the main action never scroll away. */}
        <div
          className="shrink-0 space-y-2 border-t bg-white px-4 pt-3 sm:px-5"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))' }}
          data-testid="photo-estimate-footer"
        >
          {errorBox}
          {!result ? (
            <>
              {busy && (
                <div aria-live="polite">
                  <div className="h-2 w-full rounded-full bg-slate-200">
                    <div className="h-2 rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.round(((stage + 1) / STAGES.length) * 100)}%` }} />
                  </div>
                  <p className="mt-1 text-sm text-slate-600">
                    {STAGES[stage]} <span className="text-slate-400">{elapsed}s · usually 20–60s</span>
                  </p>
                </div>
              )}
              <Button
                type="button"
                onClick={() => void generate()}
                disabled={!photos.length || busy || adding}
                className="w-full bg-emerald-600 py-6 text-base font-semibold text-white hover:bg-emerald-700"
              >
                {busy
                  ? 'Building estimate…'
                  : adding
                    ? 'Adding photos…'
                    : photos.length
                      ? `Build estimate from ${photos.length} photo${photos.length === 1 ? '' : 's'}`
                      : 'Add a photo to start'}
              </Button>
              <p className="text-center text-[11px] text-slate-500">Uses {photos.length || 1} of your daily AI requests.</p>
            </>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm">
                Adds <strong>{money(subtotal + upsellTotal)}</strong>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setResult(null)}>Back</Button>
                <Button type="button" onClick={apply} className="bg-emerald-600 text-white hover:bg-emerald-700">Add to estimate</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // Portal to <body>: outside the app's own scroll container, so iOS scrolls the sheet.
  return typeof document === 'undefined' ? sheet : createPortal(sheet, document.body);
}
