// src/lib/inventory/onHand.test.ts
import { describe, it, expect } from 'vitest';
import { toQty } from './onHand';

describe('toQty', () => {
  it('clamps to a non-negative integer', () => {
    expect(toQty(5)).toBe(5);
    expect(toQty('12')).toBe(12);
    expect(toQty(3.9)).toBe(3);
    expect(toQty(-4)).toBe(0);
    expect(toQty('abc')).toBe(0);
    expect(toQty(null)).toBe(0);
    expect(toQty(undefined)).toBe(0);
  });
});
