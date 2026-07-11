// Tests for the pure analytics property builder extracted out of
// PermanentEffectPicker (PostHog Wave 2 — effect_changed). No component-render
// test infra exists (@testing-library/jsdom isn't installed — see
// StickyBottomBar.test.ts), so this covers the event-name/property-shape
// contract as a plain function: exact keys, no extraneous PII.

import { describe, it, expect } from 'vitest';
import { effectChangedProps } from './PermanentEffectPicker';

describe('effectChangedProps (PostHog Wave 2)', () => {
  it('carries quote_id/service_type + the picked effect', () => {
    expect(effectChangedProps('q1', 'permanent', 'chase')).toEqual({
      quote_id: 'q1',
      service_type: 'permanent',
      effect: 'chase',
    });
  });

  it('has exactly the three expected keys — no extraneous fields', () => {
    expect(Object.keys(effectChangedProps('q1', 'permanent', 'chase')).sort()).toEqual(
      ['effect', 'quote_id', 'service_type'].sort(),
    );
  });

  it('tolerates an undefined quoteId/serviceType (mock/dev fallback)', () => {
    expect(effectChangedProps(undefined, undefined, 'static')).toEqual({
      quote_id: undefined,
      service_type: undefined,
      effect: 'static',
    });
  });

  it('passes every effect option through unchanged', () => {
    for (const effect of ['static', 'cycle', 'chase', 'twinkle'] as const) {
      expect(effectChangedProps('q1', 'permanent', effect).effect).toBe(effect);
    }
  });
});
