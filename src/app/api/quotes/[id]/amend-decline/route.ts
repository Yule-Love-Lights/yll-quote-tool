// Customer DECLINE for the latest total-changing amendment on a booked order.
// Sibling of amend-consent/route.ts (same capability-token model — the quote
// UUID — same CAS-guarded write) but the customer says NO instead of signing.
//
// Ledger #83 follow-up, from a real live incident: staff added a $342.56
// wreath to a booked order, the customer got a notice with no way to decline
// it on the portal, and had to phone in. This endpoint records that refusal.
//
// What this endpoint deliberately does NOT do: it does NOT re-price the
// order, touch the invoice, or change the quote's lifecycle status. Staff
// priced the change in the builder; only staff can un-price it (a new
// amendment). This just marks the latest amendment `consent: {status:
// 'declined', ...}` so blocksSettlement (src/lib/amend.ts) keeps blocking the
// balance exactly as hard as it did while pending — a decline is NOT
// consent, so it must never become collectable. See amend.ts's
// isAmendmentConsentPending/blocksSettlement doc comments for the full
// reasoning; this route does not re-derive it.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  isAmendmentConsentPending,
  latestConsentAmendment,
  requiresReconsent,
  type AmendmentTrailEntry,
} from '@/lib/amend';
import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Matches the staff-side amend reason cap (src/app/api/quotes/[id]/amend/route.ts)
// — this is the customer's own optional free text, capped the same way.
const MAX_REASON = 500;

type ApprovalSnapshot = {
  amendments?: AmendmentTrailEntry[];
  [key: string]: unknown;
};

type QuoteRow = {
  id: string;
  status: QuoteStatus | null;
  quote_sent_at: string | null;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  approval_snapshot: ApprovalSnapshot | null;
};

function clientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim() || null;
  return req.headers.get('x-real-ip')?.trim() || null;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const limited = rateLimitResponse(req, {
    bucket: 'quote-amend-decline',
    limit: 5,
    windowMs: 60_000,
  });
  if (limited) return limited;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  let body: { amendedAt?: unknown; reason?: unknown } = {};
  try {
    body = (await req.json()) as { amendedAt?: unknown; reason?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const amendedAt = typeof body.amendedAt === 'string' ? body.amendedAt : '';
  if (!amendedAt) {
    return NextResponse.json(
      { error: 'A valid amendment id is required', code: 'bad-decline' },
      { status: 400 },
    );
  }
  // The decline reason is OPTIONAL customer free text — unlike amend-consent's
  // signature, there is nothing required to make a decline valid.
  const rawReason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (rawReason.length > MAX_REASON) {
    return NextResponse.json(
      { error: `Reason must be ≤ ${MAX_REASON} characters`, code: 'bad-decline' },
      { status: 400 },
    );
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: readError } = await sb
    .from('quotes')
    .select('id, status, quote_sent_at, customer_approved_at, deposit_paid_at, approval_snapshot')
    .eq('id', id)
    .single<QuoteRow>();
  if (readError || !quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  const lifecycle = deriveStatus({
    status: quote.status,
    quote_sent_at: quote.quote_sent_at,
    customer_approved_at: quote.customer_approved_at,
    deposit_paid_at: quote.deposit_paid_at,
  });
  if (!quote.deposit_paid_at || lifecycle !== 'booked') {
    return NextResponse.json(
      { error: 'Only a live booked order can record amendment consent', code: 'not-booked' },
      { status: 409 },
    );
  }

  const snapshot = quote.approval_snapshot ?? {};
  const amendments = Array.isArray(snapshot.amendments) ? snapshot.amendments : [];
  const latest = latestConsentAmendment(amendments);
  if (!latest || latest.amended_at !== amendedAt) {
    return NextResponse.json(
      { error: 'This amendment is no longer the latest price change', code: 'stale-amendment' },
      { status: 409 },
    );
  }
  const consentIndex = amendments.lastIndexOf(latest);
  if (!requiresReconsent(latest)) {
    return NextResponse.json(
      { error: 'This amendment does not require customer consent', code: 'consent-not-required' },
      { status: 409 },
    );
  }
  // Already signed — declining now would silently discard a real signature.
  // Reject rather than overwrite; the customer's UI shouldn't offer this path
  // once accepted (the card renders read-only), so reaching it means a stale
  // tab or a replay, not a genuine change of mind.
  if (latest.consent?.status === 'accepted') {
    return NextResponse.json(
      { error: 'This amendment was already approved and signed', code: 'already-accepted' },
      { status: 409 },
    );
  }
  // Already declined — idempotent success (a retry/double-submit should not
  // 409), mirroring amend-consent's own alreadyConsented short-circuit.
  if (latest.consent?.status === 'declined') {
    return NextResponse.json({ ok: true, alreadyDeclined: true });
  }

  const declinedAt = new Date().toISOString();
  const declined: AmendmentTrailEntry = {
    ...latest,
    consent: {
      status: 'declined',
      declined_at: declinedAt,
      ip: clientIp(req),
      ...(rawReason ? { reason: rawReason } : {}),
    },
  };
  const nextSnapshot: ApprovalSnapshot = {
    ...snapshot,
    amendments: amendments.map((entry, index) => (index === consentIndex ? declined : entry)),
  };

  // Compare-and-swap the full jsonb snapshot — identical shape to amend-consent's
  // write (see that route's comment for why the snapshot is serialized explicitly
  // rather than passed as an object).
  const { data: updated, error: updateError } = await sb
    .from('quotes')
    .update({ approval_snapshot: nextSnapshot })
    .eq('id', id)
    .eq('approval_snapshot', JSON.stringify(snapshot))
    .select('id');
  if (updateError) {
    console.error('[api/quotes/:id/amend-decline] update failed:', updateError);
    return NextResponse.json({ error: 'Failed to record your response' }, { status: 500 });
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json(
      { error: 'The amendment changed while you were responding. Refresh and try again.', code: 'concurrent-amendment' },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    declinedAt,
    amendedAt,
    previousTotalUsd: latest.previous_total,
    // Confirms isAmendmentConsentPending(declined) === isAmendmentConsentPending(pending) —
    // a declined increase is still un-settleable (see amend.ts).
    stillBlocksSettlement: isAmendmentConsentPending(declined) && declined.delta > 0,
  });
}
