// Per-example endpoints (#8 Stage A).
//
//   GET    /api/training-examples/[id] — full example (photos + scene) for the
//                                        review page's detail view.
//   PATCH  /api/training-examples/[id] — { excluded?, notes? } (the "park this
//                                        oddball out of the few-shot" badge).
//   DELETE /api/training-examples/[id]

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  getTrainingExample,
  updateTrainingExample,
  deleteTrainingExample,
} from '@/lib/trainingExamples';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f-]{36}$/i;

function notConfigured() {
  return NextResponse.json(
    { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
    { status: 503 },
  );
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) return notConfigured();
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const example = await getTrainingExample(id);
  if (!example) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ example });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) return notConfigured();
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const patch: { excluded?: boolean; notes?: string | null } = {};
  if (typeof body.excluded === 'boolean') patch.excluded = body.excluded;
  if (body.notes === null || typeof body.notes === 'string') patch.notes = body.notes as string | null;
  if (patch.excluded === undefined && patch.notes === undefined) {
    return NextResponse.json({ error: 'Nothing to update (provide excluded and/or notes)' }, { status: 400 });
  }
  const ok = await updateTrainingExample(id, patch);
  if (!ok) return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) return notConfigured();
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const ok = await deleteTrainingExample(id);
  if (!ok) return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
