// #250: durable record of every attempt to deliver a quote (SMS or email, via
// GHL) to a customer — the gap that made #241 (a re-send silently delivering
// nothing while reporting success) undiagnosable from data. One row per
// attempt in `quote_deliveries` (see migrations/2026-08-12-quote-deliveries.sql
// for the table-vs-columns rationale and the exact call-site scope).
//
// Best-effort by design: logging an attempt must never break the actual
// customer send. This function never throws — any failure (missing client,
// insert error, unexpected exception) is swallowed and logged with
// console.warn instead. Callers (POST /api/quotes/[id]/send) also invoke this
// from within a Promise.allSettled task, which is a second, independent layer
// of isolation on top of the try/catch here.
//
// #264: the insert itself previously had no timeout — a hung DB connection
// would stall the caller indefinitely (the exact "one call in the class stays
// unbounded" gap #250's own review deferred). Bounded below with the same
// manual-AbortController idiom as src/lib/integrations/highlevel.ts's
// ghlFetch (not AbortSignal.timeout() — confirmed it doesn't advance under
// vitest's fake timers in this repo, see ghlFetch's comment). Per postgrest-
// js's own documented behavior, an aborted query resolves the normal
// `{ data, error }` shape (a FetchError, not a throw) — so this never needed
// new error-handling; `.abortSignal()` on the query is the entire change.
// 5s (vs. ghlFetch's 10s): a Postgres round trip over Supabase's pooler is
// normally sub-second; 5s is already generous headroom for a DB call, tighter
// than the 3rd-party-SaaS budget because there's far less legitimate reason
// for a healthy DB call to run long.

import { getSupabaseServiceClient, getSupabaseClient } from './supabase';

export type QuoteDeliveryChannel = 'sms' | 'email';
export type QuoteDeliveryOutcome = 'sent' | 'failed';

export type QuoteDeliveryInput = {
  quoteId: string;
  channel: QuoteDeliveryChannel;
  outcome: QuoteDeliveryOutcome;
  // GHL's conversations/messages response id, when the send succeeded and GHL
  // returned one.
  providerMessageId?: string | null;
  // The send error, when outcome is 'failed'.
  error?: string | null;
};

const DELIVERY_LOG_TIMEOUT_MS = 5_000;

// #264 round 2, FIX 8: marks a 'failed' row whose TRUE delivery outcome is
// UNKNOWN — a timed-out send whose GHL request may have still gone through
// before our socket gave up waiting — rather than a CONFIRMED rejection (see
// deliveryErrorMessage() in the send route, the one writer of this prefix).
// quote_deliveries.outcome has no third "unknown" state (see the migration's
// CHECK constraint), so this is the only durable signal distinguishing the
// two cases. A future "failed deliveries" report/query over this table
// should carve rows starting with this prefix out separately (or at minimum
// not present them as confirmed failures) rather than treating every
// outcome='failed' row identically. Exported (not a private route.ts
// literal) so a report-writer has one canonical string to match on instead
// of re-deriving/duplicating it.
export const DELIVERY_TIMEOUT_ERROR_PREFIX = 'timeout — ';

export async function logQuoteDelivery(input: QuoteDeliveryInput): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sb = getSupabaseServiceClient() ?? getSupabaseClient();
    if (!sb) {
      console.warn('[quoteDeliveries] no Supabase client configured — delivery attempt not logged');
      return;
    }
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), DELIVERY_LOG_TIMEOUT_MS);
    // outcome/error are written verbatim from the caller — see
    // DELIVERY_TIMEOUT_ERROR_PREFIX above for what an 'error' starting with
    // "timeout — " means for a 'failed' outcome row.
    const { error } = await sb
      .from('quote_deliveries')
      .insert({
        quote_id: input.quoteId,
        channel: input.channel,
        outcome: input.outcome,
        provider_message_id: input.providerMessageId ?? null,
        error: input.error ?? null,
      })
      .abortSignal(controller.signal);
    if (error) {
      console.warn('[quoteDeliveries] insert failed:', error.message);
    }
  } catch (err) {
    console.warn('[quoteDeliveries] insert threw:', err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
