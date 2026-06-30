import { describe, it, expect } from 'vitest';
import {
  escalationLevel,
  newlyCrossedLevel,
  isDueForEodDigest,
  isAnsweredByOutbound,
  isAnsweredByDirection,
} from './escalation';

const HOUR = 3_600_000;
const base = new Date('2026-06-28T15:00:00Z');
const plus = (ms: number) => new Date(base.getTime() + ms);

describe('escalationLevel — amber > 1h, red > 4h', () => {
  it('is NONE (0) under an hour', () => {
    expect(escalationLevel(base, plus(30 * 60_000))).toBe(0);
  });
  it('is AMBER (1) at exactly 1h and up to 4h', () => {
    expect(escalationLevel(base, plus(1 * HOUR))).toBe(1);
    expect(escalationLevel(base, plus(3 * HOUR))).toBe(1);
  });
  it('is RED (2) at exactly 4h and beyond', () => {
    expect(escalationLevel(base, plus(4 * HOUR))).toBe(2);
    expect(escalationLevel(base, plus(10 * HOUR))).toBe(2);
  });
});

describe('newlyCrossedLevel — email each level once (dedupe via notified_levels)', () => {
  it('returns the level when it has not been notified yet', () => {
    expect(newlyCrossedLevel(base, plus(2 * HOUR), [])).toBe(1);
    expect(newlyCrossedLevel(base, plus(5 * HOUR), [1])).toBe(2);
  });
  it('returns null when the current level was already notified', () => {
    expect(newlyCrossedLevel(base, plus(2 * HOUR), [1])).toBeNull();
  });
  it('returns null when below amber (nothing to send)', () => {
    expect(newlyCrossedLevel(base, plus(30 * 60_000), [])).toBeNull();
  });
});

describe('isDueForEodDigest — end-of-day sweep in America/New_York', () => {
  // lastMessage 2026-06-28T13:00Z = 09:00 EDT (morning).
  const msg = new Date('2026-06-28T13:00:00Z');
  it('is false before the ET end-of-day cutoff (same ET day)', () => {
    // 2026-06-28T20:00Z = 16:00 EDT (4pm) — aged 7h but before 5pm cutoff.
    expect(isDueForEodDigest(msg, new Date('2026-06-28T20:00:00Z'))).toBe(false);
  });
  it('is true at/after the ET end-of-day cutoff (same ET day)', () => {
    // 2026-06-28T21:00Z = 17:00 EDT (5pm).
    expect(isDueForEodDigest(msg, new Date('2026-06-28T21:00:00Z'))).toBe(true);
  });
  it('is true once it rolls into a later ET day (persists across midnight)', () => {
    // 2026-06-29T14:00Z = 10:00 EDT on the 29th.
    expect(isDueForEodDigest(msg, new Date('2026-06-29T14:00:00Z'))).toBe(true);
  });
  it('does NOT sweep a message that only just arrived before the cutoff', () => {
    // arrived 16:55 EDT, now 17:00 EDT → 5 min old, not genuinely pending.
    const justNow = new Date('2026-06-28T20:55:00Z');
    expect(isDueForEodDigest(justNow, new Date('2026-06-28T21:00:00Z'))).toBe(false);
  });
});

describe('isAnsweredByOutbound — outbound after last inbound clears the item', () => {
  it('is true when an outbound message follows the last inbound', () => {
    expect(
      isAnsweredByOutbound({
        lastInboundAt: new Date('2026-06-28T10:00:00Z'),
        lastOutboundAt: new Date('2026-06-28T11:00:00Z'),
      }),
    ).toBe(true);
  });
  it('is false when the last outbound predates the last inbound', () => {
    expect(
      isAnsweredByOutbound({
        lastInboundAt: new Date('2026-06-28T12:00:00Z'),
        lastOutboundAt: new Date('2026-06-28T11:00:00Z'),
      }),
    ).toBe(false);
  });
  it('is false when there is no outbound at all', () => {
    expect(isAnsweredByOutbound({ lastInboundAt: new Date('2026-06-28T10:00:00Z'), lastOutboundAt: null })).toBe(false);
  });
  it('is true for an outbound with no prior inbound (we initiated)', () => {
    expect(isAnsweredByOutbound({ lastInboundAt: null, lastOutboundAt: new Date('2026-06-28T11:00:00Z') })).toBe(true);
  });
});

describe('isAnsweredByDirection — GHL conversation-level signal (spike finding)', () => {
  it('treats a last outbound direction as answered', () => {
    expect(isAnsweredByDirection('outbound')).toBe(true);
  });
  it('treats inbound / missing as not answered', () => {
    expect(isAnsweredByDirection('inbound')).toBe(false);
    expect(isAnsweredByDirection(null)).toBe(false);
    expect(isAnsweredByDirection(undefined)).toBe(false);
  });
});
