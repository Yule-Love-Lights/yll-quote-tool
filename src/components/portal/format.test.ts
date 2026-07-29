import { describe, expect, it } from 'vitest';
import { formatIncludedHeading } from './format';

// #184 — the heading dropped its "Your " lead entirely: "Your Our
// Recommendation" / "Your Build Your Own" read as broken English. Every
// package name now renders bare.
describe('formatIncludedHeading', () => {
  it('renders the bare package name with no lead word', () => {
    expect(formatIncludedHeading('Classic Glow')).toBe('Classic Glow — line by line.');
  });

  it('renders "Our Recommendation" without a "Your" lead', () => {
    expect(formatIncludedHeading('Our Recommendation')).toBe('Our Recommendation — line by line.');
  });

  it('renders "Build Your Own" without a "Your" lead', () => {
    expect(formatIncludedHeading('Build Your Own')).toBe('Build Your Own — line by line.');
  });

  it('renders "Last Year\'s Design" (Neighbor legacy rebook) without a "Your" lead', () => {
    expect(formatIncludedHeading("Last Year's Design")).toBe("Last Year's Design — line by line.");
  });

  it('trims surrounding whitespace', () => {
    expect(formatIncludedHeading('  The Full Yule  ')).toBe('The Full Yule — line by line.');
  });
});
