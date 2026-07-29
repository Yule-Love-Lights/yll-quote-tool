// Tests for the pure heading-name predicate extracted out of WhatsIncluded
// (#184). No component-render test infra exists (@testing-library/jsdom
// isn't installed — see StickyBottomBar.test.ts / LightColorPicker.test.ts),
// so this covers the predicate as a plain function.

import { describe, it, expect } from 'vitest';
import { resolveIncludedHeadingName } from './WhatsIncluded';

describe('resolveIncludedHeadingName (#184 — Neighbor multi-item heading stability)', () => {
  it('a legacy rebook with 2+ items always reads "Build Your Own", even while the selection currently matches last year\'s bundle', () => {
    expect(resolveIncludedHeadingName("Last Year's Design", true, 2)).toBe('Build Your Own');
    expect(resolveIncludedHeadingName("Last Year's Design", true, 3)).toBe('Build Your Own');
  });

  it('a legacy rebook with 2+ items reads "Build Your Own" even while activeName already says so', () => {
    expect(resolveIncludedHeadingName('Build Your Own', true, 2)).toBe('Build Your Own');
  });

  it('a legacy rebook frozen at exactly 1 item keeps the accurate "Last Year\'s Design"', () => {
    expect(resolveIncludedHeadingName("Last Year's Design", true, 1)).toBe("Last Year's Design");
  });

  it('a non-legacy quote is unaffected regardless of item count', () => {
    expect(resolveIncludedHeadingName('Our Recommendation', false, 1)).toBe('Our Recommendation');
    expect(resolveIncludedHeadingName('Classic Glow', false, 5)).toBe('Classic Glow');
    expect(resolveIncludedHeadingName('Build Your Own', false, 2)).toBe('Build Your Own');
  });
});
