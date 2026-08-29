import { NextResponse, type NextRequest } from 'next/server';

import { advertisingRefusalStatus, getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import { updatePlacementNote } from '@/lib/advertising/placements';

export const runtime = 'nodejs';

const NOTE_MAX = 500;

/**
 * PATCH /api/advertising/placements/[id]/note — the worker's own per-photo
 * note (Simple Crew replica "Take a note..."). Ownership is enforced in the
 * data layer's write (worker_id filter), so someone else's placement 404s.
 * Send { note: string } to set, { note: null } or empty to clear.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    return NextResponse.json({ error: 'Not allowed' }, { status: advertisingRefusalStatus(caller.reason) });
  }

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { note?: unknown } | null;
  const raw = body?.note;
  if (raw !== null && raw !== undefined && typeof raw !== 'string') {
    return NextResponse.json({ error: 'Send note as text (or null to clear).' }, { status: 400 });
  }
  const note = typeof raw === 'string' ? raw.slice(0, NOTE_MAX) : null;

  try {
    const placement = await updatePlacementNote(id, caller.worker.id, note);
    if (!placement) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ placement });
  } catch (e) {
    console.error('PATCH note:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not save the note. Try again.' }, { status: 500 });
  }
}
