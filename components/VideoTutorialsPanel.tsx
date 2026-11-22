'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { openExternalUrl } from '@/lib/native-app';
import { fetchWithSession } from '@/lib/session-auth';
import type { PlatformTutorial } from '@/lib/platform-tutorials';

type VideoTutorialsPanelProps = {
  onMessage?: (msg: string) => void;
};

const emptyDraft = { title: '', description: '', url: '' };

export function VideoTutorialsPanel({ onMessage }: VideoTutorialsPanelProps) {
  const [videos, setVideos] = useState<PlatformTutorial[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState(emptyDraft);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithSession('/api/tutorials', { credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        onMessage?.(json.error || 'Could not load tutorials.');
        return;
      }
      setVideos(Array.isArray(json.videos) ? json.videos : []);
      setCanManage(!!json.canManage);
    } catch {
      onMessage?.('Could not load tutorials.');
    } finally {
      setLoading(false);
    }
  }, [onMessage]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithSession('/api/tutorials', { credentials: 'include' });
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          onMessage?.(json.error || 'Could not load tutorials.');
          return;
        }
        setVideos(Array.isArray(json.videos) ? json.videos : []);
        setCanManage(!!json.canManage);
      } catch {
        if (!cancelled) onMessage?.('Could not load tutorials.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onMessage]);

  const addLink = async () => {
    if (!canManage) return;
    const title = draft.title.trim();
    const url = draft.url.trim();
    if (!title || !url) {
      onMessage?.('Enter a title and a video link.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetchWithSession('/api/tutorials', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: draft.description.trim(),
          url,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        onMessage?.(json.error || 'Could not add the tutorial.');
        return;
      }
      setDraft(emptyDraft);
      onMessage?.('✅ Tutorial link published for all users.');
      await refresh();
    } catch {
      onMessage?.('Could not add the tutorial.');
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!canManage || !editingId) return;
    setSaving(true);
    try {
      const res = await fetchWithSession('/api/tutorials', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingId,
          title: editDraft.title.trim(),
          description: editDraft.description.trim(),
          url: editDraft.url.trim(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        onMessage?.(json.error || 'Could not update the tutorial.');
        return;
      }
      setEditingId(null);
      onMessage?.('✅ Tutorial updated.');
      await refresh();
    } catch {
      onMessage?.('Could not update the tutorial.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (video: PlatformTutorial) => {
    if (!canManage) return;
    if (!confirm(`Remove tutorial “${video.title}”? Users will no longer see it.`)) return;
    setSaving(true);
    try {
      const res = await fetchWithSession('/api/tutorials', {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: video.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        onMessage?.(json.error || 'Could not delete the tutorial.');
        return;
      }
      onMessage?.('Tutorial removed.');
      await refresh();
    } catch {
      onMessage?.('Could not delete the tutorial.');
    } finally {
      setSaving(false);
    }
  };

  const move = async (id: string, direction: -1 | 1) => {
    if (!canManage) return;
    const links = videos.filter((v) => v.kind !== 'file');
    const index = links.findIndex((v) => v.id === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= links.length) return;
    const ordered = [...links];
    const [item] = ordered.splice(index, 1);
    ordered.splice(next, 0, item);
    setSaving(true);
    try {
      const res = await fetchWithSession('/api/tutorials', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: ordered.map((v) => v.id) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        onMessage?.(json.error || 'Could not reorder tutorials.');
        return;
      }
      if (Array.isArray(json.videos)) {
        const files = videos.filter((v) => v.kind === 'file');
        setVideos([...json.videos, ...files]);
      } else {
        await refresh();
      }
    } catch {
      onMessage?.('Could not reorder tutorials.');
    } finally {
      setSaving(false);
    }
  };

  const openTutorial = (video: PlatformTutorial) => {
    const href = video.url;
    if (!href) {
      onMessage?.('This tutorial link is unavailable.');
      return;
    }
    void openExternalUrl(href);
  };

  const linkVideos = videos.filter((v) => v.kind !== 'file' || !v.storagePath || v.url);
  const busy = loading || saving;

  return (
    <Card className="mb-8" data-testid="video-tutorials-panel">
      <CardContent className="p-4 sm:p-8 space-y-6">
        <div className="flex flex-col min-[400px]:flex-row min-[400px]:items-start min-[400px]:justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-xl font-semibold flex items-center gap-2">
              <span aria-hidden="true">🎥</span>
              <span>Video Tutorials</span>
            </h3>
            <p className="text-sm text-gray-500 mt-1">
              Short videos from EstimateAce that explain how to use the app — estimates, invoices,
              payments, and more.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 min-[400px]:w-auto w-full"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>

        {canManage && (
          <div
            className="rounded-xl border-2 border-emerald-300 bg-emerald-50/60 p-4 space-y-3"
            data-testid="video-tutorials-admin"
          >
            <h4 className="font-semibold text-emerald-900">Add a video link (platform admin)</h4>
            <p className="text-xs text-emerald-800">
              Paste a YouTube, Vimeo, or other https link. It appears for every signed-in user,
              including crew. The link opens in a new tab (or the system browser in the iOS app).
            </p>
            <Input
              data-testid="tutorial-title-input"
              className="h-11 text-base bg-white"
              placeholder="Title (e.g. How to send an estimate)"
              value={draft.title}
              disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            />
            <Textarea
              data-testid="tutorial-description-input"
              className="text-base bg-white"
              placeholder="Short description (optional)"
              rows={2}
              value={draft.description}
              disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            />
            <Input
              data-testid="tutorial-url-input"
              className="h-11 text-base bg-white"
              type="url"
              inputMode="url"
              placeholder="https://www.youtube.com/watch?v=…"
              value={draft.url}
              disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
            />
            <Button
              type="button"
              data-testid="tutorial-add-button"
              className="w-full min-h-11 bg-[#10b981] hover:bg-emerald-700 text-white font-bold"
              disabled={busy}
              onClick={() => void addLink()}
            >
              {saving ? 'Saving…' : 'Add tutorial'}
            </Button>
          </div>
        )}

        {!canManage && (
          <p className="text-xs text-gray-500 rounded-lg border bg-slate-50 p-3">
            Tutorials are published by EstimateAce. Check back here for new how-to videos.
          </p>
        )}

        <div className="space-y-4">
          {loading && videos.length === 0 && (
            <p className="text-sm text-gray-500 text-center py-8">Loading tutorials…</p>
          )}
          {!loading && videos.length === 0 && (
            <div
              className="border border-dashed rounded-lg p-8 text-center text-sm text-gray-500 bg-gray-50"
              data-testid="tutorials-empty-state"
            >
              <p className="font-semibold text-slate-700">Tutorials coming soon</p>
              <p className="mt-1">
                {canManage
                  ? 'Add your first video link above to publish it for everyone.'
                  : 'EstimateAce will post how-to videos here.'}
              </p>
            </div>
          )}
          {linkVideos.map((vid, index) => (
            <div
              key={vid.id}
              className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm"
              data-testid={`tutorial-card-${vid.id}`}
            >
              {editingId === vid.id && vid.kind === 'link' ? (
                <div className="p-4 space-y-3">
                  <Input
                    className="h-11 text-base"
                    value={editDraft.title}
                    disabled={busy}
                    onChange={(e) => setEditDraft((d) => ({ ...d, title: e.target.value }))}
                  />
                  <Textarea
                    className="text-base"
                    rows={2}
                    value={editDraft.description}
                    disabled={busy}
                    onChange={(e) => setEditDraft((d) => ({ ...d, description: e.target.value }))}
                  />
                  <Input
                    className="h-11 text-base"
                    type="url"
                    value={editDraft.url}
                    disabled={busy}
                    onChange={(e) => setEditDraft((d) => ({ ...d, url: e.target.value }))}
                  />
                  <div className="flex flex-col min-[400px]:flex-row gap-2">
                    <Button className="min-h-11 flex-1" disabled={busy} onClick={() => void saveEdit()}>
                      Save changes
                    </Button>
                    <Button
                      variant="outline"
                      className="min-h-11"
                      disabled={busy}
                      onClick={() => setEditingId(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => openTutorial(vid)}
                    data-testid={`tutorial-open-${vid.id}`}
                  >
                    {vid.thumbnailUrl ? (
                      // External YouTube/Vimeo thumbs; next/image is not required for this catalog.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={vid.thumbnailUrl}
                        alt=""
                        className="w-full aspect-video object-cover bg-slate-200"
                      />
                    ) : vid.kind === 'file' && vid.url ? (
                      <video
                        controls
                        playsInline
                        preload="metadata"
                        className="w-full max-h-[70vh] bg-black"
                        src={vid.url}
                        onClick={(e) => e.stopPropagation()}
                      >
                        Your browser does not support video playback.
                      </video>
                    ) : null}
                    <div className="p-4">
                      <h4 className="font-semibold text-[#1e293b] break-words">{vid.title}</h4>
                      {vid.description ? (
                        <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap break-words">
                          {vid.description}
                        </p>
                      ) : null}
                      <p className="text-[11px] text-emerald-700 mt-2 font-medium">
                        Open video ↗
                      </p>
                    </div>
                  </button>
                  {canManage && (
                    <div className="flex flex-col min-[400px]:flex-row gap-2 p-3 border-t bg-slate-50">
                      {vid.kind === 'link' && (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11 flex-1"
                            disabled={busy || index === 0}
                            onClick={() => void move(vid.id, -1)}
                          >
                            Move up
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11 flex-1"
                            disabled={busy || index >= videos.filter((v) => v.kind !== 'file').length - 1}
                            onClick={() => void move(vid.id, 1)}
                          >
                            Move down
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11 flex-1"
                            disabled={busy}
                            onClick={() => {
                              setEditingId(vid.id);
                              setEditDraft({
                                title: vid.title,
                                description: vid.description,
                                url: vid.url,
                              });
                            }}
                          >
                            Edit
                          </Button>
                        </>
                      )}
                      <Button
                        type="button"
                        variant="destructive"
                        className="min-h-11 flex-1"
                        disabled={busy}
                        onClick={() => void remove(vid)}
                      >
                        Delete
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
