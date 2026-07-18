// Staff-only "Mark as YLL Neighbor" toggle (#155-158 follow-up).
//
// POST /api/quotes/[id]/legacy-rebook   (operator-only)
// Body: { legacyRebook: boolean }   — strict: must be a real boolean.
// Response: { ok: true, legacyRebook: boolean } | { error, code? }
//
// A hand-built quote for a returning customer sometimes misses the
// legacy_rebook flag set by the #155-158 bulk migration (e.g. quote #1191).
// This route lets staff set/unset it per quote from the admin quote detail
// page. Three real behaviors already read quotes.legacy_rebook and are left
// untouched by this route:
//   - the portal renders the "Last Year's Design" rebook variant
//     (src/lib/portal/adapter.ts, src/lib/portal/derivePackages.ts)
//   - the operator inbox hides the quote (src/lib/dashboard/inbox/store.ts)
//   - GHL sync routes to the Neighbors pipeline instead of the quote's own
//     service-type pipeline (src/lib/integrations/ghlPipelineMap.ts)
// The flag only changes FUTURE renders/syncs — flipping it never retroactively
// moves an existing GHL card (the admin confirm dialog says so explicitly).

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const legacyRebook = (body as { legacyRebook?: unknown } | null)?.legacyRebook;
  if (typeof legacyRebook !== 'boolean') {
    return NextResponse.json(
      { error: 'legacyRebook must be a boolean', code: 'invalid-body' },
      { status: 400 },
    );
  }

  const sb = getSupabaseServiceClient()!;
  const { data, error } = await sb
    .from('quotes')
    .update({ legacy_rebook: legacyRebook })
    .eq('id', id)
    .select('id, legacy_rebook')
    .maybeSingle<{ id: string; legacy_rebook: boolean }>();

  if (error) {
    console.error('[api/quotes/:id/legacy-rebook] update failed:', error);
    return NextResponse.json({ error: 'Failed to update the quote' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, legacyRebook: data.legacy_rebook });
}
