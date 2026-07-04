import { describe, it, expect } from 'vitest';
import { sanitizeEventRates, DEFAULT_EVENT_RATES } from './types';

describe('sanitizeEventRates', () => {
  it('missing / non-object input → the full defaults', () => {
    expect(sanitizeEventRates(undefined)).toEqual(DEFAULT_EVENT_RATES);
    expect(sanitizeEventRates(null)).toEqual(DEFAULT_EVENT_RATES);
    expect(sanitizeEventRates('nope')).toEqual(DEFAULT_EVENT_RATES);
  });

  it('a valid full table round-trips unchanged', () => {
    const rates = {
      roofline: { easy: 7, medium: 8, hard: 9 },
      mini: { canopy: 35, trunk: 45 },
      spritzer: { '16': 65, '24': 75, '32': 85 },
      bistroPerFt: 12,
      barrelBoxPrice: 150,
    };
    expect(sanitizeEventRates(rates)).toEqual(rates);
  });

  it('a partial patch keeps the other fields at their defaults', () => {
    const r = sanitizeEventRates({ bistroPerFt: 20 });
    expect(r.bistroPerFt).toBe(20);
    expect(r.roofline).toEqual(DEFAULT_EVENT_RATES.roofline);
    expect(r.barrelBoxPrice).toBe(DEFAULT_EVENT_RATES.barrelBoxPrice);
  });

  it('invalid numbers (0 / negative / NaN / string) fall back to the default per field', () => {
    const r = sanitizeEventRates({
      roofline: { easy: 0, medium: -3, hard: 'x' },
      mini: { canopy: NaN, trunk: 50 },
      spritzer: { '16': 65 }, // 24/32 missing
      bistroPerFt: -1,
    });
    expect(r.roofline).toEqual(DEFAULT_EVENT_RATES.roofline); // all invalid → defaults
    expect(r.mini.canopy).toBe(DEFAULT_EVENT_RATES.mini.canopy); // NaN → default
    expect(r.mini.trunk).toBe(50); // valid override kept
    expect(r.spritzer['16']).toBe(65);
    expect(r.spritzer['24']).toBe(DEFAULT_EVENT_RATES.spritzer['24']); // missing → default
    expect(r.bistroPerFt).toBe(DEFAULT_EVENT_RATES.bistroPerFt); // -1 → default
  });

  it('always returns a complete table (never trips the engine $0 guardrail)', () => {
    const r = sanitizeEventRates({});
    for (const v of [r.roofline.easy, r.roofline.medium, r.roofline.hard, r.mini.canopy, r.mini.trunk, r.spritzer['16'], r.spritzer['24'], r.spritzer['32'], r.bistroPerFt, r.barrelBoxPrice]) {
      expect(Number.isFinite(v) && v > 0).toBe(true);
    }
  });
});
