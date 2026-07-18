// Customer consent for the latest total-changing amendment on a booked order.
// The quote UUID is the capability token, matching the public approval route.
// This endpoint never moves money or changes lifecycle status. It only replaces
// the latest amendment's pending marker with a server-stamped signature.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  isAmendmentConsentPending,
  latestAmendment,
  requiresReconsent,
  type AmendmentConsentSignature,
  type AmendmentTrailEntry,
} from '@/lib/amend';
import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNATURE_NAME_MIN = 2;
const SIGNATURE_NAME_MAX = 200;
const SIGNATURE_VALUE_MAX = 200_000;

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

function parseSignature(raw: unknown, ip: string | null): AmendmentConsentSignature | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const kind = value.kind;
  const signatureValue = typeof value.value === 'string' ? value.value.trim() : '';
  if (name.length < SIGNATURE_NAME_MIN || name.length > SIGNATURE_NAME_MAX) return null;
  if (kind !== 'typed' && kind !== 'drawn') return null;
  if (!signatureValue || signatureValue.length > SIGNATURE_VALUE_MAX) return null;
  return {
    name,
    kind,
    value: signatureValue,
    signed_at: new Date().toISOString(),
    ip,
  };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const limited = rateLimitResponse(req, {
    bucket: 'quote-amend-consent',
    limit: 5,
    windowMs: 60_000,
  });
  if (limited) return limited;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  let body: { amendedAt?: unknown; signature?: unknown } = {};
  try {
    body = (await req.json()) as { amendedAt?: unknown; signature?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const amendedAt = typeof body.amendedAt === 'string' ? body.amendedAt : '';
  const signature = parseSignature(body.signature, clientIp(req));
  if (!amendedAt || !signature) {
    return NextResponse.json(
      { error: 'A valid amendment id and signature are required', code: 'bad-consent' },
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
      { error: 'Only a live booked order can accept amendment consent', code: 'not-booked' },
      { status: 409 },
    );
  }

  const snapshot = quote.approval_snapshot ?? {};
  const amendments = Array.isArray(snapshot.amendments) ? snapshot.amendments : [];
  const latest = latestAmendment(amendments);
  if (!latest || latest.amended_at !== amendedAt) {
    return NextResponse.json(
      { error: 'This amendment is no longer the latest version', code: 'stale-amendment' },
      { status: 409 },
    );
  }
  if (!requiresReconsent(latest)) {
    return NextResponse.json(
      { error: 'This amendment does not require customer consent', code: 'consent-not-required' },
      { status: 409 },
    );
  }
  if (!isAmendmentConsentPending(latest)) {
    return NextResponse.json({ ok: true, alreadyConsented: true });
  }

  const acceptedAt = new Date().toISOString();
  const accepted: AmendmentTrailEntry = {
    ...latest,
    consent: { status: 'accepted', accepted_at: acceptedAt, signature },
  };
  const nextSnapshot: ApprovalSnapshot = {
    ...snapshot,
    amendments: [...amendments.slice(0, -1), accepted],
  };

  // Compare-and-swap the full jsonb snapshot. PostgREST filter values are
  // string-interpolated, so serialize explicitly; passing the object itself
  // would become "[object Object]" and no valid jsonb row could match it.
  // Two tabs can read the same pending entry, but only the first update still
  // matches the old snapshot; the loser gets a clean conflict.
  const { data: updated, error: updateError } = await sb
    .from('quotes')
    .update({ approval_snapshot: nextSnapshot })
    .eq('id', id)
    .eq('approval_snapshot', JSON.stringify(snapshot))
    .select('id');
  if (updateError) {
    console.error('[api/quotes/:id/amend-consent] update failed:', updateError);
    return NextResponse.json({ error: 'Failed to record amendment consent' }, { status: 500 });
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json(
      { error: 'The amendment changed while you were signing. Refresh and try again.', code: 'concurrent-amendment' },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    acceptedAt,
    amendedAt,
    newTotalUsd: latest.new_total,
    newBalanceUsd: latest.new_balance,
  });
}
