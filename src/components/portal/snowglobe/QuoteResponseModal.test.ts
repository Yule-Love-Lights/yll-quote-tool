// Tests for the pure seams extracted out of QuoteResponseModal (PostHog Wave
// 1 — decline quick-pick chips + quote_declined). No component-render test
// infra exists (@testing-library/jsdom isn't installed — see
// StickyBottomBar.test.ts), so this covers the same seams as plain functions:
// (a) the reason-string composition (chip + free text -> the existing
// `reason` API field, no contract change), (b) the reason_category mapping,
// and (c) the intent gate that keeps quote_declined decline-only.

import { describe, it, expect } from 'vitest';
import {
  buildDeclineReason,
  declineReasonCategory,
  shouldFireQuoteDeclined,
  DECLINE_CHIPS,
  type DeclineChipId,
} from './QuoteResponseModal';

describe('buildDeclineReason (PostHog Wave 1)', () => {
  it('chip + text -> "<Chip label>: <text>"', () => {
    expect(buildDeclineReason('price', 'a bit over our budget')).toBe('Price: a bit over our budget');
  });

  it('chip only -> "<Chip label>"', () => {
    expect(buildDeclineReason('timing', '')).toBe('Timing');
  });

  it('text only -> the text, unchanged', () => {
    expect(buildDeclineReason(null, 'went with a neighbor referral')).toBe('went with a neighbor referral');
  });

  it('neither -> the existing default', () => {
    expect(buildDeclineReason(null, '')).toBe('No reason given');
  });

  it('covers every chip label exactly (competitor / just_looking)', () => {
    expect(buildDeclineReason('competitor', '')).toBe('Went with someone else');
    expect(buildDeclineReason('just_looking', '')).toBe('Just looking');
  });
});

describe('declineReasonCategory (PostHog Wave 1)', () => {
  it('returns the chip id when a chip is selected', () => {
    const ids: DeclineChipId[] = ['price', 'timing', 'competitor', 'just_looking'];
    for (const id of ids) {
      expect(declineReasonCategory(id)).toBe(id);
    }
  });

  it('returns "none" when no chip is selected', () => {
    expect(declineReasonCategory(null)).toBe('none');
  });
});

describe('DECLINE_CHIPS (PostHog Wave 1)', () => {
  it('has exactly the four required chips with the exact labels', () => {
    expect(DECLINE_CHIPS).toEqual([
      { id: 'price', label: 'Price' },
      { id: 'timing', label: 'Timing' },
      { id: 'competitor', label: 'Went with someone else' },
      { id: 'just_looking', label: 'Just looking' },
    ]);
  });
});

describe('shouldFireQuoteDeclined (PostHog Wave 1)', () => {
  it('fires for decline', () => {
    expect(shouldFireQuoteDeclined('decline')).toBe(true);
  });

  it('never fires for request-changes', () => {
    expect(shouldFireQuoteDeclined('request-changes')).toBe(false);
  });
});
