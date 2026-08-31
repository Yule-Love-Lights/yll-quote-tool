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
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getDesign, updateDesignSceneGuarded, isValidDesignId, EMPTY_SCENE } from '@/lib/designs';
import { SCENE_LOCKED_CODE, SCENE_LOCKED_MESSAGE } from '@/lib/design/sceneFreeze';
import {
  seedSceneFromAnalysis,
  sanitizeAnalysisSeed,
  analysisSeedHasContent,
  countSeededItems,
  countSeededGarlandUnestimated,
} from '@/lib/design/seedFromAnalysis';
import { isMiniGroup } from '@/lib/design/sceneTypes';
import type { MiniGroupItem } from '@/lib/design/sceneTypes';

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

  // #255: a staff-created miniGroup (railing/curtain, etc.) is never seed-
  // prefixed, so seedSceneFromAnalysis's own `kept` filter always lets it
  // through — the ONLY way one disappears between the pre-seed scene and the
  // post-seed scene is pruneOrphanedMiniGroups dropping it, either because a
  // re-analyze didn't re-detect its last surviving member (#227) or (#13 x
  // #240, item-1 fix round) because it's a TWIN whose canonical just got
  // dropped by this same re-seed. A plain id diff of the two scenes'
  // miniGroups is therefore an exact (not approximate) report of what THIS
  // call pruned — no need to plumb a new return value out of
  // seedSceneFromAnalysis and touch its 45 existing call sites in
  // seedFromAnalysis.test.ts. Twins are excluded from the "before" pool
  // (item-4a fix round): a twinned group never bills twice, so if a
  // re-analyze drops both the canonical AND its twin, only the canonical
  // half is a real loss — counting the twin too would overstate it as 2
  // groups (double the strings) instead of 1.
  const beforeGroups = (row.scene ?? EMPTY_SCENE).items.filter((it): it is MiniGroupItem => isMiniGroup(it) && !it.linkedToId);
  const scene = seedSceneFromAnalysis(row.scene ?? EMPTY_SCENE, seed, row.photo_w, row.photo_h);
  // Ledger row 260: CAS'd on the version this route just read via getDesign()
  // above. "The builder closes/remounts the editor around this" (see the file
  // header) was always a soft, client-enforced invariant — this makes it a
  // real guarantee instead of an accepted risk.
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
        { error: 'The design changed elsewhere while re-analyzing — reopen it and try again', conflict: true },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'Failed to save the seeded scene' }, { status: 500 });
  }
  const afterGroupIds = new Set(scene.items.filter(isMiniGroup).map((g) => g.id));
  const prunedMiniGroups = beforeGroups
    .filter((g) => !afterGroupIds.has(g.id))
    .map((g) => ({ surface: g.surface ?? null, stringCount: g.stringCount ?? 1 }));
  return NextResponse.json({
    ok: true,
    seeded: countSeededItems(scene),
    // #90: garland runs seeded with no scale → the builder warns staff to set
    // their section counts before quoting (silent fallback to 1 = under-bill).
    garlandSectionsUnestimated: countSeededGarlandUnestimated(seed, scene, row.photo_w, row.photo_h),
    // #255: a re-analyze that orphans a staff billing decision (a miniGroup)
    // gets reported here — the builder warns instead of the total silently
    // dropping a line with no explanation.
    prunedMiniGroups,
  });
}
