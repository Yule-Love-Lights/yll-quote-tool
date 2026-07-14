// Tests for the pure analytics property builder extracted out of
// WalkthroughVideo (PostHog Wave 2 — video_played). No component-render test
// infra exists (@testing-library/jsdom isn't installed — see
// StickyBottomBar.test.ts), so this covers the event-name/property-shape
// contract as a plain function: exact keys, no extraneous PII (no video
// title/url — just the quote context).

import { describe, it, expect } from 'vitest';
import { videoPlayedProps } from './WalkthroughVideo';

describe('videoPlayedProps (PostHog Wave 2)', () => {
  it('carries quote_id/service_type only', () => {
    expect(videoPlayedProps('q1', 'holiday')).toEqual({
      quote_id: 'q1',
      service_type: 'holiday',
    });
  });

  it('has exactly the two expected keys — no extraneous fields (no video src/title)', () => {
    expect(Object.keys(videoPlayedProps('q1', 'holiday')).sort()).toEqual(
      ['quote_id', 'service_type'].sort(),
    );
  });

  it('tolerates an undefined quoteId/serviceType (mock/dev fallback)', () => {
    expect(videoPlayedProps(undefined, undefined)).toEqual({
      quote_id: undefined,
      service_type: undefined,
    });
  });
});
