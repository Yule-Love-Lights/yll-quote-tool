// Pure Quote-Tool adapter (#58 Phase-1 gap). Quote leads live in the SAME
// Supabase DB, so they're folded into the reconcile cron (no API, no Postgres
// trigger). A quote maps to a touch by lifecycle:
//   • not-yet-sent draft → INBOUND (an unresponded lead — we owe a quote).
//   • sent OR approved   → OUTBOUND (we acted → the reducer auto-resolves it).
// Separately, a sent-but-unapproved quote spawns a quote_sent_no_reply follow-up
// (closed when the quote is approved). Pure — the reconcile glue does the I/O.
//
// #181: an unsent legacy_rebook ("YLL Neighbor") draft is a deliberately-parked
// rebooking-pool quote (migrations/2026-07-16-legacy-rebook.sql), not a real
// unresponded lead — normalizeQuoteTouch returns null for it (no inbox item,
// no follow-up). Once it's sent it behaves like any other quote again.

import type { NormalizedTouch } from './types';
import type { DashboardQuote } from '@/lib/dashboard/types';
import { normalizeEmail, normalizeName, normalizePhone, toDate } from './normalize';
import { FOLLOWUP_REASONS } from './followups';

export function normalizeQuoteTouch(q: DashboardQuote): NormalizedTouch | null {
  // #181: unsent YLL Neighbor drafts are parked send-wave inventory, not leads
  // owed a response — suppress before any touch is built. Sent legacy_rebook
  // quotes fall through to the normal mapping below unchanged.
  if (q.legacy_rebook && !q.quote_sent_at) return null;
  // Sent OR approved means we've acted on this lead; only an untouched draft is
  // still "owed a quote".
  const answered = !!(q.customer_approved_at || q.quote_sent_at);
  const email = q.customer_email ? normalizeEmail(q.customer_email) : null;
  const phone = q.customer_phone ? normalizePhone(q.customer_phone) : null;
  return {
    source: 'quotetool',
    externalId: q.id,
    sourceMessageId: null,
    direction: answered ? 'outbound' : 'inbound',
    channel: 'app',
    lastMessageAt: toDate(q.quote_sent_at ?? q.created_at),
    preview: q.total != null ? `Quote — $${q.total}` : 'New quote',
    subject: null,
    identity: {
      ghlContactId: q.highlevel_contact_id ?? null,
      emails: email ? [email] : [],
      phones: phone ? [phone] : [],
      displayName: q.customer_name ? normalizeName(q.customer_name) : null,
    },
    raw: q,
    leadKind: 'lead',
    quoteValue: q.total ?? null,
  };
}

export type QuoteFollowUpDecision =
  | { kind: 'create'; reason: string; sentAt: Date }
  | { kind: 'close'; reason: string }
  | { kind: 'none' };

/**
 * Whether a quote should create or close its "sent, no reply" follow-up.
 * approved → close (won); sent-but-unapproved → create; draft → none.
 */
export function quoteFollowUpDecision(q: DashboardQuote): QuoteFollowUpDecision {
  if (q.customer_approved_at) return { kind: 'close', reason: FOLLOWUP_REASONS.quoteSentNoReply };
  if (q.quote_sent_at) return { kind: 'create', reason: FOLLOWUP_REASONS.quoteSentNoReply, sentAt: toDate(q.quote_sent_at) };
  return { kind: 'none' };
}
