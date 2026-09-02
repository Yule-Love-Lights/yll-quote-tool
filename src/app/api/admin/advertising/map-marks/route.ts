import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { createMapMark, isMapMarkKind, listMapMarks, retireMapMark } from '@/lib/advertising/mapMarks';

export const runtime = 'nodejs';

/**
 * The places Naldo marks on the map: hot spots to send the crew to, and
 * areas to keep them out of.
 *
 *   GET    /api/admin/advertising/map-marks           - every mark
 *   GET    ...?activeOnly=1                           - only what is shown
 *   POST   /api/admin/advertising/map-marks           - drop one
 *   DELETE /api/admin/advertising/map-marks?id=x      - retire one (soft)
 *
 * requireAdmin only, and the author is always the admin session rather than
 * a value from the body.
 */

export async function GET(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;
  const activeOnly = req.nextUrl.searchParams.get('activeOnly') === '1';
  return NextResponse.json({ marks: await listMapMarks({ activeOnly }) });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const body = (await req.json().catch(() => null)) as
    | { kind?: unknown; label?: unknown; lat?: unknown; lng?: unknown; note?: unknown; radiusM?: unknown }
    | null;

  if (!isMapMarkKind(body?.kind)) {
    return NextResponse.json({ error: 'Choose whether this is a hot spot or somewhere to avoid.' }, { status: 400 });
  }
  const label = typeof body?.label === 'string' ? body.label.trim() : '';
  if (!label) return NextResponse.json({ error: 'Give this spot a name.' }, { status: 400 });
  if (typeof body?.lat !== 'number' || typeof body?.lng !== 'number') {
    return NextResponse.json({ error: 'Tap the map to place this spot.' }, { status: 400 });
  }
  const radiusM = body?.radiusM == null ? null : Number(body.radiusM);
  if (radiusM !== null && (!Number.isInteger(radiusM) || radiusM <= 0)) {
    return NextResponse.json({ error: 'A radius must be a whole number of metres.' }, { status: 400 });
  }

  try {
    const mark = await createMapMark({
      kind: body.kind,
      label,
      lat: body.lat,
      lng: body.lng,
      note: typeof body?.note === 'string' ? body.note : null,
      radiusM,
      createdBy: auth.operator.id,
    });
    return NextResponse.json({ mark }, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not save that spot';
    console.error('POST /api/admin/advertising/map-marks:', message);
    // These are all things the person can fix by changing what they typed or
    // where they tapped, so say which rather than a blanket failure.
    const badInput = /name|position|off the map|radius|kind/i.test(message);
    return NextResponse.json(
      { error: badInput ? message.replace(/^createMapMark:\s*/, '') : 'Could not save that spot. Try again.' },
      { status: badInput ? 400 : 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const id = (req.nextUrl.searchParams.get('id') ?? '').trim();
  if (!id) return NextResponse.json({ error: 'Which spot?' }, { status: 400 });

  try {
    const mark = await retireMapMark(id, auth.operator.id);
    return NextResponse.json({ mark });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not remove that spot';
    console.error('DELETE /api/admin/advertising/map-marks:', message);
    const missing = /no mark found/i.test(message);
    return NextResponse.json(
      { error: missing ? 'That spot is already gone. Reload the map.' : 'Could not remove that spot. Try again.' },
      { status: missing ? 404 : 500 },
    );
  }
}
