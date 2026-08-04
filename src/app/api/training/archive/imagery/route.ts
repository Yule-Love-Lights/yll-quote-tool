import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { isGoogleMapsConfigured } from '@/lib/googleMaps';
import {
  fetchArchiveImageryBatch,
  getArchiveImageryStatus,
  MAX_LIMIT,
} from '@/lib/archiveImagery';

// #167 P1 slice 2 — operator-triggered imagery fetch for the archive queue.
//
// WHY A ROUTE AND NOT A SCRIPT: the Google Maps key lives in the deployed
// environment, not in any dev checkout, so the only place this batch can
// actually run is inside the app. The operator clicks; the route works a slice
// of the queue and reports what is left.
//
// GET  → queue counters (safe to poll, no spend).
// POST → work up to `limit` properties, then return. Resumable by design: it
//        stops on an internal wall-clock deadline inside maxDuration and never
//        re-claims a property whose imagery already landed, so clicking again
//        picks up exactly where it stopped.
export const runtime = 'nodejs';
export const maxDuration = 60;

function serviceUnavailable(): NextResponse | null {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Archive imagery requires the Supabase service role — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY' },
      { status: 503 },
    );
  }
  return null;
}

export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;
  const unavailable = serviceUnavailable();
  if (unavailable) return unavailable;

  const status = await getArchiveImageryStatus();
  return NextResponse.json({ ...status, googleMapsConfigured: isGoogleMapsConfigured() });
}

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  const unavailable = serviceUnavailable();
  if (unavailable) return unavailable;

  if (!isGoogleMapsConfigured()) {
    return NextResponse.json(
      { error: 'Archive imagery requires GOOGLE_MAPS_API_KEY' },
      { status: 503 },
    );
  }

  // An empty body is the common case (the operator just clicks "fetch next"),
  // so a missing/blank body is defaults, not a 400.
  let body: { limit?: unknown; retryFailed?: unknown } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  let limit: number | undefined;
  if (body.limit !== undefined) {
    if (typeof body.limit !== 'number' || !Number.isFinite(body.limit) || body.limit < 1) {
      return NextResponse.json({ error: `limit must be a number between 1 and ${MAX_LIMIT}` }, { status: 400 });
    }
    limit = body.limit;
  }

  const run = await fetchArchiveImageryBatch({
    limit,
    retryFailed: body.retryFailed === true,
  });
  return NextResponse.json(run);
}
