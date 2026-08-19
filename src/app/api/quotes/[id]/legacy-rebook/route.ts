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
//
// Tag propagation (#198): when this quote is ALREADY SENT and linked to a
// customers row, turning the flag ON propagates "YLL Neighbor" onto that
// customer immediately — see src/app/api/quotes/[id]/nce/route.ts's sibling
// doc comment for the full rationale (same pattern, added alongside NCE).
//
// #243 (domain rule locked 2026-08-11): permanent/event/bistro quotes can
// never carry the YLL Neighbor tag — canCarryNceOrYllNeighborTag
// (serviceType.ts) is the single source of truth every set/inherit site
// shares; sibling-guard parity with the /nce route's own #243 gate (same
// pre-write read, same "OFF is always allowed" posture — see its comment).

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { attachQuoteToCustomer, propagateQuoteTagsToCustomer, quoteRowToIdentity } from '@/lib/customers';
import { canCarryNceOrYllNeighborTag, type ServiceType } from '@/lib/serviceType';

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

  // #243: reject turning ON before any write, when the quote's own service
  // type can't carry the tag — see the /nce route's sibling comment for why
  // this is a separate pre-write read rather than folded into the update.
  if (legacyRebook) {
    const { data: gateRow, error: gateError } = await sb
      .from('quotes')
      .select('service_type')
      .eq('id', id)
      .maybeSingle<{ service_type: string | null }>();
    if (gateError) {
      console.error('[api/quotes/:id/legacy-rebook] service-type read failed:', gateError);
      return NextResponse.json({ error: 'Failed to update the quote' }, { status: 500 });
    }
    if (!gateRow) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
    }
    if (!canCarryNceOrYllNeighborTag(gateRow.service_type as ServiceType | null)) {
      return NextResponse.json(
        {
          error:
            'YLL Neighbor can only be set on holiday quotes — permanent lighting is always real money, never trade.',
          code: 'not-holiday',
        },
        { status: 400 },
      );
    }
  }

  const { data, error } = await sb
    .from('quotes')
    .update({ legacy_rebook: legacyRebook })
    .eq('id', id)
    // quote_sent_at + customer_id ridden along so the propagation check below
    // needs no second round trip (#198). is_test ridden along too (review
    // fix, admin MED, S34 #198 review) — defense-in-depth, see the sibling
    // /nce route's comment for the full rationale. #214: the identity
    // columns ride along too, feeding the verify-or-reattach below.
    .select(
      'id, legacy_rebook, quote_sent_at, customer_id, is_test, deposit_paid_at, highlevel_contact_id, customer_name, customer_email, customer_phone, customer_address',
    )
    .maybeSingle<{
      id: string;
      legacy_rebook: boolean;
      quote_sent_at: string | null;
      customer_id: string | null;
      is_test: boolean;
      deposit_paid_at: string | null;
      highlevel_contact_id: string | null;
      customer_name: string | null;
      customer_email: string | null;
      customer_phone: string | null;
      customer_address: string | null;
    }>();

  if (error) {
    console.error('[api/quotes/:id/legacy-rebook] update failed:', error);
    return NextResponse.json({ error: 'Failed to update the quote' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  // #214: cached-id first, re-attach ONLY when never linked — see the
  // sibling /nce route's comment for the full rationale (identical block,
  // sibling-guard parity; deliberately NOT attach-first — retroactive
  // tagging of OLD quotes is this flag's core workflow, and an
  // unconditional re-resolution would newest-win stale stored fields onto
  // a customer row later quotes kept current).
  if (!data.is_test && legacyRebook && data.quote_sent_at) {
    try {
      // Booked-freeze parity (round-3 delta-verify) — see the sibling /nce
      // route's comment.
      const linkedCustomerId =
        data.customer_id ??
        (data.deposit_paid_at
          ? null
          : ((await attachQuoteToCustomer(quoteRowToIdentity(data)))?.customerId ?? null));
      if (linkedCustomerId) {
        await propagateQuoteTagsToCustomer(linkedCustomerId, { isYllNeighbor: true });
      }
    } catch (err) {
      console.warn('[api/quotes/:id/legacy-rebook] tag propagation failed (non-fatal):', err);
    }
  }

  return NextResponse.json({ ok: true, legacyRebook: data.legacy_rebook });
}
