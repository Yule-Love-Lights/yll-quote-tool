// POST /api/designs/[id]/seed-analysis — the bridge auto-design (#35 Phase 2):
// push a full AI analysis payload (roofline polylines + per-unit detections,
// normalized 0–1) into an EXISTING design as scene items. Used on re-analyze,
// when the design already carries the analyzed photo.
//
// Body: { seed: { lines?: {santas?,gingerbread?,winterWonderland?,stakeLighting?},
//                 detections?: {miniLights?,wreaths?,spritzers?,garland?} } }
//
// Replacement rules (seedSceneFromAnalysis): roofline-TAGGED strands swap by
// tag (#33 — the measurement owns the roofline); per-unit items swap by the
// `seed-` id prefix — staff-drawn items are never touched; empty halves no-op.
// The builder closes/remounts the editor around this so no autosave races.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { getDesign, updateDesignScene, isValidDesignId, EMPTY_SCENE } from '@/lib/designs';
import {
  seedSceneFromAnalysis,
  sanitizeAnalysisSeed,
  analysisSeedHasContent,
  countSeededItems,
} from '@/lib/design/seedFromAnalysis';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
      { status: 503 },
    );
  }
  const { id } = await params;
  if (!isValidDesignId(id)) {
    return NextResponse.json({ error: 'Invalid design id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const seed = sanitizeAnalysisSeed((body as Record<string, unknown> | null)?.seed);
  if (!analysisSeedHasContent(seed)) {
    return NextResponse.json(
      { error: 'Nothing to seed — the analysis carried no roofline lines or detections' },
      { status: 400 },
    );
  }

  const row = await getDesign(id);
  if (!row) {
    return NextResponse.json({ error: 'Design not found' }, { status: 404 });
  }
  if (!row.photo_w || !row.photo_h) {
    return NextResponse.json(
      { error: 'Design has no base photo — the analysis has nothing to map onto' },
      { status: 400 },
    );
  }

  const scene = seedSceneFromAnalysis(row.scene ?? EMPTY_SCENE, seed, row.photo_w, row.photo_h);
  const ok = await updateDesignScene(id, scene);
  if (!ok) {
    return NextResponse.json({ error: 'Failed to save the seeded scene' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, seeded: countSeededItems(scene) });
}
