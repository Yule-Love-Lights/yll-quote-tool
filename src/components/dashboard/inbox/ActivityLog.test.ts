import { describe, it, expect } from 'vitest';
import {
  friendlyAction,
  friendlyAutoReason,
  isPermanentReverseRefusal,
  reverseCompletedConfirmMessage,
  reverseDismissedConfirmMessage,
  requiresReverseConfirmation,
  reverseConfirmMessage,
  withRowFlagSet,
  withRowFlagCleared,
} from './ActivityLog';

// row 312(b): the 26 S41 'reclassified' data-op rows rendered as the raw
// action string — no ACTION_LABEL entry existed. Pure-function test only
// (no jsdom in this project — see InWorksSection.test.tsx's own note).
describe('friendlyAction', () => {
  it('labels reclassified (row 312b)', () => {
    expect(friendlyAction('reclassified')).toBe('Reclassified');
  });
  it('falls through to the raw string for an unmapped action', () => {
    expect(friendlyAction('some_future_action')).toBe('some_future_action');
  });
  it('still labels the pre-existing reversible actions', () => {
    expect(friendlyAction('handled')).toBe('Handled');
    expect(friendlyAction('followed')).toBe('Followed up');
    expect(friendlyAction('completed')).toBe('Completed');
    expect(friendlyAction('dismissed')).toBe('Not a lead');
    expect(friendlyAction('reversed')).toBe('Reversed');
  });

  // Row 320(e): color-change-request/route.ts's staff-email failure now writes
  // the generic action_failed shape with detail.action='color_request_email'
  // (friendlyAction(row.detail.action) reads this same map) — and the OLD
  // top-level literal it used to write directly stays labelled too, so
  // historical rows already in dashboard_activity keep rendering.
  it('labels the reconciled color_request_email verb and keeps the legacy top-level literal labelled', () => {
    expect(friendlyAction('color_request_email')).toBe('Colour-change staff email');
    expect(friendlyAction('color_request_email_failed')).toBe('Colour-change staff email failed');
  });
});

// row 317 fix-round FIX 4 (staff LOW): ActivityRow.autoReason (store.ts) only
// ever carries a value listActivity actually produces — 'quote_terminal' from
// completeTerminalQuoteItems today. Pure-function test only (no jsdom — see
// this file's header note above).
describe('friendlyAutoReason (row 317 fix-round FIX 4)', () => {
  it('labels quote_terminal', () => {
    expect(friendlyAutoReason('quote_terminal')).toBe('quote booked/declined/abandoned');
  });
  it('falls through to the raw string for an unmapped reason', () => {
    expect(friendlyAutoReason('some_future_reason')).toBe('some_future_reason');
  });
});

// row 312 fix-round FIX 5(c): a permanent refusal (wrong-occurrence guard, the
// stillMatches pre-check, the FIX-1 CAS, or the FIX-3 payload gate) should
// disable the Reverse button on retry; a transient one should not. Pure-
// function test only (no jsdom — see the file header note above).
describe('isPermanentReverseRefusal (row 312 fix-round FIX 5c)', () => {
  it('flags the wrong-occurrence guard refusal (312c) as permanent', () => {
    expect(isPermanentReverseRefusal('A later action already changed this item; nothing to reverse from here')).toBe(true);
  });
  it('flags the stillMatches / FIX-1 CAS staleness refusal as permanent', () => {
    expect(isPermanentReverseRefusal('Item state has changed since this action; nothing to reverse')).toBe(true);
  });
  it('flags the FIX-3 payload-gate refusal as permanent', () => {
    expect(isPermanentReverseRefusal('This entry cannot be reversed')).toBe(true);
  });
  it('does NOT flag a transient/config error as permanent (worth retrying)', () => {
    expect(isPermanentReverseRefusal('Supabase service role not configured')).toBe(false);
    expect(isPermanentReverseRefusal('Network error — try again.')).toBe(false);
    expect(isPermanentReverseRefusal('Could not verify this is the latest action for this item — try again')).toBe(false);
  });
});

