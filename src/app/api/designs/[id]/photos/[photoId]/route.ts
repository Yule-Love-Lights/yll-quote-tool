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

  const ok = await removeDesignExtraPhoto(checked.id, checked.photoId);
  if (!ok) return NextResponse.json({ error: 'Photo not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
