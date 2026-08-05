import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  getArchiveQueue,
  identifyArchivePhoto,
  excludeArchivePhoto,
  excludeArchiveProperty,
} from '@/lib/archiveQueue';

// #167 P1 slice 3 — the trace queue behind /training/archive.
//
// GET  → the queue: ready-to-trace properties (grouped, with signed thumbnails)
//        plus the needs-identification lane.
// POST → the two things a human can do to a row from the queue without opening
//        the tracer: name an addressless photo, or drop a non-install.
//
// The actual tracing happens in /training/new; this route never writes a
// training house.
export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serviceUnavailable(): NextResponse | null {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'The archive queue requires the Supabase service role — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY' },
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

  return NextResponse.json(await getArchiveQueue());
}

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  const unavailable = serviceUnavailable();
  if (unavailable) return unavailable;

  let body: { action?: unknown; id?: unknown; addressKey?: unknown; address?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Property-grained, so it is keyed by addressKey rather than a photo id and
  // is checked before the UUID guard below (which does not apply to it).
  if (body.action === 'excludeProperty') {
    if (typeof body.addressKey !== 'string' || !body.addressKey.trim()) {
      return NextResponse.json({ error: 'An addressKey is required' }, { status: 400 });
    }
    const res = await excludeArchiveProperty(
      body.addressKey.trim(),
      typeof body.note === 'string' ? body.note : undefined,
    );
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: res.error.includes('already') ? 409 : 500 });
    }
    return NextResponse.json({ ok: true });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'A valid photo id is required' }, { status: 400 });
  }

  if (body.action === 'identify') {
    if (typeof body.address !== 'string' || !body.address.trim()) {
      return NextResponse.json({ error: 'An address is required' }, { status: 400 });
    }
    const res = await identifyArchivePhoto(id, body.address);
    // A row that already had an address is a lost race with another operator,
    // not a server fault — 409 so the page can re-read rather than retry.
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.error.includes('already') ? 409 : 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'exclude') {
    const res = await excludeArchivePhoto(id, typeof body.note === 'string' ? body.note : undefined);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "action must be 'identify' or 'exclude'" }, { status: 400 });
}
