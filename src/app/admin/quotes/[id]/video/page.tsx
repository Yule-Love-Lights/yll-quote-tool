'use client';

// Admin: attach / replace / clear the walkthrough video on a single quote.
//
// Route: /admin/quotes/[id]/video
//
// Two tabs:
//   1. YouTube — paste a URL (or raw 11-char ID). Server extracts the ID.
//      Fastest path for Naldo: upload unlisted on YouTube, paste link, done.
//   2. Direct MP4 — paste a public https:// URL (Supabase Storage, R2, etc.)
//      plus an optional poster image URL. Use when YouTube isn't an option.
//
// We reuse the same `x-admin-secret` session-storage pattern as the parent
// quotes admin page so the admin doesn't have to re-auth per action.

import { useCallback, useEffect, useMemo, useState, use } from 'react';
import Link from 'next/link';

type VideoKind = 'youtube' | 'mp4';

type VideoDTO = {
  kind: VideoKind;
  src: string;
  poster: string | null;
  title: string | null;
  durationSec: number | null;
};

function getAdminSecret(): string | null {
  if (typeof window === 'undefined') return null;
  const cached = window.sessionStorage.getItem('yll:adminSecret');
  if (cached) return cached;
  const entered = window.prompt('Admin secret required:');
  if (!entered) return null;
  window.sessionStorage.setItem('yll:adminSecret', entered);
  return entered;
}

function clearAdminSecret() {
  if (typeof window !== 'undefined') window.sessionStorage.removeItem('yll:adminSecret');
}

