import { describe, it, expect } from 'vitest';
import { firstYardstickPpf } from './yardstickPpf';
import type { Scene, Yardstick } from './sceneTypes';

const ys = (overrides: Partial<Yardstick>): Yardstick => ({
  id: 'ys', realFeet: 10, x: 0, y: 0, width: 20, height: 200, ...overrides,
});
const scene = (yardsticks: Yardstick[]): Scene => ({ yardsticks, items: [] });

describe('firstYardstickPpf', () => {
  it('returns null when there are no yardsticks', () => {
    expect(firstYardstickPpf(scene([]))).toBeNull();
    expect(firstYardstickPpf({ yardsticks: [], items: [] })).toBeNull();
  });

  it('defaults to width when axis is absent (legacy data)', () => {
    // width 100px / 5ft = 20 px/ft
    expect(firstYardstickPpf(scene([ys({ realFeet: 5, width: 100, height: 45 })]))).toBe(20);
  });

  it('uses width when axis is explicitly "width"', () => {
    expect(firstYardstickPpf(scene([ys({ realFeet: 5, width: 100, height: 900, axis: 'width' })]))).toBe(20);
  });

  it('uses HEIGHT when axis is "height" (#110 W5-001)', () => {
    // A tall-narrow vertical reference: width 20px, height 200px, realFeet 10
    // → true ppf is 200/10 = 20, NOT width/realFeet = 20/10 = 2.
    expect(firstYardstickPpf(scene([ys({ realFeet: 10, width: 20, height: 200, axis: 'height' })]))).toBe(20);
  });

  it('uses the FIRST yardstick when multiple exist', () => {
    const out = firstYardstickPpf(scene([
      ys({ realFeet: 5, width: 100, axis: 'width' }),
      ys({ realFeet: 1, width: 500, axis: 'width' }),
    ]));
    expect(out).toBe(20);
  });

  it('returns null for a zero/negative realFeet', () => {
    expect(firstYardstickPpf(scene([ys({ realFeet: 0 })]))).toBeNull();
    expect(firstYardstickPpf(scene([ys({ realFeet: -5 })]))).toBeNull();
  });

  it('returns null for a zero/negative measured extent', () => {
    expect(firstYardstickPpf(scene([ys({ width: 0, axis: 'width' })]))).toBeNull();
    expect(firstYardstickPpf(scene([ys({ height: 0, axis: 'height' })]))).toBeNull();
  });

  it('returns null for a non-finite measured extent or realFeet', () => {
    expect(firstYardstickPpf(scene([ys({ realFeet: NaN })]))).toBeNull();
    expect(firstYardstickPpf(scene([ys({ width: Infinity, axis: 'width' })]))).toBeNull();
  });

  it('returns null when the derived ppf is implausible (outside [2, 500])', () => {
    // 1px / 10ft = 0.1 px/ft — below MIN_PPF.
    expect(firstYardstickPpf(scene([ys({ realFeet: 10, width: 1, axis: 'width' })]))).toBeNull();
    // 10000px / 1ft = 10000 px/ft — above MAX_PPF.
    expect(firstYardstickPpf(scene([ys({ realFeet: 1, width: 10000, axis: 'width' })]))).toBeNull();
  });

  it('handles a missing/undefined scene gracefully', () => {
    expect(firstYardstickPpf(null)).toBeNull();
    expect(firstYardstickPpf(undefined)).toBeNull();
  });
});
