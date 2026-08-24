// Follow-up logic: "due today" (pinned in the top strip) and the system-created
// follow-ups (e.g. a quote was sent and got no reply). Pure: the day boundary is
// America/New_York and `now` is passed in, so it's deterministic + testable.
//
// WIRED: runQuoteToolReconcile (sync.ts) reads the /inbox "Follow-up reminder
// (days)" setting (getFollowUpDays, settings.ts) once per reconcile and passes
// it as `afterDays` into store.ts's ensureFollowUp, which forwards it to
// quoteSentNoReplyFollowUp below. So the setting drives the strip cadence
// (WT-44 fully threaded); DEFAULT_FOLLOW_UP_DAYS is only the fallback.

import type { NewFollowUp } from './types';
import { etDayKey } from './normalize';

/** Canonical reasons for system-created follow-ups. */
export const FOLLOWUP_REASONS = {
  quoteSentNoReply: 'quote_sent_no_reply',
} as const;

/** Fallback cadence when no explicit `afterDays` is given (matches the /inbox
 *  "Follow-up reminder (days)" setting's own fallback — see settings.ts). */
export const DEFAULT_FOLLOW_UP_DAYS = 3;

/**
 * True when a follow-up should appear in today's strip: its due date is the
 * current ET calendar day OR earlier (overdue follow-ups keep surfacing rather
 * than silently disappearing).
 */
export function isDueToday(dueAt: Date, now: Date): boolean {
  return etDayKey(dueAt) <= etDayKey(now);
}

/** Pending follow-ups that are due today or overdue, in input order. */
export function dueFollowUps<T extends { status: string; dueAt: Date }>(items: T[], now: Date): T[] {
  return items.filter((f) => f.status === 'pending' && isDueToday(f.dueAt, now));
}

/** Row 385 (Jason's ruling, 2026-08-24): how long a HANDLED item must sit quiet
 *  before its nag is allowed back. Distinct from DEFAULT_FOLLOW_UP_DAYS, which
 *  times the FIRST nudge after a quote goes out; this times the RE-chase after
 *  staff have already replied once. */
export const RECHASE_QUIET_DAYS = 7;

/**
 * Whether a HANDLED item's follow-up may re-arm, given how long it has been
 * quiet. PURE — `now` is passed in, so it is deterministic and testable.
 *
 * The gap this closes (row 385, flagged by S48's #928 delta-verify): row 287(b)
 * made `ensureFollowUp` skip 'handled' items, because the reconcile re-requests
 * a follow-up on EVERY tick and a Done nag was re-arming within five minutes —
 * the "Done button is broken" symptom. Two escape hatches keep that from
 * silencing a live conversation: a genuinely-new inbound reopens the item to
 * 'unresponded' (reducer.ts's `reopened` branch, so a 'handled' status really
 * does mean the customer has not written since), and the quote reaching a
 * terminal status closes the nag through quoteFollowUpDecision's 'close' branch,
 * which never reads item status at all. A third case fell outside both: staff
 * replied once, the customer went quiet, and the quote never resolved. Nothing
 * re-chased it, ever.
 *
 * THE ANCHOR IS THE NAG'S OWN LAST-TOUCHED TIME, NOT `handled_at`, and that is
 * the whole design. Anchoring on `handled_at` re-creates the very bug row 287(b)
 * fixed: once an item had been handled longer than the window, clicking Done
 * would be undone on the next tick five minutes later, forever, because
 * `handled_at` never moves. `follow_ups.updated_at` DOES move — the table has a
 * `before update` trigger (dashboard_set_updated_at) — so every Done buys a
 * fresh, full quiet window, and the re-chase settles into a weekly cadence
 * instead of a five-minute loop. Falls back to the item's `handledAt` only when
 * no nag row exists yet to anchor on.
 *
 * Returns false when there is no anchor at all: with no basis to measure silence
 * from, the conservative answer is to leave the item alone.
 */
export function mayReChaseHandled(input: {
  /** `follow_ups.updated_at` for this (item, reason) — when the nag was last touched. */
  lastNudgeAt: Date | null;
  /** `inbox_items.handled_at` — the fallback anchor when no nag row exists. */
  handledAt: Date | null;
  now: Date;
  quietDays?: number;
}): boolean {
  const anchor = input.lastNudgeAt ?? input.handledAt;
  if (!anchor) return false;
  const anchorMs = anchor.getTime();
  if (!Number.isFinite(anchorMs)) return false;
  const quietDays = input.quietDays ?? RECHASE_QUIET_DAYS;
  return input.now.getTime() - anchorMs >= quietDays * 86_400_000;
}

/**
 * Build the "quote sent, no reply" follow-up: due `afterDays` (default 3) after
 * the quote went out. System-created → no creator/assignee (shared queue).
 */
export function quoteSentNoReplyFollowUp(input: {
  contactId: string | null;
  inboxItemId: string | null;
  sentAt: Date;
  afterDays?: number;
}): NewFollowUp {
  const afterDays = input.afterDays ?? DEFAULT_FOLLOW_UP_DAYS;
  return {
    contactId: input.contactId,
    inboxItemId: input.inboxItemId,
    dueAt: new Date(input.sentAt.getTime() + afterDays * 86_400_000),
    reason: FOLLOWUP_REASONS.quoteSentNoReply,
    status: 'pending',
    assignedTo: null,
    createdBy: null,
  };
}