// Client-side YouTube ID extraction — purely for preview. The server
// re-validates on save, so a bad paste here just shows a broken preview,
// not a broken save.
function extractYouTubeIdPreview(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})(?:[&#]|$)/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})(?:[?#/]|$)/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})(?:[?#/]|$)/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})(?:[?#/]|$)/,
    /youtube\.com\/live\/([a-zA-Z0-9_-]{11})(?:[?#/]|$)/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

type PageProps = { params: Promise<{ id: string }> };

export default function QuoteVideoAdminPage({ params }: PageProps) {
  const { id: quoteId } = use(params);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [current, setCurrent] = useState<VideoDTO | null>(null);

  const [tab, setTab] = useState<VideoKind>('youtube');
  const [ytInput, setYtInput] = useState('');
  const [mp4Url, setMp4Url] = useState('');
  const [mp4Poster, setMp4Poster] = useState('');
  const [title, setTitle] = useState('');
  const [durationSec, setDurationSec] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/quotes/${quoteId}/video`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Load failed');
      if (data.video) {
        const v = data.video as VideoDTO;
        setCurrent(v);
        setTab(v.kind);
        if (v.kind === 'youtube') {
          setYtInput(v.src);
          setMp4Url('');
          setMp4Poster('');
        } else {
          setMp4Url(v.src);
          setMp4Poster(v.poster ?? '');
          setYtInput('');
        }
        setTitle(v.title ?? '');
        setDurationSec(v.durationSec == null ? '' : String(v.durationSec));
      } else {
        setCurrent(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [quoteId]);

  useEffect(() => {
    // Defer in a microtask so load()'s loading-state update isn't dispatched
    // synchronously within the effect (microtasks flush before paint).
    queueMicrotask(load);
  }, [load]);

  const previewYtId = useMemo(() => extractYouTubeIdPreview(ytInput), [ytInput]);

  const ytPoster = previewYtId ? `https://i.ytimg.com/vi/${previewYtId}/hqdefault.jpg` : null;

  const adminFetch = async (url: string, init: RequestInit): Promise<Response> => {
    const secret = getAdminSecret();
    if (!secret) throw new Error('Admin secret required');
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
        'x-admin-secret': secret,
      },
    });
    if (res.status === 401) clearAdminSecret();
    return res;
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const body: Record<string, unknown> = {
        kind: tab,
        src: tab === 'youtube' ? ytInput.trim() : mp4Url.trim(),
      };
      if (tab === 'mp4' && mp4Poster.trim()) body.poster = mp4Poster.trim();
      if (title.trim()) body.title = title.trim();
      const d = parseInt(durationSec, 10);
      if (Number.isFinite(d) && d > 0) body.durationSec = d;

      const res = await adminFetch(`/api/quotes/${quoteId}/video`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      setCurrent(data.video);
      setSuccess('Saved. The customer portal will now show this video.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!confirm('Remove the walkthrough video from this quote?')) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await adminFetch(`/api/quotes/${quoteId}/video`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Clear failed');
      setCurrent(null);
      setYtInput('');
      setMp4Url('');
      setMp4Poster('');
      setTitle('');
      setDurationSec('');
      setSuccess('Video removed. The walkthrough section will be hidden.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clear failed');
    } finally {
      setBusy(false);
    }
  };

  const canSave =
    !busy && (tab === 'youtube' ? ytInput.trim().length >= 11 : mp4Url.trim().startsWith('https://'));

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex justify-between items-start mb-6 gap-4 flex-wrap">
          <div>
            <p className="text-xs font-semibold text-green-600 uppercase tracking-widest mb-1">
              Yule Love Lights — Admin
            </p>
            <h1 className="text-2xl font-bold text-gray-900">Walkthrough Video</h1>
            <p className="text-sm text-gray-500 mt-1 break-all">
              Quote <span className="font-mono text-gray-700">{quoteId}</span>
            </p>
            <p className="text-sm text-gray-500 mt-2 max-w-xl">
              Attach a personal video explaining the quote. Shown to the customer directly below
              their home photo on the approval page. Supports YouTube (easiest) or direct MP4
              hosting.
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Link
              href="/admin/quotes"
              className="bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm px-4 py-2 rounded-md"
            >
              ← Quotes
            </Link>
            <Link
              href={`/portal-snowglobe/${quoteId}`}
              target="_blank"
              rel="noopener"
              className="bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm px-4 py-2 rounded-md"
            >
              View portal ↗
            </Link>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <>
            {current && (
              <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6">
                <div className="flex items-center justify-between gap-4 mb-3">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest">
                    Currently attached
                  </p>
                  <button
                    type="button"
                    onClick={clear}
                    disabled={busy}
                    className="text-red-600 hover:bg-red-50 disabled:opacity-50 text-xs font-medium px-2 py-1 rounded cursor-pointer"
                  >
                    Remove video
                  </button>
                </div>
                <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-gray-500">Kind</dt>
                  <dd className="text-gray-800 font-medium">{current.kind}</dd>
                  <dt className="text-gray-500">Source</dt>
                  <dd className="text-gray-800 font-mono text-xs break-all">{current.src}</dd>
                  {current.title && (
                    <>
                      <dt className="text-gray-500">Title</dt>
                      <dd className="text-gray-800">{current.title}</dd>
                    </>
                  )}
                  {current.durationSec != null && (
                    <>
                      <dt className="text-gray-500">Duration</dt>
                      <dd className="text-gray-800 tabular-nums">
                        {Math.floor(current.durationSec / 60)}:
                        {(current.durationSec % 60).toString().padStart(2, '0')}
                      </dd>
                    </>
                  )}
                </dl>
              </div>
            )}

            {/* Tab switcher */}
            <div className="flex gap-2 mb-4" role="tablist" aria-label="Video source">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'youtube'}
                onClick={() => setTab('youtube')}
                className={`px-4 py-2 rounded-md text-sm font-medium cursor-pointer transition-colors ${
                  tab === 'youtube'
                    ? 'bg-gray-900 text-white'
                    : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                YouTube
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'mp4'}
                onClick={() => setTab('mp4')}
                className={`px-4 py-2 rounded-md text-sm font-medium cursor-pointer transition-colors ${
                  tab === 'mp4'
                    ? 'bg-gray-900 text-white'
                    : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                Direct MP4
              </button>
            </div>

            <form
              className="bg-white border border-gray-200 rounded-lg p-5 space-y-4"
              onSubmit={e => {
                e.preventDefault();
                if (canSave) save();
              }}
            >
              {tab === 'youtube' ? (
                <>
                  <div>
                    <label
                      htmlFor="yt-url"
                      className="block text-sm font-medium text-gray-800 mb-1.5"
                    >
                      YouTube URL or video ID
                    </label>
                    <input
                      id="yt-url"
                      type="text"
                      value={ytInput}
                      onChange={e => setYtInput(e.target.value)}
                      placeholder="https://www.youtube.com/watch?v=… or dQw4w9WgXcQ"
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p className="text-xs text-gray-500 mt-1.5">
                      Tip: upload the video as <strong>Unlisted</strong> on YouTube, copy the URL,
                      paste it here.
                    </p>
                  </div>

                  {previewYtId && (
                    <div>
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-2">
                        Preview
                      </p>
                      <div className="aspect-video w-full rounded-md overflow-hidden border border-gray-200 bg-black">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={ytPoster!}
                          alt=""
                          aria-hidden
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <p className="text-xs text-gray-500 mt-1.5 font-mono break-all">
                        ID: {previewYtId}
                      </p>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div>
                    <label
                      htmlFor="mp4-url"
                      className="block text-sm font-medium text-gray-800 mb-1.5"
                    >
                      Video URL (https:// .mp4)
                    </label>
                    <input
                      id="mp4-url"
                      type="url"
                      value={mp4Url}
                      onChange={e => setMp4Url(e.target.value)}
                      placeholder="https://cdn.yulelovelights.com/walkthroughs/smith-house.mp4"
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p className="text-xs text-gray-500 mt-1.5">
                      Host the MP4 anywhere with a public HTTPS URL — Supabase Storage, Cloudflare
                      R2, Bunny, S3, etc. Must be <code>https://</code>.
                    </p>
                  </div>
                  <div>
                    <label
                      htmlFor="mp4-poster"
                      className="block text-sm font-medium text-gray-800 mb-1.5"
                    >
                      Poster image URL (optional)
                    </label>
                    <input
                      id="mp4-poster"
                      type="url"
                      value={mp4Poster}
                      onChange={e => setMp4Poster(e.target.value)}
                      placeholder="https://cdn.yulelovelights.com/walkthroughs/smith-house-poster.jpg"
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p className="text-xs text-gray-500 mt-1.5">
                      Shown before the customer clicks play. Leave blank for a plain black poster.
                    </p>
                  </div>
                </>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-gray-100">
                <div>
                  <label
                    htmlFor="v-title"
                    className="block text-sm font-medium text-gray-800 mb-1.5"
                  >
                    Label shown above the player (optional)
                  </label>
                  <input
                    id="v-title"
                    type="text"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="Your personal walkthrough"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                    maxLength={200}
                  />
                </div>
                <div>
                  <label
                    htmlFor="v-dur"
                    className="block text-sm font-medium text-gray-800 mb-1.5"
                  >
                    Duration, seconds (optional)
                  </label>
                  <input
                    id="v-dur"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    value={durationSec}
                    onChange={e => setDurationSec(e.target.value)}
                    placeholder="92"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  />
                </div>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">
                  {error}
                </div>
              )}
              {success && (
                <div className="bg-green-50 border border-green-200 rounded-md p-3 text-sm text-green-700">
                  {success}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="submit"
                  disabled={!canSave}
                  className="bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm px-5 py-2.5 rounded-md cursor-pointer transition-colors"
                >
                  {busy ? 'Saving…' : current ? 'Update video' : 'Attach video'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
