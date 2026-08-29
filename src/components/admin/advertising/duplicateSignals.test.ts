// Ops suggestions round: the review queue's duplicate panel splits STRONG
// signals (a GPS distance or a shared address, worth photos and eyes) from
// the WEAK worker-day-only matches, which grow linearly with a worker's
// daily volume (30 signs a day = 29 weak matches per sign) and would drown
// the panel.

import { describe, it, expect } from 'vitest';
import { splitDuplicateSignals } from './duplicateSignals';

const dup = (reasons: string[]) => ({ id: reasons.join('|'), reasons });

describe('splitDuplicateSignals', () => {
  it('keeps distance matches in the strong list', () => {
    const { strong, weakCount } = splitDuplicateSignals([dup(['31m away', 'same worker, same day'])]);
    expect(strong).toHaveLength(1);
    expect(weakCount).toBe(0);
  });

  it('keeps shared-address matches in the strong list', () => {
    const { strong, weakCount } = splitDuplicateSignals([dup(['same suggested address'])]);
    expect(strong).toHaveLength(1);
    expect(weakCount).toBe(0);
  });

  it('collapses worker-day-only matches into the weak list, preserving every candidate', () => {
    const rows = [
      dup(['same worker, same day']),
      dup(['same worker, same day']),
      dup(['12m away', 'same suggested address', 'same worker, same day']),
    ];
    const { strong, weak, weakCount } = splitDuplicateSignals(rows);
    expect(strong).toHaveLength(1);
    expect(weak).toHaveLength(2);
    expect(weakCount).toBe(2);
    // Nothing is ever dropped (admin lens: the weak list must stay reachable,
    // a re-placed sign can carry only the worker-day reason).
    expect(strong.length + weak.length).toBe(rows.length);
  });

  it('handles the empty list', () => {
    const { strong, weak, weakCount } = splitDuplicateSignals([]);
    expect(strong).toHaveLength(0);
    expect(weak).toHaveLength(0);
    expect(weakCount).toBe(0);
  });
});
