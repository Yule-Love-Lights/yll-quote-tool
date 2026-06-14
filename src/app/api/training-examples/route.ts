// Training examples (#8 Stage A — scene-based capture).
//
//   POST /api/training-examples — capture an example for a quote:
//        { quoteId, source: 'auto-send' | 'manual', notes? }
//        Assembled entirely server-side (quote inputs + the linked design's
//        scene/photos/provenance). Upserts per (quote, source) — re-sending
//        or re-saving replaces the prior snapshot.
//   GET  /api/training-examples — light list for the review page.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  captureTrainingExample,
  listTrainingExamples,
  type TrainingExampleSource,
} from '@/lib/trainingExamples';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f-]{36}$/i;
const SOURCES = new Set<TrainingExampleSource>(['auto-send', 'manual']);

function notConfigured() {
  return NextResponse.json(
    { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
    { status: 503 },
  );
}

export async function POST(req: NextRequest) {
  if (!isSupabaseServiceConfigured()) return notConfigured();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const quoteId = body.quoteId;
  if (typeof quoteId !== 'string' || !UUID_RE.test(quoteId)) {
    return NextResponse.json({ error: 'Invalid quoteId' }, { status: 400 });
  }
  const source = body.source;
  if (typeof source !== 'string' || !SOURCES.has(source as TrainingExampleSource)) {
    return NextResponse.json({ error: "source must be 'auto-send' or 'manual'" }, { status: 400 });
  }
  const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;

  const result = await captureTrainingExample({
    quoteId,
    source: source as TrainingExampleSource,
    notes,
  });
  if ('error' in result) {
    // "Nothing to capture" cases are client-visible info, not server faults.
    return NextResponse.json({ error: result.error }, { status: 422 });
  }
  return NextResponse.json({ ok: true, id: result.id });
}

export async function GET() {
  if (!isSupabaseServiceConfigured()) return notConfigured();
  const items = await listTrainingExamples();
  return NextResponse.json({ items });
}
