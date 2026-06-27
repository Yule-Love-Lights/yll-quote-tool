// Inbound webhook: home.works tells us the customer signed.
//
// Architecture: home.works → Zapier (filter on signature event) → POST here.
// We use Zapier as the middleman both ways for symmetry — same webhook
// pattern as outbound, same operator (Naldo) configures both Zaps.
//
// POST /api/integrations/homeworks/signed
// Headers:
//   x-homeworks-secret: <shared secret>     // matches env HOMEWORKS_SIGNED_SECRET
// Body:
//   {
//     quoteId: string,                      // our UUID, round-tripped via the
//                                           // outbound payload (Zapier maps
//                                           // home.works's "external reference"
//                                           // back to our quote id)
//     signedAt?: string,                    // ISO; defaults to now() if omitted
//     homeworksContractId?: string,         // home.works's contract reference
//   }
// Response:
//   { ok: true, signedAt, stageUpdated, alreadySigned? }
//   { error: string, code? }
//
// What this fires:
//   1. Validate the request (secret + UUID + body shape)
//   2. Idempotency check — short-circuit if already signed
//   3. Stamp homeworks_signed_at + homeworks_contract_id
//   4. Move HL opportunity to "⏰Approved" (HIGHLEVEL_STAGE_QUOTE_SIGNED)
//   5. Return result; HL failure is non-fatal (we still recorded the sign)
//
// Auth model: shared secret in the header. Generate one with
//   openssl rand -hex 32
// and paste the same value into:
//   .env.local HOMEWORKS_SIGNED_SECRET=...
//   Zapier "Headers" config on the outgoing webhook step
// We don't use IP-allowlisting because Zapier's IPs change. The secret
// is a 256-bit random — easily long enough to resist online guessing,
// and Zapier transmits over HTTPS.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import {
  updateOpportunityStage,
  isHighLevelConfigured,
  HighLevelError,
} from '@/lib/integrations/highlevel';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { safeEqual } from '@/lib/security';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteRow = {
  id: string;
  highlevel_opportunity_id: string | null;
  homeworks_signed_at: string | null;
  homeworks_contract_id: string | null;
  customer_approved_at: string | null;
};

type SignedBody = {
  quoteId?: string;
  signedAt?: string;
  homeworksContractId?: string;
};

export async function POST(req: NextRequest) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured' },
      { status: 503 },
    );
  }

  // Shared-secret check. We require the secret to be configured server-side
  // so a misconfigured deploy can't accidentally accept anonymous "signed"
  // webhooks — that would let anyone advance any quote to the "signed" stage.
  const expected = process.env.HOMEWORKS_SIGNED_SECRET;
  if (!expected) {
    console.error('[api/integrations/homeworks/signed] HOMEWORKS_SIGNED_SECRET not set');
    return NextResponse.json(
      { error: 'HOMEWORKS_SIGNED_SECRET not configured on server', code: 'secret-missing' },
      { status: 503 },
    );
  }
  const provided = req.headers.get('x-homeworks-secret');
  // Audit fix: constant-time compare to avoid leaking the secret via timing.
  if (!safeEqual(provided ?? undefined, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Even with the secret we keep a generous rate limit — protects against
  // a misconfigured Zap firing in a loop.
  const rl = rateLimitResponse(req, { bucket: 'hw-signed', limit: 60, windowMs: 60_000 });
  if (rl) return rl;

  let body: SignedBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.quoteId || !UUID_RE.test(body.quoteId)) {
    return NextResponse.json({ error: 'quoteId must be a valid UUID' }, { status: 400 });
  }

  // Validate optional ISO timestamp; reject obviously-broken values rather
  // than silently storing garbage.
  let signedAt: string;
  if (body.signedAt) {
    const t = Date.parse(body.signedAt);
    if (Number.isNaN(t)) {
      return NextResponse.json({ error: 'signedAt is not a valid ISO timestamp' }, { status: 400 });
    }
    signedAt = new Date(t).toISOString();
  } else {
    signedAt = new Date().toISOString();
  }

  const homeworksContractId =
    typeof body.homeworksContractId === 'string' && body.homeworksContractId.trim()
      ? body.homeworksContractId.trim().slice(0, 200)
      : null;

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select('id, highlevel_opportunity_id, homeworks_signed_at, homeworks_contract_id, customer_approved_at')
    .eq('id', body.quoteId)
    .single<QuoteRow>();

  if (fetchErr || !quote) {
    return NextResponse.json(
      { error: `Quote not found: ${fetchErr?.message ?? 'no row'}` },
      { status: 404 },
    );
  }

  // Idempotency. home.works (or Zapier) might retry — once signed, stay
  // signed. Don't re-fire the HL stage move; the customer might have
  // moved past it manually.
  if (quote.homeworks_signed_at) {
    return NextResponse.json({
      ok: true,
      signedAt: quote.homeworks_signed_at,
      stageUpdated: false,
      alreadySigned: true,
    });
  }

  // DB stamp first, before HL — same pattern as /send and /approve.
  //
  // Audit fix (TOCTOU): the SELECT short-circuit above is only a fast path.
  // ATOMIC CLAIM — the update is conditional on `homeworks_signed_at IS NULL`,
  // so when Zapier fires concurrent retries (it retries, limit is 60/min) two
  // requests can both pass the read-side null-check; exactly ONE flips the row
  // here and proceeds to the HL stage move — the others update 0 rows and
  // short-circuit, so updateOpportunityStage fires at most once.
  const updatePayload: Record<string, string> = { homeworks_signed_at: signedAt };
  if (homeworksContractId) updatePayload.homeworks_contract_id = homeworksContractId;

  const { data: claimed, error: stampErr } = await sb
    .from('quotes')
    .update(updatePayload)
    .eq('id', body.quoteId)
    .is('homeworks_signed_at', null)
    .select('id');
  if (stampErr) {
    console.error('[api/integrations/homeworks/signed] stamp failed:', stampErr);
    return NextResponse.json(
      { error: `Failed to mark quote signed: ${stampErr.message}` },
      { status: 500 },
    );
  }

  // Lost the race to a concurrent retry — it already stamped and (will) fire
  // the HL stage move. Acknowledge as already-signed without double-firing.
  if (!claimed || claimed.length === 0) {
    return NextResponse.json({
      ok: true,
      signedAt,
      stageUpdated: false,
      alreadySigned: true,
    });
  }

  // HL stage move — Make Quote / Bid Sent / Interested → ⏰Approved.
  // Non-fatal: the sign is already recorded locally even if HL fails.
  let stageUpdated = false;
  let stageError: string | undefined;
  const stageSigned = process.env.HIGHLEVEL_STAGE_QUOTE_SIGNED;
  if (!quote.highlevel_opportunity_id) {
    stageError = 'No HighLevel opportunity linked to this quote';
  } else if (!isHighLevelConfigured()) {
    stageError = 'HighLevel not configured';
  } else if (!stageSigned) {
    stageError = 'HIGHLEVEL_STAGE_QUOTE_SIGNED env var not set';
  } else {
    try {
      await updateOpportunityStage(quote.highlevel_opportunity_id, stageSigned);
      stageUpdated = true;
    } catch (err) {
      console.warn('[api/integrations/homeworks/signed] HL stage move failed:', err);
      stageError =
        err instanceof HighLevelError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Unknown HighLevel error';
    }
  }

  return NextResponse.json({
    ok: true,
    signedAt,
    stageUpdated,
    stageError,
  });
}
