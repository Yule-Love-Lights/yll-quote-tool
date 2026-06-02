// Admin: attach / update / clear the walkthrough video on a quote.
//
// A quote can have at most one walkthrough video. It's rendered on the
// customer portal (/portal) right below the hero photo. The columns live
// on the `quotes` table — see
// migrations/2026-04-24-quotes-add-walkthrough-video.sql.
//
// Auth: admin-secret header, same pattern as DELETE /api/quotes/[id].
// Rate limit: low — admin-only, one human, they don't spam save.
//
// PUT /api/quotes/[id]/video
//   body: { kind: 'youtube' | 'mp4', src: string, poster?, title?, durationSec? }
//   For 'youtube' src can be either an 11-char video ID or any YouTube
//   URL — the server extracts the ID. For 'mp4' src must be https://.
//   Returns: { ok: true, video: { kind, src, poster, title, durationSec } }
//
// DELETE /api/quotes/[id]/video
//   Clears all five video_* columns. Returns: { ok: true }.
//
// GET /api/quotes/[id]/video
//   Returns the current video or null. Used by the admin page to preload
//   the form. No auth — these columns are safe to read (they'll be public
//   on the portal anyway once the customer visits).

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Matches:
//   https://www.youtube.com/watch?v=dQw4w9WgXcQ
//   https://youtu.be/dQw4w9WgXcQ
//   https://www.youtube.com/embed/dQw4w9WgXcQ
//   https://www.youtube.com/shorts/dQw4w9WgXcQ
//   https://youtube.com/live/dQw4w9WgXcQ
// Plus bare 11-char IDs.
const YT_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const YT_URL_RES: RegExp[] = [
  /[?&]v=([a-zA-Z0-9_-]{11})(?:[&#]|$)/,
  /youtu\.be\/([a-zA-Z0-9_-]{11})(?:[?#/]|$)/,
  /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})(?:[?#/]|$)/,
  /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})(?:[?#/]|$)/,
  /youtube\.com\/live\/([a-zA-Z0-9_-]{11})(?:[?#/]|$)/,
];

function extractYouTubeId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (YT_ID_RE.test(s)) return s;
  for (const re of YT_URL_RES) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

function checkAdminSecret(req: NextRequest): NextResponse | null {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'ADMIN_SECRET not configured on server' },
      { status: 503 },
    );
  }
  const provided = req.headers.get('x-admin-secret');
  if (!provided || provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

type VideoBody = {
  kind?: unknown;
  src?: unknown;
  poster?: unknown;
  title?: unknown;
  durationSec?: unknown;
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured' },
      { status: 503 },
    );
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }
  const sb = getSupabaseServiceClient()!;
  const { data, error } = await sb
    .from('quotes')
    .select('id, video_kind, video_src, video_poster, video_title, video_duration_sec')
    .eq('id', id)
    .single<{
      id: string;
      video_kind: string | null;
      video_src: string | null;
      video_poster: string | null;
      video_title: string | null;
      video_duration_sec: number | null;
    }>();
  if (error || !data) {
    return NextResponse.json(
      { error: `Quote not found: ${error?.message ?? 'no row'}` },
      { status: 404 },
    );
  }
  if (!data.video_kind || !data.video_src) {
    return NextResponse.json({ video: null });
  }
  return NextResponse.json({
    video: {
      kind: data.video_kind,
      src: data.video_src,
      poster: data.video_poster,
      title: data.video_title,
      durationSec: data.video_duration_sec,
    },
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured' },
      { status: 503 },
    );
  }
  const authFail = checkAdminSecret(req);
  if (authFail) return authFail;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  let body: VideoBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const kind = body.kind;
  if (kind !== 'youtube' && kind !== 'mp4') {
    return NextResponse.json(
      { error: "kind must be 'youtube' or 'mp4'" },
      { status: 400 },
    );
  }
  if (typeof body.src !== 'string' || !body.src.trim()) {
    return NextResponse.json({ error: 'src is required' }, { status: 400 });
  }

  let srcToStore: string;
  if (kind === 'youtube') {
    const ytId = extractYouTubeId(body.src);
    if (!ytId) {
      return NextResponse.json(
        { error: 'Could not extract a YouTube video ID from src' },
        { status: 400 },
      );
    }
    srcToStore = ytId;
  } else {
    const url = body.src.trim();
    // Accept https only — we don't want mixed-content blocked on production.
    if (!/^https:\/\//i.test(url)) {
      return NextResponse.json(
        { error: 'MP4 src must start with https://' },
        { status: 400 },
      );
    }
    // Light sanity check that it looks like a URL.
    try {
      new URL(url);
    } catch {
      return NextResponse.json({ error: 'MP4 src is not a valid URL' }, { status: 400 });
    }
    srcToStore = url;
  }

  const poster =
    typeof body.poster === 'string' && body.poster.trim() ? body.poster.trim().slice(0, 1024) : null;
  const title =
    typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : null;
  const durationSec =
    typeof body.durationSec === 'number' && Number.isFinite(body.durationSec) && body.durationSec >= 0
      ? Math.floor(body.durationSec)
      : null;

  const sb = getSupabaseServiceClient()!;
  const { data, error } = await sb
    .from('quotes')
    .update({
      video_kind: kind,
      video_src: srcToStore,
      video_poster: poster,
      video_title: title,
      video_duration_sec: durationSec,
    })
    .eq('id', id)
    .select('id')
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: `Save failed: ${error?.message ?? 'no row updated'}` },
      { status: error ? 500 : 404 },
    );
  }

  return NextResponse.json({
    ok: true,
    video: {
      kind,
      src: srcToStore,
      poster,
      title,
      durationSec,
    },
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured' },
      { status: 503 },
    );
  }
  const authFail = checkAdminSecret(req);
  if (authFail) return authFail;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  const sb = getSupabaseServiceClient()!;
  const { error } = await sb
    .from('quotes')
    .update({
      video_kind: null,
      video_src: null,
      video_poster: null,
      video_title: null,
      video_duration_sec: null,
    })
    .eq('id', id);

  if (error) {
    return NextResponse.json(
      { error: `Clear failed: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
