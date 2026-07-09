// #141 — permanent-lighting training examples (mirrors /api/training-examples,
// separate table/library).
//
//   POST /api/permanent-training-examples — capture an example for a
//        PERMANENT quote: { quoteId, source: 'auto-send' | 'manual', notes? }
//        Assembled entirely server-side. Upserts per (quote, source) —
//        re-sending or re-saving replaces the prior snapshot.
//   GET  /api/permanent-training-examples — light list for the review page.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  capturePermanentTrainingExample,
  listPermanentTrainingExamples,
  type PermanentTrainingExampleSource,
} from '@/lib/permanent/trainingExamples';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f-]{36}$/i;
const SOURCES = new Set<PermanentTrainingExampleSource>(['auto-send', 'manual']);

function notConfigured() {
  return NextResponse.json(
    { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
    { status: 503 },
  );
}

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
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
  if (typeof source !== 'string' || !SOURCES.has(source as PermanentTrainingExampleSource)) {
    return NextResponse.json({ error: "source must be 'auto-send' or 'manual'" }, { status: 400 });
  }
  const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;

  const result = await capturePermanentTrainingExample({
    quoteId,
    source: source as PermanentTrainingExampleSource,
    notes,
  });
  if ('error' in result) {
    // "Nothing to capture" cases are client-visible info, not server faults.
    return NextResponse.json({ error: result.error }, { status: 422 });
  }
  return NextResponse.json({ ok: true, id: result.id });
}

export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) return notConfigured();
  const items = await listPermanentTrainingExamples();
  return NextResponse.json({ items });
}
