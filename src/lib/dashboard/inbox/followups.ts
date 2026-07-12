// Follow-up logic — "due today" (pinned in the top strip) and the system-created
// follow-ups (e.g. a quote was sent and got no reply). Pure: the day boundary is
// America/New_York and `now` is passed in, so it's deterministic + testable.
//
// WIRED: runQuoteToolReconcile (sync.ts) calls quoteFollowUpDecision then
// store.ts's ensureFollowUp, which calls quoteSentNoReplyFollowUp below.
//
// ⚠️ WT-44 (partial): the /inbox "Follow-up reminder (days)" setting
// (getFollowUpDays, settings.ts) is NOT yet threaded into that chain —
// store.ts's ensureFollowUp doesn't accept an afterDays override, so every
// created follow-up still uses DEFAULT_FOLLOW_UP_DAYS below regardless of the
// setting. Closing this needs a small additive change to ensureFollowUp
// (accept `afterDays?: number`, forward it here) — out of scope for a
// sync.ts/followups.ts-only fix since store.ts is owned by another task.

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
