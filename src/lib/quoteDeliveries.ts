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

export async function logQuoteDelivery(input: QuoteDeliveryInput): Promise<void> {
  try {
    const sb = getSupabaseServiceClient() ?? getSupabaseClient();
    if (!sb) {
      console.warn('[quoteDeliveries] no Supabase client configured — delivery attempt not logged');
      return;
    }
    const { error } = await sb.from('quote_deliveries').insert({
      quote_id: input.quoteId,
      channel: input.channel,
      outcome: input.outcome,
      provider_message_id: input.providerMessageId ?? null,
      error: input.error ?? null,
    });
    if (error) {
      console.warn('[quoteDeliveries] insert failed:', error.message);
    }
  } catch (err) {
    console.warn('[quoteDeliveries] insert threw:', err);
  }
}
