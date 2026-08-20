// Tests for the pure seam extracted out of the new-quote lead-prefill page
// (#243) — no component-render test infra exists in this repo for an async
// server component (see pay-balance/page.test.ts's own note; same
// extraction pattern).

import { describe, it, expect } from 'vitest';
import { resolvePrefillTags } from './page';

describe('resolvePrefillTags (#243)', () => {
  it('carries a tagged customer\'s tags through for a holiday quote', () => {
    expect(resolvePrefillTags('holiday', { is_nce: true, is_yll_neighbor: true })).toEqual({
      isNce: true,
      legacyRebook: true,
    });
  });

  it('carries a tagged customer\'s tags through when serviceType is omitted (defaults to holiday)', () => {
    expect(resolvePrefillTags(undefined, { is_nce: true, is_yll_neighbor: true })).toEqual({
      isNce: true,
      legacyRebook: true,
    });
  });

  it('carries a tagged customer\'s FALSE tags through unchanged for a holiday quote', () => {
    expect(resolvePrefillTags('holiday', { is_nce: false, is_yll_neighbor: false })).toEqual({
      isNce: false,
      legacyRebook: false,
    });
  });

  it.each([['permanent'], ['event'], ['permanent_bistro']])(
    'never carries a tagged customer\'s NCE/Neighbor tags onto a %s quote, even though the customer IS tagged',
    (serviceType) => {
      expect(resolvePrefillTags(serviceType, { is_nce: true, is_yll_neighbor: true })).toEqual({});
    },
  );

  it('resolves to no tags at all when there is no tagged customer (no ghlContactId match)', () => {
    expect(resolvePrefillTags('holiday', null)).toEqual({ isNce: undefined, legacyRebook: undefined });
  });

  it('ignores a garbage/unrecognized serviceType param the same way asServiceType does — defaults to holiday', () => {
    expect(resolvePrefillTags('not-a-real-type', { is_nce: true, is_yll_neighbor: true })).toEqual({
      isNce: true,
      legacyRebook: true,
    });
  });
});
