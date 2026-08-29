import { NextResponse, type NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { getAdvertisingWorkerByAuthUserId } from '@/lib/advertising/workers';
import { updatePlacementNote } from '@/lib/advertising/placements';

export const runtime = 'nodejs';

const NOTE_MAX = 500;

/**
 * PATCH /api/admin/advertising/placements/[id]/note — the note field on the
 * ADMIN camera's queue. Same ownership rule as the worker route: the write
 * only lands on a placement belonging to the admin's own auto-provisioned
 * worker row, so an admin cannot rewrite a worker's note through this door.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const worker = await getAdvertisingWorkerByAuthUserId(auth.operator.id);
  if (!worker) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { note?: unknown } | null;
  const raw = body?.note;
  if (raw !== null && raw !== undefined && typeof raw !== 'string') {
    return NextResponse.json({ error: 'Send note as text (or null to clear).' }, { status: 400 });
  }
  const note = typeof raw === 'string' ? raw.slice(0, NOTE_MAX) : null;

  try {
    const placement = await updatePlacementNote(id, worker.id, note);
    if (!placement) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ placement });
  } catch (e) {
    console.error('PATCH admin note:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not save the note. Try again.' }, { status: 500 });
  }
}
