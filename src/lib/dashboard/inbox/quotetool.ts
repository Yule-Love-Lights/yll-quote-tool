// Pure Quote-Tool adapter (#58 Phase-1 gap). Quote leads live in the SAME
// Supabase DB, so they're folded into the reconcile cron (no API, no Postgres
// trigger). A quote maps to a touch by lifecycle:
//   • not-yet-sent draft → INBOUND (an unresponded lead — we owe a quote).
//   • sent OR approved   → OUTBOUND (we acted → the reducer auto-resolves it).
//   • dead (declined / cancelled / abandoned) → OUTBOUND regardless of the
//     timestamps (#266 — a quote can reach a terminal state without ever being
//     sent, and nobody owes a response to a closed quote).
// Separately, a sent-but-unapproved quote spawns a quote_sent_no_reply follow-up
// (closed when the quote is approved). Pure — the reconcile glue does the I/O.
//
// #181/#252: an unsent, still-DRAFT legacy_rebook ("YLL Neighbor") quote is a
// deliberately-parked rebooking-pool quote (migrations/2026-07-16-legacy-
// rebook.sql), not a real unresponded lead — normalizeQuoteTouch returns null
// for it (no inbox item, no follow-up). Once it's sent, or its status moves
// past 'draft' (sent/viewed/approved/booked/etc.), it behaves like any other
// quote again. #263: the "still parked?" test is the ONE shared predicate
// (isHiddenLegacyRebookQuote, imported from store.ts — a re-export of
// isParkedLegacyRebookDraft, @/lib/quoteStatus) that store.ts's
// listOpenItems/listEscalatableItems, the text-ops bot, and the morning
// digest all now share, so this ingest guard and the inbox's display-side
// filter can no longer silently disagree about what "parked" means (they
// used to each define it independently — #252 slice G already paid for one
// such drift once). Gated on the SAME EXCLUDE_LEGACY_REBOOK_FROM_INBOX flag
// store.ts's listOpenItems/listEscalatableItems use, so the documented
// rollback (flip the flag false) is one switch end-to-end — otherwise this
// ingest-time guard would keep suppressing unsent drafts even after the
// display-side filter was flipped off.

import type { NormalizedTouch } from './types';
import type { DashboardQuote } from '@/lib/dashboard/types';
import { normalizeEmail, normalizeName, normalizePhone, toDate } from './normalize';
import { FOLLOWUP_REASONS } from './followups';
import { EXCLUDE_LEGACY_REBOOK_FROM_INBOX, isHiddenLegacyRebookQuote } from './store';
import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';
import { isFromUs } from './classify';

// #183 BUG 2 / #266: a quote in one of these terminal/dead states is never
// coming back. Positive-match list (never a negative gate, per AGENTS.md
// Pitfalls) and deliberately excludes 'changes_requested' — that quote is being
// revised, not dead, so it is still owed a response.
//
// TWO consumers, one list:
//   • quoteFollowUpDecision — closes the "sent, no reply" follow-up, otherwise
//     the WT-43 ensureFollowUp upsert re-arms a 'done' row back to 'pending'
//     every reconcile forever.
//   • normalizeQuoteTouch — treats the touch as answered (see #266 below).
const DEAD_QUOTE_STATUSES: ReadonlySet<QuoteStatus> = new Set(['declined', 'cancelled', 'abandoned']);

export function isDeadQuote(q: DashboardQuote): boolean {
  return DEAD_QUOTE_STATUSES.has(deriveStatus(q));
}

