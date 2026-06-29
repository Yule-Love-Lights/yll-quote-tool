import { describe, it, expect } from 'vitest';
import { newlyLowSkus } from './lowStockNotify';

describe('newlyLowSkus', () => {
  it('returns SKUs that are low now but were not in the last-notified set', () => {
    expect(newlyLowSkus(['a', 'b'], ['a'])).toEqual(['b']);
  });

  it('returns nothing when the low set is unchanged (no re-nag)', () => {
    expect(newlyLowSkus(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('re-pings a SKU that recovered (dropped from last) and went low again', () => {
    // recovered → last-notified no longer includes it → low again counts as new
    expect(newlyLowSkus(['a'], [])).toEqual(['a']);
  });

  it('ignores SKUs that recovered (in last, no longer low)', () => {
    expect(newlyLowSkus([], ['a', 'b'])).toEqual([]);
  });

  it('preserves the order of the current low list', () => {
    expect(newlyLowSkus(['c', 'a', 'b'], ['a'])).toEqual(['c', 'b']);
  });
});
