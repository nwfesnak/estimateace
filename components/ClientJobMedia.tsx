'use client';

/* eslint-disable @next/next/no-img-element -- short-lived signed Supabase URLs, not optimizable */
import * as React from 'react';

export type ClientJobMediaData = {
  photos?: Array<{ url: string }>;
  renderings?: Array<{ beforeUrl: string | null; afterUrl: string; label: string }>;
  expiresAt?: string | null;
  /** Per-line photos keyed by the line id from the document's items list. */
  linePhotos?: Record<string, Array<{ url: string }>>;
  /** Line photos repeated in the Site Photos section, captioned by line. */
  siteLinePhotos?: Array<{ caption: string; photos: Array<{ url: string }> }>;
};

type Props = {
  media?: ClientJobMediaData | null;
  /** Called when a signed URL has expired so the page can fetch fresh ones. */
  onExpired?: () => void;
};

/** Customer approve-page gallery: site photos + before/after concept renderings. */
export function ClientJobMedia({ media, onExpired }: Props) {
  const photos = media?.photos || [];
  const renderings = media?.renderings || [];
  const lineGroups = (media?.siteLinePhotos || []).filter((g) => g.photos?.length);
  const linePhotoTotal = lineGroups.reduce((n, g) => n + g.photos.length, 0);
  const [zoom, setZoom] = React.useState<{ url: string; alt: string } | null>(null);
  const expiredRef = React.useRef(false);

  React.useEffect(() => {
    expiredRef.current = false;
  }, [media?.expiresAt]);

  React.useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  if (photos.length === 0 && renderings.length === 0 && linePhotoTotal === 0) return null;

  const handleError = () => {
    if (expiredRef.current) return;
    expiredRef.current = true;
    onExpired?.();
  };

  const thumb = (url: string, alt: string, className?: string) => (
    <button
      type="button"
      onClick={() => setZoom({ url, alt })}
      className={`block w-full overflow-hidden rounded-lg border bg-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 ${className || ''}`}
      aria-label={`View larger: ${alt}`}
    >
      <img
        src={url}
        alt={alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={handleError}
        className="h-full w-full object-cover"
      />
    </button>
  );

  return (
    <div className="space-y-4" data-testid="client-job-media">
      {renderings.length > 0 && (
        <section className="rounded-xl border border-amber-300 bg-amber-50/60 p-3 space-y-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Before / after — concept renderings</p>
            <p className="mt-1 text-xs text-amber-900" data-testid="concept-rendering-disclaimer">
              Concept rendering: an AI illustration of the finished work, not a photo or a guarantee.
              Actual results may vary; the written estimate controls.
            </p>
          </div>
          {renderings.map((r, i) => (
            <figure key={`${r.afterUrl}-${i}`} className="space-y-1">
              {r.label ? <figcaption className="text-xs font-medium text-slate-700">{r.label}</figcaption> : null}
              <div className={`grid gap-2 ${r.beforeUrl ? 'grid-cols-2' : 'grid-cols-1'}`}>
                {r.beforeUrl ? (
                  <div>
                    {thumb(r.beforeUrl, "Before (site photo)", "aspect-[4/3]")}
                    <p className="mt-1 text-center text-[11px] text-slate-600">Before</p>
                  </div>
                ) : null}
                <div>
                  {thumb(r.afterUrl, "After (concept rendering)", "aspect-[4/3]")}
                  <p className="mt-1 text-center text-[11px] font-medium text-amber-900">
                    After (concept rendering)
                  </p>
                </div>
              </div>
            </figure>
          ))}
        </section>
      )}

      {(photos.length > 0 || linePhotoTotal > 0) && (
        <section className="space-y-2">
          <p className="text-sm font-semibold text-slate-900">Site photos ({photos.length + linePhotoTotal})</p>
          {photos.length > 0 && (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {photos.map((p, i) => (
                <React.Fragment key={`${p.url}-${i}`}>{thumb(p.url, `Site photo ${i + 1}`, 'aspect-square')}</React.Fragment>
              ))}
            </div>
          )}
          {lineGroups.map((g, gi) => (
            <div key={`${g.caption}-${gi}`} className="space-y-1" data-testid="client-site-line-photos">
              <p className="text-xs font-medium text-slate-600">{g.caption}</p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {g.photos.map((p, i) => (
                  <React.Fragment key={`${p.url}-${i}`}>{thumb(p.url, `${g.caption} photo ${i + 1}`, 'aspect-square')}</React.Fragment>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {zoom && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={zoom.alt}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 p-3"
          onClick={() => setZoom(null)}
        >
          <img
            src={zoom.url}
            alt={zoom.alt}
            referrerPolicy="no-referrer"
            className="max-h-[85vh] max-w-full rounded-lg object-contain"
          />
          <p className="mt-2 text-center text-xs text-white/90">
            {zoom.alt.includes('concept') ? 'Concept rendering — AI illustration, not a guarantee. ' : ''}
            Tap anywhere to close
          </p>
        </div>
      )}
    </div>
  );
}

/** Customer approve page: up to 5 photos shown under one line's description. */
export function ClientLinePhotoStrip({
  photos,
  lineLabel,
  onExpired,
}: {
  photos?: Array<{ url: string }> | null;
  lineLabel: string;
  onExpired?: () => void;
}) {
  const [zoom, setZoom] = React.useState<string | null>(null);
  const expiredRef = React.useRef(false);
  const list = (photos || []).filter((p) => p?.url).slice(0, 5);
  React.useEffect(() => {
    expiredRef.current = false;
  }, [photos]);
  if (list.length === 0) return null;
  return (
    <>
      <div className="mt-2 flex flex-wrap gap-2" data-testid="client-line-photos">
        {list.map((p, i) => (
          <button
            key={`${p.url}-${i}`}
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setZoom(p.url);
            }}
            className="h-16 w-16 sm:h-20 sm:w-20 overflow-hidden rounded-md border bg-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            aria-label={`View larger: ${lineLabel} photo ${i + 1}`}
          >
            <img
              src={p.url}
              alt={`${lineLabel} photo ${i + 1}`}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => {
                if (expiredRef.current) return;
                expiredRef.current = true;
                onExpired?.();
              }}
              className="h-full w-full object-cover"
            />
          </button>
        ))}
      </div>
      {zoom && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${lineLabel} photo`}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 p-3"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setZoom(null);
          }}
        >
          <img src={zoom} alt={`${lineLabel} photo`} referrerPolicy="no-referrer" className="max-h-[85vh] max-w-full rounded-lg object-contain" />
          <p className="mt-2 text-center text-xs text-white/90">Tap anywhere to close</p>
        </div>
      )}
    </>
  );
}
