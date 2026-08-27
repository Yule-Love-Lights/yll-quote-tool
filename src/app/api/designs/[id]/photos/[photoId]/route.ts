// One photo on a design (#13 multi-image quoting).
//
//   PATCH  /api/designs/[id]/photos/[photoId] — rename. Body: { title }.
//     photoId "base" renames the BASE photo (the "Photo 1" tab); a UUID
//     renames that extra.
//   DELETE /api/designs/[id]/photos/[photoId] — remove an extra photo, its
//     storage object, and every scene item drawn on it. ("base" not allowed —
//     the base photo is replaced via /photo, never deleted here.)

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { removeDesignExtraPhoto, updateDesignExtraPhotoTitle, updateDesignPhotoTitle, isValidDesignId } from '@/lib/designs';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { readSceneLock, SCENE_LOCKED_CODE, SCENE_LOCKED_MESSAGE } from '@/lib/design/sceneFreeze';

export const runtime = 'nodejs';

// #110 W2-023: tightened to the strict dashed-UUID pattern used elsewhere
// (src/lib/portal/loader.ts, src/lib/dashboard/inbox/validate.ts) instead of
// the loose /^(base|[0-9a-f-]{36})$/i fragment, which accepted malformed ids
// like 36 dashes. lib/designs.ts's isValidDesignId is owned by a sibling
// audit-wave agent and not imported here — kept local to this route.
const PHOTO_ID_RE = /^(base|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

type Params = { params: Promise<{ id: string; photoId: string }> };

async function checkParams(params: Params['params']): Promise<{ id: string; photoId: string } | NextResponse> {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
      { status: 503 },
    );
  }
  const { id, photoId } = await params;
  if (!isValidDesignId(id) || !PHOTO_ID_RE.test(photoId)) {
    return NextResponse.json({ error: 'Invalid design or photo id' }, { status: 400 });
  }
  return { id, photoId };
}

// Row 367 — the design's post-approval freeze, PRE-FLIGHT. Deleting a photo is
// a three-step write (storage object, then extra_photos, then the scene prune)
// and only the last of those goes through the shared guarded scene writer. A
// refusal discovered at step three would leave the photo already gone from
// storage and from the tab strip, so the check has to happen before ANY of it
// — a decline must change nothing at all. Rename shares it because photo
// titles are customer-visible on the portal.
async function refuseIfFrozen(designId: string): Promise<NextResponse | null> {
  const lock = await readSceneLock(designId);
  if (!lock.ok) {
    return NextResponse.json(
      { error: "Could not verify this design's approval state — nothing was changed." },
      { status: 500 },
    );
  }
  if (lock.locked) {
    return NextResponse.json({ error: SCENE_LOCKED_MESSAGE, code: SCENE_LOCKED_CODE }, { status: 409 });
  }
  return null;
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const denied = await requireOperator();
  if (denied) return denied;
  const checked = await checkParams(params);
  if (checked instanceof NextResponse) return checked;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const title = typeof body.title === 'string' ? body.title : null;

  const frozen = await refuseIfFrozen(checked.id);
  if (frozen) return frozen;

  const ok = checked.photoId.toLowerCase() === 'base'
    ? await updateDesignPhotoTitle(checked.id, title)
    : await updateDesignExtraPhotoTitle(checked.id, checked.photoId, title);
  if (!ok) return NextResponse.json({ error: 'Photo not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const denied = await requireOperator();
  if (denied) return denied;
  const checked = await checkParams(params);
  if (checked instanceof NextResponse) return checked;
  if (checked.photoId.toLowerCase() === 'base') {
    return NextResponse.json({ error: 'The base photo cannot be deleted' }, { status: 400 });
  }

  const frozen = await refuseIfFrozen(checked.id);
  if (frozen) return frozen;

  const result = await removeDesignExtraPhoto(checked.id, checked.photoId);
  if (!result.ok) return NextResponse.json({ error: 'Photo not found' }, { status: 404 });
  // #741 defect 3: report any mini group this delete's server-side prune just
  // orphaned, so the caller can warn staff (mirrors #255's seed-analysis
  // route, which already reports the same shape for its own prune).
  // Row 371: hand back the version this delete's own scene prune wrote, so a
  // still-mounted editor (an INACTIVE tab was deleted, so it never remounts)
  // can adopt it instead of failing its next save's CAS. Null when the prune
  // wrote nothing.
  // Row 367: `sceneNotPruned` means the photo IS gone but its scene items could
  // not be removed — either the quote was approved mid-request ('locked') or
  // the freeze state could not be read ('unverified'). A 200 is honest, the
  // delete really happened, but the client must TELL staff or the surviving
  // items keep billing invisibly.
  return NextResponse.json({
    ok: true,
    prunedMiniGroups: result.prunedMiniGroups,
    version: result.version,
    ...(result.sceneNotPruned ? { sceneNotPruned: result.sceneNotPruned } : {}),
  });
}
