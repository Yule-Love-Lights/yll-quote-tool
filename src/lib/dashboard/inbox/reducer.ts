// The ingest brain: given the existing item state (if any) and a freshly
// normalized touch, decide the row's next state. Pure — composes identity-free
// escalation + auto-resolve. The adapter/route applies the decision to the DB.
//
// Rules (confirmed with Naldo 2026-06-28):
//   • outbound latest message  → auto-resolve (we already replied / we initiated).
//   • inbound on a handled item → reopen, and reset the escalation clock.
//   • dismissed is sticky        → spam stays out, even on a new inbound/outbound.
//   • escalation fires each level once (deduped via notified_levels).

import type { EscalationLevel, InboxStatus, NormalizedTouch } from './types';
import { escalationLevel, isAnsweredByDirection } from './escalation';

export type ExistingItemState = {
  status: InboxStatus;
  notifiedLevels: number[];
  /** When the item's current last message arrived — lets us tell a genuinely-new
   *  inbound (reopen) from the reconcile re-ingesting the SAME message (stay handled). */
  lastMessageAt?: Date | null;
};

export type IngestDecision = {
  status: InboxStatus;
  /** Time-based level NONE|AMBER|RED for display/sorting. Emailing + the
   *  notified_levels dedupe are owned SOLELY by the escalate cron — ingest must
   *  never advance notified_levels for a level it didn't email, or the cron would
   *  skip that alert. */
  escalationLevel: EscalationLevel;
  /** True when this touch auto-resolved an open item (outbound reply). */
  autoResolved: boolean;
  /** True when an inbound reopened a previously-handled item. */
  reopened: boolean;
};

export function decideInboxState(input: {
  existing: ExistingItemState | null;
  touch: NormalizedTouch;
  now: Date;
}): IngestDecision {
  const { existing, touch, now } = input;

  // Dismissed is sticky — never resurrect spam.
  if (existing?.status === 'dismissed') {
    return { status: 'dismissed', escalationLevel: 0, autoResolved: false, reopened: false };
  }

  // Outbound latest message → answered → auto-resolve.
  if (isAnsweredByDirection(touch.direction)) {
    return { status: 'handled', escalationLevel: 0, autoResolved: existing?.status !== 'handled', reopened: false };
  }

  // Inbound + unanswered. Reopen a handled item ONLY when a genuinely NEW inbound
  // arrived since we handled it. The reconcile cron re-ingests the same
  // conversation every run, so without this guard a handled item reopens on the
  // SAME message it was handled for (the bug). (On reopen the escalate cron resets
  // the clock when notified_levels is cleared — see store.planIngest.)
  const wasHandled = existing?.status === 'handled';
  if (wasHandled) {
    const newerInbound =
      existing?.lastMessageAt == null || touch.lastMessageAt.getTime() > existing.lastMessageAt.getTime();
    if (!newerInbound) {
      return { status: 'handled', escalationLevel: 0, autoResolved: false, reopened: false };
    }
  }
  return {
    status: 'unresponded',
    escalationLevel: escalationLevel(touch.lastMessageAt, now),
    autoResolved: false,
    reopened: wasHandled,
  };
}
