import { describe, it, expect } from 'vitest';
import { sanitizePermanentBistroRates, DEFAULT_PERMANENT_BISTRO_RATES } from './types';

describe('sanitizePermanentBistroRates', () => {
  it('missing / non-object input → the full defaults', () => {
    expect(sanitizePermanentBistroRates(undefined)).toEqual(DEFAULT_PERMANENT_BISTRO_RATES);
    expect(sanitizePermanentBistroRates(null)).toEqual(DEFAULT_PERMANENT_BISTRO_RATES);
    expect(sanitizePermanentBistroRates('nope')).toEqual(DEFAULT_PERMANENT_BISTRO_RATES);
  });

  it('a valid full table round-trips unchanged', () => {
    const rates = { perFt: 32, perPole: 120, minimum: 1500, maintenancePrice: 250 };
    expect(sanitizePermanentBistroRates(rates)).toEqual(rates);
  });

  it('a partial patch keeps the other fields at their defaults', () => {
    const r = sanitizePermanentBistroRates({ perFt: 40 });
    expect(r.perFt).toBe(40);
    expect(r.perPole).toBe(DEFAULT_PERMANENT_BISTRO_RATES.perPole);
    expect(r.minimum).toBe(DEFAULT_PERMANENT_BISTRO_RATES.minimum);
    expect(r.maintenancePrice).toBe(DEFAULT_PERMANENT_BISTRO_RATES.maintenancePrice);
  });

  it('invalid perFt/perPole (0 / negative / NaN / string) fall back to the default per field', () => {
    expect(sanitizePermanentBistroRates({ perFt: 0 }).perFt).toBe(DEFAULT_PERMANENT_BISTRO_RATES.perFt);
    expect(sanitizePermanentBistroRates({ perFt: -5 }).perFt).toBe(DEFAULT_PERMANENT_BISTRO_RATES.perFt);
    expect(sanitizePermanentBistroRates({ perFt: NaN }).perFt).toBe(DEFAULT_PERMANENT_BISTRO_RATES.perFt);
    expect(sanitizePermanentBistroRates({ perFt: 'x' }).perFt).toBe(DEFAULT_PERMANENT_BISTRO_RATES.perFt);
    expect(sanitizePermanentBistroRates({ perPole: 0 }).perPole).toBe(DEFAULT_PERMANENT_BISTRO_RATES.perPole);
    expect(sanitizePermanentBistroRates({ perPole: -1 }).perPole).toBe(DEFAULT_PERMANENT_BISTRO_RATES.perPole);
  });

  it('minimum=0 is a VALID value (the gate-off case) — preserved, not replaced by the default', () => {
    // Default minimum is already 0, so prove preservation against a non-zero default.
    const r = sanitizePermanentBistroRates({ perFt: 30, perPole: 100, minimum: 0 });
    expect(r.minimum).toBe(0);
  });

  it('a positive minimum round-trips', () => {
    expect(sanitizePermanentBistroRates({ minimum: 2500 }).minimum).toBe(2500);
  });

  it('invalid minimum (negative / NaN / string) falls back to the default, but stays non-negative-safe', () => {
    expect(sanitizePermanentBistroRates({ minimum: -1 }).minimum).toBe(DEFAULT_PERMANENT_BISTRO_RATES.minimum);
    expect(sanitizePermanentBistroRates({ minimum: NaN }).minimum).toBe(DEFAULT_PERMANENT_BISTRO_RATES.minimum);
    expect(sanitizePermanentBistroRates({ minimum: 'x' }).minimum).toBe(DEFAULT_PERMANENT_BISTRO_RATES.minimum);
  });

  it('always returns a complete table (never trips the engine $0 guardrail on perFt/perPole)', () => {
    const r = sanitizePermanentBistroRates({});
    expect(Number.isFinite(r.perFt) && r.perFt > 0).toBe(true);
    expect(Number.isFinite(r.perPole) && r.perPole > 0).toBe(true);
    expect(Number.isFinite(r.minimum) && r.minimum >= 0).toBe(true);
    expect(Number.isFinite(r.maintenancePrice) && (r.maintenancePrice as number) >= 0).toBe(true);
  });

  // WT-64: mirrors `minimum` exactly — 0 is the valid "hidden" value.
  describe('maintenancePrice (WT-64, mirrors permanent.maintenancePrice)', () => {
    it('maintenancePrice=0 is a VALID value (hides the add-on) — preserved, not replaced', () => {
      const r = sanitizePermanentBistroRates({ perFt: 30, perPole: 100, minimum: 0, maintenancePrice: 0 });
      expect(r.maintenancePrice).toBe(0);
    });

    it('a positive maintenancePrice round-trips', () => {
      expect(sanitizePermanentBistroRates({ maintenancePrice: 600 }).maintenancePrice).toBe(600);
    });

    it('invalid maintenancePrice (negative / NaN / string) falls back to the default', () => {
      expect(sanitizePermanentBistroRates({ maintenancePrice: -1 }).maintenancePrice).toBe(DEFAULT_PERMANENT_BISTRO_RATES.maintenancePrice);
      expect(sanitizePermanentBistroRates({ maintenancePrice: NaN }).maintenancePrice).toBe(DEFAULT_PERMANENT_BISTRO_RATES.maintenancePrice);
      expect(sanitizePermanentBistroRates({ maintenancePrice: 'x' }).maintenancePrice).toBe(DEFAULT_PERMANENT_BISTRO_RATES.maintenancePrice);
    });

    it('a missing maintenancePrice defaults to 0 (legacy rate tables saved before WT-64)', () => {
      expect(sanitizePermanentBistroRates({ perFt: 30, perPole: 100, minimum: 0 }).maintenancePrice).toBe(0);
    });
  });
});
