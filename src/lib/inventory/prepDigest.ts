// src/lib/inventory/prepDigest.ts
// PURE message-building for the daily Inventory prep digest cron
// (src/app/api/inventory/prep-digest/route.ts). No IO — the route fetches the
// board cards via listFulfillmentCards() (src/lib/inventory/jobs.ts, the SAME
// function the /inventory/jobs board page's API reads) and passes them in here,
// so the digest and the board can never disagree about what's still waiting.

import { FULFILLMENT_STAGES, FULFILLMENT_STAGE_LABELS, type FulfillmentStage } from './fulfillmentStage';
import type { FulfillmentCard } from './jobs';

// Stages that still need materials prep — every board column before the last
// one. A card in 'ready_for_install' is done prepping; it's excluded here even
// though it's still an active-fulfillment card on the board.
const PREP_STAGES: readonly FulfillmentStage[] = FULFILLMENT_STAGES.filter(
  (s) => s !== 'ready_for_install',
);

// Caps the total job-line count, mirroring telegramMessages.ts's capList
// bullet cap — keeps the message safely under Telegram's 4000-char limit
// without a byte-counting truncator (a stage grouping's job lines run well
// under 100 chars each, so 40 lines stays comfortably clear of the limit).
const MAX_JOB_LINES = 40;

function jobLine(c: FulfillmentCard): string {
  const who = c.customerName?.trim() || 'Customer';
  return `#${c.jobNumber ?? '—'} ${who}`;
}

/**
 * Cards grouped by prep stage, board column order, only stages with cards
 * included. Exported for tests; the route composes prepDigestMessage from the
 * same cards.
 */
export function groupPrepCards(cards: FulfillmentCard[]): Partial<Record<FulfillmentStage, FulfillmentCard[]>> {
  const out: Partial<Record<FulfillmentStage, FulfillmentCard[]>> = {};
  for (const stage of PREP_STAGES) {
    const stageCards = cards.filter((c) => c.stage === stage);
    if (stageCards.length) out[stage] = stageCards;
  }
  return out;
}

/**
 * Row 382: cards stuck at PENDING_STOCK_SNAPSHOT (prepped by current code,
 * but the accurate follow-up snapshot write never landed — see
 * FulfillmentCard.stockSnapshotPending). These have already advanced to
 * 'ready_for_install' by the time this can happen, which is EXCLUDED from
 * PREP_STAGES above — so they need their own pass over every card, not the
 * stage grouping.
 */
export function stuckStockSnapshotCards(cards: FulfillmentCard[]): FulfillmentCard[] {
  return cards.filter((c) => c.stockSnapshotPending);
}

/**
 * The daily Inventory prep digest text. Groups board cards whose fulfillment
 * stage is before 'ready_for_install' by stage (board column order), then
 * "#<job_number> <customer name>" lines, then a link to the board. Nothing
 * waiting ⇒ a one-line all-clear (still sent — a quiet day is worth confirming).
 *
 * Row 382: also lists any job stuck at PENDING_STOCK_SNAPSHOT, regardless of
 * stage — otherwise a job that reached 'ready_for_install' with an unrecorded
 * stock snapshot is invisible here (and everywhere else) forever, discoverable
 * only by opening that specific job.
 */
export function prepDigestMessage(cards: FulfillmentCard[], baseUrl: string): string {
  const grouped = groupPrepCards(cards);
  const total = Object.values(grouped).reduce((n, list) => n + (list?.length ?? 0), 0);
  const stuck = stuckStockSnapshotCards(cards);
  if (total === 0 && stuck.length === 0) return '✅ Prep board clear — nothing waiting.';

  const lines: string[] = [];
  if (total === 0) {
    lines.push('✅ Prep board clear — nothing waiting.');
  } else {
    lines.push(`📋 Prep board — ${total} job(s) waiting`);
    let remaining = MAX_JOB_LINES;
    let omitted = 0;
    for (const stage of PREP_STAGES) {
      const stageCards = grouped[stage];
      if (!stageCards?.length) continue;
      const shown = stageCards.slice(0, Math.max(remaining, 0));
      omitted += stageCards.length - shown.length;
      if (shown.length) {
        lines.push(`${FULFILLMENT_STAGE_LABELS[stage]}:`);
        lines.push(...shown.map(jobLine));
        remaining -= shown.length;
      }
    }
    if (omitted > 0) lines.push(`…and ${omitted} more`);
  }
  if (stuck.length) {
    // Staff-lens fix (MED): this line goes to the least technical audience
    // this app writes to (the staff-configurable Inventory Telegram group),
    // so no table/column names and no claim the deduction is recorded
    // anywhere — just what happened and what to do, plain.
    lines.push(
      `⚠️ ${stuck.length} job(s) prepped but the record of what was taken didn't save — check on-hand against their materials before restocking: ${stuck
        .map(jobLine)
        .join(', ')}`,
    );
  }
  lines.push(`Board → ${baseUrl}/inventory/jobs`);
  return lines.join('\n');
}
