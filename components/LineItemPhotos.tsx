'use client';

/* eslint-disable @next/next/no-img-element -- short-lived signed Supabase URLs, not optimizable */
import * as React from 'react';
import { LINE_PHOTO_LIMIT } from '@/lib/line-item-photos';

type EditorProps = {
  /** Stored refs (storage paths) for this line, in display order. */
  photos: string[];
  /** ref → signed display URL (missing while resolving). */
  displayUrls: Record<string, string>;
  lineNumber: number;
  busy?: boolean;
  disabled?: boolean;
  onCamera: () => void;
  onFiles: (files: FileList | null) => void;
  onRemove: (index: number) => void;
  onMove: (index: number, dir: -1 | 1) => void;
};

/** Add / remove / reorder up to 5 photos on one estimate line (editor). */
export function LineItemPhotosEditor({
  photos,
  displayUrls,
  lineNumber,
  busy,
  disabled,
  onCamera,
  onFiles,
  onRemove,
  onMove,
}: EditorProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const full = photos.length >= LINE_PHOTO_LIMIT;
  const blocked = !!disabled || !!busy || full;

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-2 sm:p-3 space-y-2" data-testid="line-item-photos">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Line photos{' '}
          <span className="font-normal normal-case text-gray-400">
            ({photos.length}/{LINE_PHOTO_LIMIT}) · customer sees these with this line
          </span>
        </span>
        {busy ? <span className="text-[11px] text-emerald-700">Uploading…</span> : null}
      </div>

      {photos.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {photos.map((ref, i) => {
            const url = displayUrls[ref] || '';
            return (
              <div key={`${ref}-${i}`} className="relative aspect-square overflow-hidden rounded-md border bg-white">
                {url ? (
                  <img
                    src={url}
                    alt={`Line ${lineNumber} photo ${i + 1}`}
                    className="h-full w-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-[10px] text-gray-400">Loading…</div>
                )}
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  disabled={busy}
                  aria-label={`Remove line ${lineNumber} photo ${i + 1}`}
                  className="absolute top-1 right-1 h-7 w-7 rounded-full bg-red-600 text-white text-lg leading-none shadow flex items-center justify-center hover:bg-red-700"
                >
                  ×
                </button>
                {photos.length > 1 && (
                  <div className="absolute bottom-1 left-1 right-1 flex justify-between">
                    <button
                      type="button"
                      onClick={() => onMove(i, -1)}
                      disabled={busy || i === 0}
                      aria-label={`Move line ${lineNumber} photo ${i + 1} left`}
                      className="h-6 w-6 rounded bg-black/60 text-white text-xs disabled:opacity-0"
                    >
                      ◀
                    </button>
                    <button
                      type="button"
                      onClick={() => onMove(i, 1)}
                      disabled={busy || i === photos.length - 1}
                      aria-label={`Move line ${lineNumber} photo ${i + 1} right`}
                      className="h-6 w-6 rounded bg-black/60 text-white text-xs disabled:opacity-0"
                    >
                      ▶
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {full ? (
        <p className="text-[11px] text-gray-500">This line has the maximum of {LINE_PHOTO_LIMIT} photos. Remove one to add another.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onCamera}
            disabled={blocked}
            className="flex items-center justify-center gap-1.5 rounded-md border border-emerald-300 bg-white px-2 py-2 text-xs font-medium text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
          >
            📸 Take photo
          </button>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={blocked}
            className="flex items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-2 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            🖼️ Add from device
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            data-testid="line-photo-input"
            onChange={(e) => {
              onFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Read-only thumbnails under a line's description on the preview / PDF / print document.
 * Fixed height + natural width (no object-fit) so html2pdf / html2canvas render them correctly.
 */
export function LineItemPhotoThumbs({
  urls,
  lineNumber,
  className,
}: {
  urls: string[];
  lineNumber: number;
  className?: string;
}) {
  const list = urls.filter(Boolean).slice(0, LINE_PHOTO_LIMIT);
  if (list.length === 0) return null;
  return (
    <div className={`mt-2 flex flex-wrap gap-2 ${className || ''}`} data-testid="line-photo-thumbs" style={{ breakInside: 'avoid' }}>
      {list.map((url, i) => (
        <img
          key={`${url}-${i}`}
          src={url}
          alt={`Line ${lineNumber} photo ${i + 1}`}
          referrerPolicy="no-referrer"
          style={{ height: 96, width: 'auto', maxWidth: 144 }}
          className="rounded border border-gray-300"
        />
      ))}
    </div>
  );
}
