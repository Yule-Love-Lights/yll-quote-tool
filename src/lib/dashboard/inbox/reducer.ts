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
import { escalationLevel, isAnsweredByDirection, newlyCrossedLevel } from './escalation';

export type ExistingItemState = {
  status: InboxStatus;
  notifiedLevels: number[];
};

export type IngestDecision = {
  status: InboxStatus;
  /** Time-based level NONE|AMBER|RED for this item right now. */
  escalationLevel: EscalationLevel;
  /** A level to email right now (newly crossed + not yet notified), else null. */
  notifyLevel: number | null;
  /** notified_levels to persist after this decision. */
  notifiedLevels: number[];
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
    return {
      status: 'dismissed',
      escalationLevel: 0,
      notifyLevel: null,
      notifiedLevels: existing.notifiedLevels,
      autoResolved: false,
      reopened: false,
    };
  }

  // Outbound latest message → answered → auto-resolve.
  if (isAnsweredByDirection(touch.direction)) {
    return {
      status: 'handled',
      escalationLevel: 0,
      notifyLevel: null,
      notifiedLevels: [],
      autoResolved: existing?.status !== 'handled',
      reopened: false,
    };
  }

  // Inbound + unanswered. Reopen a handled item (fresh escalation clock).
  const reopened = existing?.status === 'handled';
  const base = reopened ? [] : (existing?.notifiedLevels ?? []);
  const level = escalationLevel(touch.lastMessageAt, now);
  const notifyLevel = newlyCrossedLevel(touch.lastMessageAt, now, base);
  const notifiedLevels = notifyLevel != null ? [...base, notifyLevel] : base;

  return {
    status: 'unresponded',
    escalationLevel: level,
    notifyLevel,
    notifiedLevels,
    autoResolved: false,
    reopened,
  };
}
