import { describe, expect, it } from 'vitest';
import { formatIncludedHeading } from './format';

describe('formatIncludedHeading', () => {
  it('adds a possessive lead to ordinary package names', () => {
    expect(formatIncludedHeading('Classic Glow')).toBe('Your Classic Glow — line by line.');
  });

  it('does not produce "Your The" for names that already start with The', () => {
    expect(formatIncludedHeading('The Full Yule')).toBe('The Full Yule — line by line.');
    expect(formatIncludedHeading('  the Signature Package  ')).toBe(
      'the Signature Package — line by line.',
    );
  });
});
