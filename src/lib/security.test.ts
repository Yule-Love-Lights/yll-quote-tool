import { describe, it, expect } from 'vitest';
import { safeEqual } from './security';

describe('safeEqual', () => {
  it('returns true for equal strings', () => {
    expect(safeEqual('hunter2', 'hunter2')).toBe(true);
  });

  it('returns false for same-length different strings', () => {
    expect(safeEqual('aaaaaaa', 'bbbbbbb')).toBe(false);
  });

  it('returns false for different-length strings', () => {
    expect(safeEqual('short', 'longer-secret')).toBe(false);
  });

  it('returns false when either side is missing', () => {
    expect(safeEqual(undefined, 'x')).toBe(false);
    expect(safeEqual('x', undefined)).toBe(false);
    expect(safeEqual(undefined, undefined)).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
    expect(safeEqual('x', '')).toBe(false);
  });
});
