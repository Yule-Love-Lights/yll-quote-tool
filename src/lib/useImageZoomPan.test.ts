import { describe, it, expect } from 'vitest';
import { clampZoom, clampPan, anchorPan, pinchZoom } from './useImageZoomPan';

describe('clampZoom', () => {
  it('clamps to [min, max]', () => {
    expect(clampZoom(0.5, 1, 4)).toBe(1);
    expect(clampZoom(2, 1, 4)).toBe(2);
    expect(clampZoom(9, 1, 4)).toBe(4);
  });
  it('falls back to min on non-finite input', () => {
    expect(clampZoom(NaN, 1, 4)).toBe(1);
    expect(clampZoom(Infinity, 1, 4)).toBe(4); // Infinity clamps down to max
  });
});

describe('clampPan', () => {
  it('keeps the scaled content covering the box (pan in [size*(1-zoom), 0])', () => {
    // box 200px, zoom 2 ⇒ content 400px ⇒ valid pan [-200, 0]
    expect(clampPan(0, 2, 200)).toBe(0);
    expect(clampPan(-50, 2, 200)).toBe(-50);
    expect(clampPan(-999, 2, 200)).toBe(-200); // clamped to the far edge
    expect(clampPan(50, 2, 200)).toBe(0); // can't pan past the near edge
  });
  it('forces pan to 0 at zoom 1 (content exactly fills the box)', () => {
    expect(clampPan(-50, 1, 200)).toBe(0);
    expect(clampPan(50, 1, 200)).toBe(0);
  });
  it('returns 0 for a zero/negative box size', () => {
    expect(clampPan(-50, 2, 0)).toBe(0);
  });
});

describe('anchorPan', () => {
  it('keeps the content point under the cursor fixed across a zoom change', () => {
    // Start unzoomed (zoom 1, pan 0). Cursor at 100px ⇒ local point = 100.
    // Zoom to 2 ⇒ that local point must stay under the cursor at 100px:
    //   newPan = 100 - 2*100 = -100, and -100 + 2*100 = 100 ✓
    const newPan = anchorPan(100, 0, 1, 2);
    expect(newPan).toBe(-100);
    expect(newPan + 2 * ((100 - 0) / 1)).toBe(100);
  });
  it('anchors correctly when already panned/zoomed', () => {
    // zoom 2, pan -100, cursor 100 ⇒ local = (100-(-100))/2 = 100.
    // zoom to 4 ⇒ newPan = 100 - 4*100 = -300; check it still maps to 100.
    const newPan = anchorPan(100, -100, 2, 4);
    expect(newPan).toBe(-300);
    expect(newPan + 4 * 100).toBe(100);
  });
  it('returns the previous pan if prevZoom is non-positive', () => {
    expect(anchorPan(100, -20, 0, 2)).toBe(-20);
  });
});

describe('pinchZoom', () => {
  it('scales the start zoom by the finger-distance ratio', () => {
    expect(pinchZoom(1, 100, 200, 1, 4)).toBe(2); // fingers 2× apart → 2×
    expect(pinchZoom(2, 100, 50, 1, 4)).toBe(1); // fingers halved → half (→min 1)
    expect(pinchZoom(1, 100, 100, 1, 4)).toBe(1); // no change
  });
  it('clamps to [min, max]', () => {
    expect(pinchZoom(2, 100, 400, 1, 4)).toBe(4); // 2×4 = 8 → clamped to max
    expect(pinchZoom(2, 100, 10, 1, 4)).toBe(1); // 2×0.1 = 0.2 → clamped to min
  });
  it('leaves zoom unchanged on a degenerate start distance', () => {
    expect(pinchZoom(3, 0, 200, 1, 4)).toBe(3);
    expect(pinchZoom(3, -5, 200, 1, 4)).toBe(3);
  });
});
