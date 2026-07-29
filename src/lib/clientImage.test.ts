import { describe, it, expect } from 'vitest';
import { computeTargetDimensions, shouldSkipDownscale } from './clientImage';

describe('computeTargetDimensions (#186)', () => {
  it('leaves an image already within the cap untouched', () => {
    expect(computeTargetDimensions(1920, 1080, 2560)).toEqual({ width: 1920, height: 1080 });
  });
  it('leaves an image exactly at the cap untouched', () => {
    expect(computeTargetDimensions(2560, 1440, 2560)).toEqual({ width: 2560, height: 1440 });
  });
  it('scales a landscape image down proportionally to the longest edge', () => {
    // 4000x3000 -> longest edge 4000 scaled to 2560 (0.64x) -> 2560x1920
    expect(computeTargetDimensions(4000, 3000, 2560)).toEqual({ width: 2560, height: 1920 });
  });
  it('scales a portrait image down proportionally to the longest edge', () => {
    // 3000x4000 -> longest edge 4000 scaled to 2560 (0.64x) -> 1920x2560
    expect(computeTargetDimensions(3000, 4000, 2560)).toEqual({ width: 1920, height: 2560 });
  });
  it('never upscales a small image', () => {
    expect(computeTargetDimensions(400, 300, 2560)).toEqual({ width: 400, height: 300 });
  });
  it('handles a zero/degenerate dimension without throwing', () => {
    expect(computeTargetDimensions(0, 0, 2560)).toEqual({ width: 0, height: 0 });
  });
});

describe('shouldSkipDownscale (#186)', () => {
  const MB = 1024 * 1024;

  it('skips a small file already within the edge cap', () => {
    expect(shouldSkipDownscale(1 * MB, 1920, 1080, 2560, 2.5 * MB)).toBe(true);
  });
  it('does not skip a small file that exceeds the edge cap', () => {
    expect(shouldSkipDownscale(1 * MB, 4000, 3000, 2560, 2.5 * MB)).toBe(false);
  });
  it('does not skip a large file even if dimensions are within the cap', () => {
    // e.g. a dense PNG screenshot: modest pixel dimensions, large byte size.
    expect(shouldSkipDownscale(4 * MB, 1920, 1080, 2560, 2.5 * MB)).toBe(false);
  });
  it('boundary: a file exactly at the skip threshold is NOT skipped (< is strict)', () => {
    expect(shouldSkipDownscale(2.5 * MB, 1920, 1080, 2560, 2.5 * MB)).toBe(false);
  });
});
