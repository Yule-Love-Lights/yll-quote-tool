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
  correctTrainingExample,
  deleteTrainingExample,
  type TrainingExampleInputs,
} from '@/lib/trainingExamples';
import type { ItemCorrection } from '@/lib/design/sceneCorrections';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f-]{36}$/i;

function notConfigured() {
  return NextResponse.json(
    { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
    { status: 503 },
  );
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) return notConfigured();
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const example = await getTrainingExample(id);
  if (!example) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ example });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
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

  // #52 correction fields. finalInputs is sanitized inside correctTrainingExample
  // (asFootage/asDifficulty coerce bad values), so an as-cast at this boundary is
  // safe. itemCorrections: keep only well-typed fields; applyItemCorrections then
  // validates each value against the allowed set for the item's kind.
  const correction: { finalInputs?: TrainingExampleInputs; itemCorrections?: Record<string, ItemCorrection> } = {};
  if (body.finalInputs && typeof body.finalInputs === 'object') {
    correction.finalInputs = body.finalInputs as TrainingExampleInputs;
  }
  if (body.itemCorrections && typeof body.itemCorrections === 'object') {
    const ic: Record<string, ItemCorrection> = {};
    for (const [k, v] of Object.entries(body.itemCorrections as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const src = v as Record<string, unknown>;
      const out: ItemCorrection = {};
      if (typeof src.stringCount === 'number' && Number.isFinite(src.stringCount)) out.stringCount = src.stringCount;
      if (typeof src.quoteSize === 'string') out.quoteSize = src.quoteSize;
      if (typeof src.tier === 'string') out.tier = src.tier;
      if (typeof src.quoteLength === 'string') out.quoteLength = src.quoteLength;
      if (Object.keys(out).length) ic[k] = out;
    }
    if (Object.keys(ic).length) correction.itemCorrections = ic;
  }

  const hasSimple = patch.excluded !== undefined || patch.notes !== undefined;
  const hasCorrection = correction.finalInputs !== undefined || correction.itemCorrections !== undefined;
  if (!hasSimple && !hasCorrection) {
    return NextResponse.json(
      { error: 'Nothing to update (provide excluded/notes and/or finalInputs/itemCorrections)' },
      { status: 400 },
    );
  }

  if (hasSimple) {
    const ok = await updateTrainingExample(id, patch);
    if (!ok) return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }
  if (hasCorrection) {
    const ok = await correctTrainingExample(id, correction);
    if (!ok) return NextResponse.json({ error: 'Correction failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) return notConfigured();
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const ok = await deleteTrainingExample(id);
  if (!ok) return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
