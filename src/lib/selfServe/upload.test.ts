// Premerge technical lens on PR #997 found that this file's zeroed input set
// hardcoded 'medium' for both roofline types. It is NOT inert: the value is
// stored explicitly on the draft, so `inputsToFormData`'s
// `?? rooflineDefaultDifficulty` fallback never fires and staff reopening the
// draft see Medium $10/ft pre-selected — the exact "nobody decided this" state
// the always-Easy rule exists to prevent. Pinned here so it cannot come back.

import { describe, it, expect } from 'vitest';
import { EMPTY_HOLIDAY_INPUTS } from './upload';
import { BUSINESS_RULES } from '@/lib/pricing/pricingEngine';

describe('self-serve upload draft inputs', () => {
  it('starts both roofline types at the ONE shared default, not a second literal', () => {
    expect(EMPTY_HOLIDAY_INPUTS.santasDifficulty).toBe(BUSINESS_RULES.rooflineDefaultDifficulty);
    expect(EMPTY_HOLIDAY_INPUTS.gingerbreadDifficulty).toBe(BUSINESS_RULES.rooflineDefaultDifficulty);
    expect(EMPTY_HOLIDAY_INPUTS.santasDifficulty).toBe('easy');
  });

  it('is still a fully-zeroed set — this draft carries no measurement', () => {
    // Guards the reason the difficulty looked inert in the first place, so a
    // future edit that adds footage here has to break a named test.
    expect(EMPTY_HOLIDAY_INPUTS.santasFootage).toBe(0);
    expect(EMPTY_HOLIDAY_INPUTS.gingerbreadFootage).toBe(0);
  });
});
