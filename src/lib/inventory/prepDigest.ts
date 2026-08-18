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
 * The daily Inventory prep digest text. Groups board cards whose fulfillment
 * stage is before 'ready_for_install' by stage (board column order), then
 * "#<job_number> <customer name>" lines, then a link to the board. Nothing
 * waiting ⇒ a one-line all-clear (still sent — a quiet day is worth confirming).
 */
export function prepDigestMessage(cards: FulfillmentCard[], baseUrl: string): string {
  const grouped = groupPrepCards(cards);
  const total = Object.values(grouped).reduce((n, list) => n + (list?.length ?? 0), 0);
  if (total === 0) return '✅ Prep board clear — nothing waiting.';

  const lines = [`📋 Prep board — ${total} job(s) waiting`];
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
  lines.push(`Board → ${baseUrl}/inventory/jobs`);
  return lines.join('\n');
}
