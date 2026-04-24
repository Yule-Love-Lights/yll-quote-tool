// Admin-triggered "Send Quote to Customer" action.
// Fired from /quote/new after saveQuote + render complete, when the operator
// hands the portal URL off to the customer (copied to clipboard, emailed,
// texted, whatever — the button doesn't care how the URL is delivered).
//
// POST /api/quotes/[id]/send
// Body: {}  — no payload needed; the quote id is in the URL.
// Response:
//   { ok: true, sentAt: ISO, stageUpdated: boolean, alreadySent?: boolean }
//   { error: string, code?: string }
//
// What happens:
//   1. Validate the quote id
//   2. Load the quote row (need highlevel_opportunity_id + quote_sent_at for idempotency)
//   3. Stamp quote_sent_at if not already set
//   4. If HL opportunity is linked: move the pipeline card to HIGHLEVEL_STAGE_QUOTE_SENT
//      ("Bid Sent"). Non-fatal on failure — the quote is still "sent" locally.
//   5. Return success
//
// Auth model: same as /approve — the quote UUID is the capability token.
// In practice this is only called from the admin UI, but we don't enforce
// admin auth here because (a) admin auth is not yet wired in the app and
// (b) the side effects are low-risk (stage move + timestamp). If abused,
// the worst case is a stage-move spam on an opportunity the attacker
// already has the UUID for.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import {
  updateOpportunityStage,
  isHighLevelConfigured,
  HighLevelError,
} from '@/lib/integrations/highlevel';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteRow = {
  id: string;
  highlevel_opportunity_id: string | null;
  quote_sent_at: string | null;
  customer_approved_at: string | null;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured' },
      { status: 503 },
    );
  }

  const rl = rateLimitResponse(req, { bucket: 'quote-send', limit: 20, windowMs: 60_000 });
  if (rl) return rl;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select('id, highlevel_opportunity_id, quote_sent_at, customer_approved_at')
    .eq('id', id)
    .single<QuoteRow>();

  if (fetchErr || !quote) {
    return NextResponse.json(
      { error: `Quote not found: ${fetchErr?.message ?? 'no row'}` },
      { status: 404 },
    );
  }

  // Idempotency — if already sent, short-circuit and skip the stage move.
  // We don't re-ping HighLevel if the admin double-clicks, because the
  // stage may already have advanced past "Bid Sent" (customer could have
  // approved in between) and we don't want to yank it back.
  if (quote.quote_sent_at) {
    return NextResponse.json({
      ok: true,
      sentAt: quote.quote_sent_at,
      stageUpdated: false,
      alreadySent: true,
    });
  }

  const sentAt = new Date().toISOString();

  // Stamp the DB FIRST, before the HL call, so we don't double-fire the
  // stage move on retries. Same pattern as /approve.
  const { error: stampErr } = await sb
    .from('quotes')
    .update({ quote_sent_at: sentAt })
    .eq('id', id);
  if (stampErr) {
    console.error('[api/quotes/:id/send] stamp failed:', stampErr);
    return NextResponse.json(
      { error: `Failed to mark quote sent: ${stampErr.message}` },
      { status: 500 },
    );
  }

  // HighLevel stage move — "Make Quote" → "📨Bid Sent". Non-fatal on
  // failure; the operator already has the URL, and we've recorded that
  // they clicked "Send." An admin reconciliation job could fix the stage
  // later if it's stuck.
  let stageUpdated = false;
  let stageError: string | undefined;

  const stageSent = process.env.HIGHLEVEL_STAGE_QUOTE_SENT;
  if (!quote.highlevel_opportunity_id) {
    stageError = 'No HighLevel opportunity linked to this quote';
  } else if (!isHighLevelConfigured()) {
    stageError = 'HighLevel not configured';
  } else if (!stageSent) {
    stageError = 'HIGHLEVEL_STAGE_QUOTE_SENT env var not set';
  } else {
    try {
      await updateOpportunityStage(quote.highlevel_opportunity_id, stageSent);
      stageUpdated = true;
    } catch (err) {
      console.warn('[api/quotes/:id/send] HL stage move failed:', err);
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
    sentAt,
    stageUpdated,
    stageError,
  });
}
