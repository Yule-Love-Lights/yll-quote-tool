// POST /api/designs/[id]/seed-roofline — re-seed an existing design's roofline
// strands from the builder's measurement polylines (#33 "Sync roofline from
// measurement"). Body: { seedLines: { santas?, gingerbread?, winterWonderland?, stakeLighting? } }
// (normalized 0–1 polylines).
//
// Replacement rule: every roofline-TAGGED strand is replaced by the incoming
// lines (the measurement is the source of truth for rooflines — contract §7);
// untagged hand-drawn strands and all other items are untouched. The builder
// closes the embedded editor before calling this so no autosave can race the
// scene write (editor destroy cancels its pending debounced save).

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  getDesign,
  updateDesignSceneGuarded,
  isValidDesignId,
  EMPTY_SCENE,
} from '@/lib/designs';
import { SCENE_LOCKED_CODE, SCENE_LOCKED_MESSAGE } from '@/lib/design/sceneFreeze';
import {
  seedRooflineStrands,
  sanitizeSeedLines,
  seedLinesHaveContent,
  countRooflineStrands,
} from '@/lib/design/seedRoofline';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
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
  const lines = sanitizeSeedLines((body as Record<string, unknown> | null)?.seedLines);
  if (!seedLinesHaveContent(lines)) {
    return NextResponse.json(
      { error: 'No roofline lines to sync — analyze or draw measurement lines first' },
      { status: 400 },
    );
  }

  const row = await getDesign(id);
  if (!row) {
    return NextResponse.json({ error: 'Design not found' }, { status: 404 });
  }
  if (!row.photo_w || !row.photo_h) {
    return NextResponse.json(
      { error: 'Design has no base photo — the lines have nothing to map onto' },
      { status: 400 },
    );
  }

  const scene = seedRooflineStrands(row.scene ?? EMPTY_SCENE, lines, row.photo_w, row.photo_h);
  // Ledger row 260: CAS'd on the version this route just read via getDesign()
  // above. "The builder closes the embedded editor before calling this" (see
  // the file header) was always a soft, client-enforced invariant — this
  // makes it a real guarantee instead of an accepted risk.
  const outcome = await updateDesignSceneGuarded(id, scene, row.version ?? null);
  if (!outcome.ok) {
    if (outcome.reason === 'locked') {
      // Row 367: the linked quote carries a frozen (customer-approved)
      // agreement. Same wire code as PUT /api/designs/[id] so every client
      // branch on ONE value.
      return NextResponse.json(
        { error: SCENE_LOCKED_MESSAGE, code: SCENE_LOCKED_CODE },
        { status: 409 },
      );
    }
    if (outcome.reason === 'unverified') {
      // Row 367: the freeze state could not be READ — retryable, not a lock.
      return NextResponse.json(
        { error: "Could not verify this design's approval state — nothing was saved." },
        { status: 500 },
      );
    }
    if (outcome.reason === 'conflict') {
      return NextResponse.json(
        { error: 'The design changed elsewhere while syncing — reopen it and try again', conflict: true },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'Failed to save the seeded scene' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, rooflineStrands: countRooflineStrands(scene) });
}
