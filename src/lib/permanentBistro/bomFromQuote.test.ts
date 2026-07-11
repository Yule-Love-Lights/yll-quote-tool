import { describe, it, expect } from 'vitest';
import { bistroBomInputFromFields, bistroBomFromQuote } from './bomFromQuote';
import type { PermanentBistroInputFields } from './types';

describe('bistroBomInputFromFields', () => {
  it('maps bistro runs (footage > 0 only) + floored pole count onto the BOM input', () => {
    const p: PermanentBistroInputFields = {
      bistro: [{ footage: 40 }, { footage: 0 }, { footage: -5 }, { footage: 35 }, { footage: 25 }],
      poles: 2.9,
    };
    const input = bistroBomInputFromFields(p);
    expect(input.runs).toEqual([40, 35, 25]);
    expect(input.poles).toBe(2);
  });

  it('missing/non-array bistro + missing poles → empty runs, 0 poles', () => {
    expect(bistroBomInputFromFields({})).toEqual({ runs: [], poles: 0 });
  });

  it('negative/NaN poles clamp to 0', () => {
    expect(bistroBomInputFromFields({ poles: -3 }).poles).toBe(0);
    expect(bistroBomInputFromFields({ poles: Number.NaN }).poles).toBe(0);
  });
});

describe('bistroBomFromQuote', () => {
  it('returns null when the quote has no permanentBistro block', () => {
    expect(bistroBomFromQuote(null)).toBeNull();
    expect(bistroBomFromQuote(undefined)).toBeNull();
    expect(bistroBomFromQuote({})).toBeNull();
  });

  it('returns null for an empty job (no footage, no poles) even when the block exists', () => {
    expect(bistroBomFromQuote({ permanentBistro: {} })).toBeNull();
    expect(bistroBomFromQuote({ permanentBistro: { bistro: [], poles: 0 } })).toBeNull();
    expect(bistroBomFromQuote({ permanentBistro: { bistro: [{ footage: 0 }] } })).toBeNull();
  });

  it('builds a BOM when footage > 0', () => {
    const bom = bistroBomFromQuote({ permanentBistro: { bistro: [{ footage: 40 }, { footage: 35 }, { footage: 25 }] } });
    expect(bom).not.toBeNull();
    expect(bom!.totals.totalFootage).toBe(100);
    expect(bom!.totals.strands).toBe(3);
    expect(bom!.lines.length).toBeGreaterThan(0);
  });

  it('builds a BOM when poles > 0 even with no footage', () => {
    const bom = bistroBomFromQuote({ permanentBistro: { poles: 2 } });
    expect(bom).not.toBeNull();
    expect(bom!.totals.poles).toBe(2);
    expect(bom!.totals.totalFootage).toBe(0);
  });

  it('passes costOverrides through to the engine', () => {
    const overrides = new Map([['80324', 3.25]]);
    const bom = bistroBomFromQuote({ permanentBistro: { bistro: [{ footage: 40 }] } }, overrides);
    const cord = bom!.lines.find((l) => l.sku === '80324')!;
    expect(cord.unitCost).toBe(3.25);
  });
});
