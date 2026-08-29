// Ops suggestions round: a worker's pending money is estimated at the
// campaign's CURRENT rate, so a mid-week rate edit silently moves the number
// on their phone. This pure check decides whether any of the worker's
// pending rows were captured BEFORE a later rate change, which is exactly
// when the "rate changed since you placed these" note is honest.

import { describe, it, expect } from 'vitest';
import { hasPendingRateChange } from './rateChangeNote';

const row = (campaignId: string, at: string) => ({ campaignId, at });
const ev = (campaignId: string, createdAt: string) => ({ campaignId, createdAt });

describe('hasPendingRateChange', () => {
  it('true when a rate changed after a pending row was captured', () => {
    expect(
      hasPendingRateChange([row('c1', '2026-08-25T10:00:00Z')], [ev('c1', '2026-08-27T10:00:00Z')]),
    ).toBe(true);
  });

  it('false when the rate change happened before capture (the worker saw the new rate all along)', () => {
    expect(
      hasPendingRateChange([row('c1', '2026-08-28T10:00:00Z')], [ev('c1', '2026-08-27T10:00:00Z')]),
    ).toBe(false);
  });

  it('false when the change is on a different campaign', () => {
    expect(
      hasPendingRateChange([row('c1', '2026-08-25T10:00:00Z')], [ev('c2', '2026-08-27T10:00:00Z')]),
    ).toBe(false);
  });

  it('false with no pending rows or no events', () => {
    expect(hasPendingRateChange([], [ev('c1', '2026-08-27T10:00:00Z')])).toBe(false);
    expect(hasPendingRateChange([row('c1', '2026-08-25T10:00:00Z')], [])).toBe(false);
  });

  it('ignores rows or events with unparseable times instead of guessing', () => {
    expect(hasPendingRateChange([row('c1', 'garbage')], [ev('c1', '2026-08-27T10:00:00Z')])).toBe(false);
    expect(hasPendingRateChange([row('c1', '2026-08-25T10:00:00Z')], [ev('c1', 'garbage')])).toBe(false);
  });
});
