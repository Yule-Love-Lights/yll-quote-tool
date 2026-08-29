// Archive a quote when its HighLevel card is declined or abandoned (S75, Naldo).
//
// Staff work the pipeline in HighLevel, not in the quote tool, so a customer
// who says no gets dragged to Declined in GHL and the quote here keeps sitting
// in the pipeline nagging. This module is the pure half of the sync: it decides
// WHAT a GHL stage means and WHETHER a given quote row may be archived. The
// route (/api/integrations/highlevel/opportunity-stage) does the IO.
//
// "Archive" here means exactly what Naldo asked for: the quote goes terminal
// (declined or abandoned) and view_only, so the customer can still open their
// link and look at the design and the prices, but cannot approve, decline, or
// pay. Nothing is deleted, and staff reverse it with the existing view-only
// toggle plus a revive (canRevive covers declined and abandoned).

import { allPipelineStages } from './ghlPipelineMap';
import { canTransition, QUOTE_STATUSES, type QuoteStatus } from '@/lib/quoteStatus';

export type ArchiveOutcome = Extract<QuoteStatus, 'declined' | 'abandoned'>;

/**
 * Every declined / abandoned stage id across all pipelines, mapped to what it
 * means. Built from ghlPipelineMap so a new pipeline or a corrected stage id is
 * picked up here automatically instead of drifting in a second hardcoded list.
 *
 * The Neighbors pipeline deliberately reuses its Declined id for `abandoned`
 * (see NEIGHBORS_STAGES) — one id, two names. Declined is inserted last so it
 * wins that collision: the stage is literally called "Declined for 2026", and
 * calling a decline an abandon would understate what happened.
 */
export function archiveStageMap(): Map<string, ArchiveOutcome> {
  const map = new Map<string, ArchiveOutcome>();
  for (const stages of allPipelineStages()) map.set(stages.abandoned, 'abandoned');
  for (const stages of allPipelineStages()) map.set(stages.declined, 'declined');
  return map;
}

/** What a GHL pipeline stage id means for a quote, or null if it is not an
 *  archive stage (an ordinary Open / Bid Sent / Installed move changes nothing). */
export function outcomeForStageId(stageId: string | null | undefined): ArchiveOutcome | null {
  const id = stageId?.trim();
  if (!id) return null;
  return archiveStageMap().get(id) ?? null;
}

/** An explicitly-named outcome from the webhook body, for a GHL workflow that
 *  states its intent rather than passing a stage id. Anything else is null. */
export function asArchiveOutcome(v: unknown): ArchiveOutcome | null {
  return v === 'declined' || v === 'abandoned' ? v : null;
}

/**
 * The statuses an archive is legal FROM, derived from the canonical transition
 * table minus the money line.
 *
 * `approved` is REMOVED deliberately. canTransition(approved, 'declined') is
 * true — a staff member declining an approved quote by hand is a real,
 * deliberate thing — but this path is a webhook fired by a drag in another
 * system. Naldo's rule, 2026-08-29: an approved quote can never be archived
 * from here. A misclick in HighLevel must not relabel work the customer already
 * said yes to. Those land in the refusal path below and are reported instead.
 */
export const ARCHIVABLE_FROM: readonly QuoteStatus[] = QUOTE_STATUSES.filter(
  (s) => s !== 'approved' && (canTransition(s, 'declined') || canTransition(s, 'abandoned')),
);

export type ArchiveCandidate = {
  status: QuoteStatus;
  customerApprovedAt: string | null;
  depositPaidAt: string | null;
  viewOnly: boolean;
};

export type ArchiveDecision =
  | { action: 'archive' }
  | { action: 'skip'; reason: 'already-terminal' | 'already-view-only' }
  | { action: 'refuse'; reason: 'has-money' | 'illegal-transition' };

/**
 * Whether this quote may be archived by a GHL stage move.
 *
 * Three outcomes on purpose, because they mean different things to staff: skip
 * is "nothing to do", refuse is "a human should look at this". A refusal is
 * never silent — the route reports every one back so the owner can see that a
 * customer who already paid was dragged to Declined in the CRM.
 *
 * Deliberately does NOT take the outcome. Whether a quote MAY be archived turns
 * only on the quote, never on which terminal name it would land under: a quote
 * that is already closed is skipped whichever name it is closed under, and a
 * live one is archivable either way. The outcome is applied at the write.
 */
export function decideArchive(quote: ArchiveCandidate): ArchiveDecision {
  // Money first, before anything else can pass. Both columns are checked
  // rather than trusting `status`: a legacy row can carry the timestamps with
  // a null persisted status, and deriveStatus is what reconciles them.
  if (quote.customerApprovedAt || quote.depositPaidAt) return { action: 'refuse', reason: 'has-money' };
  if (quote.status === 'approved' || quote.status === 'booked') {
    return { action: 'refuse', reason: 'has-money' };
  }
  // Already closed, under this name or another one. Checked BEFORE the
  // transition gate below, because a quote that is already declined is not a
  // problem a human needs to look at — it is nothing to do. (The transition
  // table has no moves out of a terminal status, so without this it would fall
  // through and read as an illegal transition.)
  if (quote.status === 'declined' || quote.status === 'abandoned' || quote.status === 'cancelled') {
    return { action: 'skip', reason: 'already-terminal' };
  }
  if (!ARCHIVABLE_FROM.includes(quote.status)) return { action: 'refuse', reason: 'illegal-transition' };
  // Parked browse-only by staff (#176): leave it alone, mirroring
  // staff-abandon and staff-decline, which both refuse a view-only quote.
  if (quote.viewOnly) return { action: 'skip', reason: 'already-view-only' };
  return { action: 'archive' };
}
