import { describe, it, expect } from 'vitest';
import {
  mayReChaseHandled,
  RECHASE_QUIET_DAYS, isDueToday, dueFollowUps, quoteSentNoReplyFollowUp, FOLLOWUP_REASONS, DEFAULT_FOLLOW_UP_DAYS } from './followups';

describe('isDueToday — evaluated in America/New_York', () => {
  it('is true for a follow-up due later the same ET day', () => {
    // due 16:00 EDT, now 17:00 EDT — same ET day.
    expect(isDueToday(new Date('2026-06-28T20:00:00Z'), new Date('2026-06-28T21:00:00Z'))).toBe(true);
  });
  it('is true for an overdue follow-up (past ET day still surfaces)', () => {
    expect(isDueToday(new Date('2026-06-27T13:00:00Z'), new Date('2026-06-28T13:00:00Z'))).toBe(true);
  });
  it('is false for a follow-up due a future ET day', () => {
    expect(isDueToday(new Date('2026-06-30T13:00:00Z'), new Date('2026-06-28T13:00:00Z'))).toBe(false);
  });
  it('uses the ET calendar day, not the UTC day', () => {
    // both instants are 2026-06-28 in ET (22:00 and 23:00 EDT) though UTC is the 29th.
    expect(isDueToday(new Date('2026-06-29T02:00:00Z'), new Date('2026-06-29T03:00:00Z'))).toBe(true);
  });
});

describe('dueFollowUps — pending + due-today only', () => {
  const now = new Date('2026-06-28T16:00:00Z');
  const today = new Date('2026-06-28T15:00:00Z');
  const future = new Date('2026-07-05T15:00:00Z');
  const overdue = new Date('2026-06-20T15:00:00Z');
  const items = [
    { id: 'a', status: 'pending', dueAt: today },
    { id: 'b', status: 'done', dueAt: today }, // excluded — not pending
    { id: 'c', status: 'pending', dueAt: future }, // excluded — not yet due
    { id: 'd', status: 'pending', dueAt: overdue }, // included — overdue
  ];
  it('returns only pending follow-ups that are due today or overdue', () => {
    expect(dueFollowUps(items, now).map((f) => f.id)).toEqual(['a', 'd']);
  });
});

describe('quoteSentNoReplyFollowUp — system-created follow-up', () => {
  const sentAt = new Date('2026-06-28T15:00:00Z');
  const DAY = 86_400_000;
  it('is due 3 days after the quote was sent, with the system reason and no creator', () => {
    const fu = quoteSentNoReplyFollowUp({ contactId: 'c1', inboxItemId: 'i1', sentAt });
    expect(fu.reason).toBe(FOLLOWUP_REASONS.quoteSentNoReply);
    expect(fu.reason).toBe('quote_sent_no_reply');
    expect(fu.status).toBe('pending');
    expect(fu.dueAt.getTime()).toBe(sentAt.getTime() + 3 * DAY);
    expect(fu.contactId).toBe('c1');
    expect(fu.inboxItemId).toBe('i1');
    expect(fu.createdBy).toBeNull();
    expect(fu.assignedTo).toBeNull();
  });
  it('honors a custom afterDays', () => {
    const fu = quoteSentNoReplyFollowUp({ contactId: null, inboxItemId: null, sentAt, afterDays: 5 });
    expect(fu.dueAt.getTime()).toBe(sentAt.getTime() + 5 * DAY);
  });
  it('falls back to DEFAULT_FOLLOW_UP_DAYS (3) — not a bare literal — when afterDays is omitted', () => {
    expect(DEFAULT_FOLLOW_UP_DAYS).toBe(3);
    const fu = quoteSentNoReplyFollowUp({ contactId: null, inboxItemId: null, sentAt });
    expect(fu.dueAt.getTime()).toBe(sentAt.getTime() + DEFAULT_FOLLOW_UP_DAYS * DAY);
  });
  it('cadence follows a configured value end-to-end (not hardcoded) — the value getFollowUpDays would supply', () => {
    // Simulates the configured setting (settings.ts's getFollowUpDays) being
    // threaded in as afterDays, proving the pure function's cadence is fully
    // caller-controlled rather than pinned to the hardcoded default.
    const configuredDays = 10;
    const fu = quoteSentNoReplyFollowUp({ contactId: 'c1', inboxItemId: 'i1', sentAt, afterDays: configuredDays });
    expect(fu.dueAt.getTime()).toBe(sentAt.getTime() + configuredDays * DAY);
    expect(fu.dueAt.getTime()).not.toBe(sentAt.getTime() + DEFAULT_FOLLOW_UP_DAYS * DAY);
  });
});
// Row 385 — the handled-but-quiet re-chase window. PURE, so `now` is injected.
describe('mayReChaseHandled', () => {
  const at = (isoDaysAgo: number) => new Date(Date.now() - isoDaysAgo * 86_400_000);
  const now = new Date();

  it('re-chases once the nag has sat untouched for the quiet window', () => {
    expect(mayReChaseHandled({ lastNudgeAt: at(8), handledAt: at(9), now })).toBe(true);
  });

  it('stays quiet while the window is still running', () => {
    expect(mayReChaseHandled({ lastNudgeAt: at(1), handledAt: at(9), now })).toBe(false);
  });

  // The anchor choice IS the design: the nag's own last-touched time, not
  // handled_at. handled_at never moves, so anchoring on it would undo every Done
  // click on the next reconcile tick — the bug row 287(b) fixed. This pins that a
  // RECENT nudge beats an ANCIENT handled_at.
  it('lets a recent nudge beat a much older handled_at', () => {
    expect(mayReChaseHandled({ lastNudgeAt: at(0), handledAt: at(365), now })).toBe(false);
  });

  it('falls back to handled_at only when there is no nudge to anchor on', () => {
    expect(mayReChaseHandled({ lastNudgeAt: null, handledAt: at(8), now })).toBe(true);
    expect(mayReChaseHandled({ lastNudgeAt: null, handledAt: at(2), now })).toBe(false);
  });

  it('stays quiet when there is no anchor at all (no basis to measure silence)', () => {
    expect(mayReChaseHandled({ lastNudgeAt: null, handledAt: null, now })).toBe(false);
  });

  it('stays quiet on an unparseable anchor rather than re-chasing blindly', () => {
    expect(mayReChaseHandled({ lastNudgeAt: new Date('nonsense'), handledAt: null, now })).toBe(false);
  });

  it('fires exactly ON the boundary, not a day late', () => {
    const exactly = new Date(now.getTime() - RECHASE_QUIET_DAYS * 86_400_000);
    expect(mayReChaseHandled({ lastNudgeAt: exactly, handledAt: null, now })).toBe(true);
  });

  it('honours an explicit quietDays override', () => {
    expect(mayReChaseHandled({ lastNudgeAt: at(3), handledAt: null, now, quietDays: 2 })).toBe(true);
    expect(mayReChaseHandled({ lastNudgeAt: at(3), handledAt: null, now, quietDays: 30 })).toBe(false);
  });
});