export function normalizeQuoteTouch(q: DashboardQuote): NormalizedTouch | null {
  // #181/#252/#263: unsent, still-DRAFT YLL Neighbor quotes are parked
  // send-wave inventory, not leads owed a response — suppress before any
  // touch is built (while the flag is on), via the ONE shared "still parked?"
  // predicate (isHiddenLegacyRebookQuote, re-exported from store.ts). A sent,
  // or non-draft (sent/viewed/approved/booked/etc.), legacy_rebook quote
  // falls through to the normal mapping below unchanged, regardless of the
  // flag — including #267(b): a legacy_rebook row that's actually been PAID
  // (deposit_paid_at set) is never suppressed here even if its persisted
  // status column lagged behind at 'draft', because the shared predicate
  // derives off deriveStatus, not the raw column. A row that DOES fall
  // through here (paid, or otherwise no longer parked) still hits the
  // `answered` computation below, so a stale open inbox item for it heals to
  // 'handled' on the next reconcile rather than staying stuck.
  //
  if (EXCLUDE_LEGACY_REBOOK_FROM_INBOX && isHiddenLegacyRebookQuote(q)) return null;
  // Sent, approved, OR PAID means we've acted on this lead; only an untouched
  // draft is still "owed a quote".
  //
  // #266: a DEAD quote (declined / cancelled / abandoned) is answered too, no
  // matter what its timestamps say. Two live cases this closes:
  //   (a) a quote declined before it was ever sent leaves quote_sent_at NULL, so
  //       the timestamps alone read it as an untouched draft — Karen L. Adams
  //       (#1125) and Thomas Humel (#1180) sat in the queue as urgent unanswered
  //       leads at escalation 2 from 2026-07-16 on exactly this shape. THREE prod
  //       rows carry the shape, not two: edward doran (#1006) is the third, but a
  //       human had already marked it 'completed', and the reducer's completed
  //       branch leaves it alone. Two is the count that was screaming, three is
  //       the count that was wrong.
  //   (b) #235's staff-abandon allows abandoning a never-sent draft, which also
  //       leaves quote_sent_at NULL — so the one-click archive would otherwise
  //       fail on precisely its intended case.
  // #267(a): deposit_paid_at now also counts as answered — a quote booked
  // OFFLINE via the deposit webhook alone (customer_approved_at AND
  // quote_sent_at both still null; deriveStatus already reads this shape as
  // 'booked') was previously falling through both OR-terms and rendering as
  // an unanswered inbound lead even though money had already moved. 0 prod
  // rows carry this shape today (verified 2026-08-13, the #263/#267 build) —
  // structural hole, not an active incident.
  // Outbound (not null) on purpose: the reducer auto-resolves an open item to
  // 'handled' on an outbound touch, so existing stuck rows heal themselves on
  // the next reconcile; returning null would leave them open forever. A
  // 'completed' item keeps its completion (the reducer's own guard).
  const answered = isDeadQuote(q) || !!(q.deposit_paid_at || q.customer_approved_at || q.quote_sent_at);
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

// #220: internal domains that should suppress quote_sent_no_reply follow-ups
// now live in classify.ts's INTERNAL_EMAIL_DOMAINS (#252 — shared with the
// GHL and Gmail adapters so the three can't drift apart again). Add new
// internal domains there, not here.

// Do not check q.is_test here. runQuoteToolReconcile only sees rows from
// listQuotesForDashboardResult in src/lib/dashboard/queries.ts, and that
// chokepoint already filters `.eq('is_test', false)` (ledger #93) while
// DASHBOARD_QUOTES_SELECT omits is_test entirely, so a check here would be
// dead code hidden behind type laundering.
function internalQuoteRecipientSuppression(q: DashboardQuote): 'internal_email_domain' | null {
  const email = q.customer_email ? normalizeEmail(q.customer_email) : null;
  if (!email) return null;
  return isFromUs(email) ? 'internal_email_domain' : null;
}

/**
 * Whether a quote should create or close its "sent, no reply" follow-up.
 * declined/cancelled/abandoned → close (dead, #183 BUG 2); approved → close (won);
 * sent-but-unapproved → create unless the recipient is internal (#220);
 * draft → none.
 */
export function quoteFollowUpDecision(q: DashboardQuote): QuoteFollowUpDecision {
  if (isDeadQuote(q)) {
    return { kind: 'close', reason: FOLLOWUP_REASONS.quoteSentNoReply };
  }
  if (q.customer_approved_at) return { kind: 'close', reason: FOLLOWUP_REASONS.quoteSentNoReply };
  const suppression = internalQuoteRecipientSuppression(q);
  if (q.quote_sent_at && suppression) return { kind: 'suppress', suppression };
  if (q.quote_sent_at) return { kind: 'create', reason: FOLLOWUP_REASONS.quoteSentNoReply, sentAt: toDate(q.quote_sent_at) };
  return { kind: 'none' };
}
