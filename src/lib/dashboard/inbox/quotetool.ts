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
// no follow-up). Once it's sent it behaves like any other quote again. Gated
// on the SAME EXCLUDE_LEGACY_REBOOK_FROM_INBOX flag store.ts's listOpenItems/
// listEscalatableItems use, so the documented rollback (flip the flag false)
// is one switch end-to-end — otherwise this ingest-time guard would keep
// suppressing unsent drafts even after the display-side filter was flipped off.

import type { NormalizedTouch } from './types';
import type { DashboardQuote } from '@/lib/dashboard/types';
import { normalizeEmail, normalizeName, normalizePhone, toDate } from './normalize';
import { FOLLOWUP_REASONS } from './followups';
import { EXCLUDE_LEGACY_REBOOK_FROM_INBOX } from './store';
import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';

export function normalizeQuoteTouch(q: DashboardQuote): NormalizedTouch | null {
  // #181: unsent YLL Neighbor drafts are parked send-wave inventory, not leads
  // owed a response — suppress before any touch is built (while the flag is
  // on). Sent legacy_rebook quotes fall through to the normal mapping below
  // unchanged, regardless of the flag.
  //
  // Reviewed + accepted gap: because this guard means a legacy_rebook draft is
  // NEVER ingested while unsent, one that's later marked sent always hits the
  // "sent without ever being seen as a draft" edge (per the file header above)
  // — no prior inbox item to attach a follow-up to, so no quote_sent_no_reply
  // follow-up fires for it. The dashboard worklist's own quote_sent_at-age nudge
  // (src/lib/dashboard/needsAction.ts, independent of inbox state) covers that
  // gap, so this is accepted rather than fixed here.
  if (EXCLUDE_LEGACY_REBOOK_FROM_INBOX && q.legacy_rebook && !q.quote_sent_at) return null;
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
  | { kind: 'suppress'; suppression: 'internal_email_domain' }
  | { kind: 'none' };

// #183 BUG 2: a quote in one of these terminal/dead states is never coming
// back, so its "sent, no reply" follow-up must close — otherwise the WT-43
// ensureFollowUp upsert re-arms a 'done' row back to 'pending' every reconcile
// forever (the live case: a DECLINED quote whose follow-up kept resurrecting
// daily, because only customer_approved_at closed it below). Positive-match
// list (never a negative gate, per AGENTS.md Pitfalls) and deliberately
// excludes 'changes_requested' — that quote is being revised, not dead, so
// the nudge should stay live.
const DEAD_QUOTE_STATUSES: ReadonlySet<QuoteStatus> = new Set(['declined', 'cancelled', 'lost']);

// #220: add new internal domains here when a company-owned recipient should
// suppress quote_sent_no_reply follow-ups. Bare domain + any subdomain match.
export const INTERNAL_QUOTE_EMAIL_DOMAINS = ['yulelovelights.com'] as const;

// Do not check q.is_test here. runQuoteToolReconcile only sees rows from
// listQuotesForDashboardResult in src/lib/dashboard/queries.ts, and that
// chokepoint already filters `.eq('is_test', false)` (ledger #93) while
// DASHBOARD_QUOTES_SELECT omits is_test entirely, so a check here would be
// dead code hidden behind type laundering.
function internalQuoteRecipientSuppression(q: DashboardQuote): 'internal_email_domain' | null {
  const email = q.customer_email ? normalizeEmail(q.customer_email) : null;
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1);
  return INTERNAL_QUOTE_EMAIL_DOMAINS.some((internalDomain) => domain === internalDomain || domain.endsWith(`.${internalDomain}`))
    ? 'internal_email_domain'
    : null;
}

/**
 * Whether a quote should create or close its "sent, no reply" follow-up.
 * declined/cancelled/lost → close (dead, #183 BUG 2); approved → close (won);
 * sent-but-unapproved → create unless the recipient is internal (#220);
 * draft → none.
 */
export function quoteFollowUpDecision(q: DashboardQuote): QuoteFollowUpDecision {
  if (DEAD_QUOTE_STATUSES.has(deriveStatus(q))) {
    return { kind: 'close', reason: FOLLOWUP_REASONS.quoteSentNoReply };
  }
  if (q.customer_approved_at) return { kind: 'close', reason: FOLLOWUP_REASONS.quoteSentNoReply };
  const suppression = internalQuoteRecipientSuppression(q);
  if (q.quote_sent_at && suppression) return { kind: 'suppress', suppression };
  if (q.quote_sent_at) return { kind: 'create', reason: FOLLOWUP_REASONS.quoteSentNoReply, sentAt: toDate(q.quote_sent_at) };
  return { kind: 'none' };
}
