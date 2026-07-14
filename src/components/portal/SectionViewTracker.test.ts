// Tests for the pure seams extracted out of SectionViewTracker (PostHog Wave
// 4 — no component-render test infra exists in this repo; see
// StickyBottomBar.test.ts's buildApprovePayload for the same extraction
// pattern). Covers (a) the section_viewed property contract across all six
// mount sites, and (b) the one-shot latch guard the IntersectionObserver
// callback relies on.

import { describe, it, expect } from 'vitest';
import { buildSectionViewedProperties, shouldFireSectionView } from './SectionViewTracker';

describe('buildSectionViewedProperties (PostHog Wave 4)', () => {
  const SECTIONS = [
    'walkthrough_video',
    'whats_included',
    'warranty',
    'reviews',
    'gallery',
    'cross_sell',
  ] as const;

  it.each(SECTIONS)('builds the section_viewed payload for "%s"', (section) => {
    expect(buildSectionViewedProperties('quote-123', 'holiday', section)).toEqual({
      quote_id: 'quote-123',
      service_type: 'holiday',
      section,
    });
  });

  it('passes quoteId/serviceType through undefined for the mock/dev fallback', () => {
    expect(buildSectionViewedProperties(undefined, undefined, 'gallery')).toEqual({
      quote_id: undefined,
      service_type: undefined,
      section: 'gallery',
    });
  });

  it('carries whichever serviceType is live (permanent/event too, not just holiday)', () => {
    expect(buildSectionViewedProperties('q1', 'permanent', 'warranty').service_type).toBe('permanent');
    expect(buildSectionViewedProperties('q1', 'event', 'reviews').service_type).toBe('event');
  });
});

describe('shouldFireSectionView (one-shot latch, PostHog Wave 4)', () => {
  it('fires the first time the sentinel intersects', () => {
    expect(shouldFireSectionView(false, true)).toBe(true);
  });

  it('never fires again once already fired, even while still intersecting', () => {
    expect(shouldFireSectionView(true, true)).toBe(false);
  });

  it('does not fire while not intersecting', () => {
    expect(shouldFireSectionView(false, false)).toBe(false);
  });

  it('does not fire when already fired and not intersecting', () => {
    expect(shouldFireSectionView(true, false)).toBe(false);
  });
});