// Row 305 (WRAP TECHNICAL LENS widening): withRowFlagSet/withRowFlagCleared
// are the exact pure primitives handleReverse now calls to read/write the
// per-row busyIds map, replacing the single-slot `busyId` that let reversing
// row B re-enable row A's Reverse button mid-flight. Mirrors
// InboxList.test.tsx / InWorksSection.test.tsx's own coverage of their
// identical local copies.
describe('withRowFlagSet / withRowFlagCleared (row 305 — per-row busy map)', () => {
  it('setting the flag for two different row ids leaves both present simultaneously', () => {
    let busyIds: Record<string, boolean> = {};
    busyIds = withRowFlagSet(busyIds, 'rowA');
    busyIds = withRowFlagSet(busyIds, 'rowB');
    expect(busyIds).toEqual({ rowA: true, rowB: true });
  });

  it('clearing one row\'s flag leaves another row\'s entry untouched — the fix for "reversing B re-enables A mid-flight"', () => {
    let busyIds: Record<string, boolean> = { rowA: true, rowB: true };
    busyIds = withRowFlagCleared(busyIds, 'rowB');
    expect(busyIds).toEqual({ rowA: true }); // rowA (still in flight) stays disabled
  });

  it('clearing a flag for an id that was never set is a no-op that returns the SAME object reference', () => {
    const busyIds: Record<string, boolean> = { rowA: true };
    expect(withRowFlagCleared(busyIds, 'rowB')).toBe(busyIds);
  });
});

// Row 320(g): the /inbox/activity Reverse button had no confirm at all for a
// 'completed' row — the ONLY warning that a Reverse doesn't re-open a closed
// follow-up nag lived in InWorksSection's manual Mark-completed confirm,
// which an auto-completed row (no needsLookReason gate) never passes through.
describe('reverseCompletedConfirmMessage (row 320g)', () => {
  it('names both halves honestly: the status change reverses, the follow-up nag does not', () => {
    const msg = reverseCompletedConfirmMessage().toLowerCase();
    expect(msg).toContain('does not re-open');
    expect(msg).toContain('follow-up');
  });
});

// Finding 2 (sibling-guard parity): dismissItem closes a pending follow-up
// nag exactly like markItemCompleted does, and reverseItemState never
// restores follow_ups on either path — the row-320(g) confirm covered only
// 'completed' and missed this identically-shaped sibling.
describe('requiresReverseConfirmation (Finding 2)', () => {
  it('requires confirmation for both completed and dismissed', () => {
    expect(requiresReverseConfirmation('completed')).toBe(true);
    expect(requiresReverseConfirmation('dismissed')).toBe(true);
  });
  it('does not require confirmation for actions with no follow-up-nag side effect', () => {
    expect(requiresReverseConfirmation('handled')).toBe(false);
    expect(requiresReverseConfirmation('followed')).toBe(false);
    expect(requiresReverseConfirmation('reclassified')).toBe(false);
  });
});

describe('reverseDismissedConfirmMessage (Finding 2)', () => {
  it('names both halves honestly: the dismissal reverses (and un-suppresses the sender), the follow-up nag does not', () => {
    const msg = reverseDismissedConfirmMessage().toLowerCase();
    expect(msg).toContain('does not re-open');
    expect(msg).toContain('follow-up');
    expect(msg).toContain('un-suppresses');
  });
  // 'completed' has no unsuppress analog (inverseOf('completed', ...) always
  // sets unsuppress:false, lifecycle.ts) — the two messages must differ, not
  // share one generic string that overclaims for 'completed'.
  it('is worded differently from the completed message (dismissed restores suppression, completed does not)', () => {
    expect(reverseDismissedConfirmMessage()).not.toBe(reverseCompletedConfirmMessage());
  });
});

describe('reverseConfirmMessage dispatch (Finding 2)', () => {
  it('routes dismissed to the dismissed-specific wording', () => {
    expect(reverseConfirmMessage('dismissed')).toBe(reverseDismissedConfirmMessage());
  });
  it('routes completed (and anything else) to the completed wording', () => {
    expect(reverseConfirmMessage('completed')).toBe(reverseCompletedConfirmMessage());
  });
});
