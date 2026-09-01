import { describe, it, expect } from 'vitest';
import { normalizeAddress, groupByAddress, macroMean } from './dedupeByAddress';

describe('normalizeAddress', () => {
  it('lowercases and trims', () => {
    expect(normalizeAddress('  123 Main St  ')).toBe('123 main st');
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeAddress('123   Main\tSt')).toBe('123 main st');
  });

  it('returns empty string for null/undefined/blank', () => {
    expect(normalizeAddress(null)).toBe('');
    expect(normalizeAddress(undefined)).toBe('');
    expect(normalizeAddress('   ')).toBe('');
  });

  it('two addresses differing only in case/spacing normalize identically', () => {
    expect(normalizeAddress('123 Main St')).toBe(normalizeAddress(' 123  MAIN   ST '));
  });
});

describe('groupByAddress', () => {
  it('pools rows sharing the same normalized address into one group', () => {
    const rows = [
      { address: '123 Main St', id: 1 },
      { address: '123 main st', id: 2 }, // same house, different capture, different casing
      { address: '  123   MAIN ST  ', id: 3 }, // same house, extra whitespace
    ];
    const groups = groupByAddress(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it('the one-house-captured-9-times case collapses to a single group', () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ address: '456 Oak Ave', id: i }));
    const groups = groupByAddress(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(9);
  });

  it('different addresses stay in separate groups', () => {
    const rows = [
      { address: '1 First St', id: 1 },
      { address: '2 Second St', id: 2 },
    ];
    const groups = groupByAddress(rows);
    expect(groups).toHaveLength(2);
  });

  it('rows with no address each become their own singleton group, never pooled together', () => {
    const rows = [
      { address: null, id: 1 },
      { address: null, id: 2 },
      { address: '', id: 3 },
    ];
    const groups = groupByAddress(rows);
    expect(groups).toHaveLength(3);
    for (const g of groups) expect(g).toHaveLength(1);
  });

  it('every input row appears in exactly one output group (no rows lost or duplicated)', () => {
    const rows = [
      { address: 'A', id: 1 },
      { address: 'A', id: 2 },
      { address: null, id: 3 },
      { address: 'B', id: 4 },
      { address: null, id: 5 },
    ];
    const groups = groupByAddress(rows);
    const allIds = groups.flat().map((r) => r.id).sort();
    expect(allIds).toEqual([1, 2, 3, 4, 5]);
  });

  it('empty input produces zero groups', () => {
    expect(groupByAddress([])).toEqual([]);
  });
});

describe('macroMean', () => {
  it('averages present values with equal weight', () => {
    expect(macroMean([1, 2, 3])).toBe(2);
  });

  it('excludes nulls from the mean rather than treating them as 0', () => {
    // if null were treated as 0 this would average to 0.5, not 1
    expect(macroMean([1, null, 1])).toBe(1);
  });

  it('returns null when every value is null (nothing to average)', () => {
    expect(macroMean([null, null])).toBeNull();
  });

  it('returns null for an empty array', () => {
    expect(macroMean([])).toBeNull();
  });

  it('a single value averages to itself', () => {
    expect(macroMean([0.75])).toBe(0.75);
  });

  it('gives equal weight per group regardless of how many rows fed that group — the actual dedup property', () => {
    // Simulates: address A has 9 captures each scoring precision 0.2 (bad),
    // address B has 1 capture scoring precision 1.0 (perfect). A per-row
    // (micro) average would be dominated by A: (9*0.2 + 1*1.0) / 10 = 0.28.
    // The per-address (macro) average — one value per address — is what
    // this function computes once the caller has already reduced each
    // group to one number: (0.2 + 1.0) / 2 = 0.6.
    const perAddressPrecision = [0.2, 1.0]; // already one value per address
    expect(macroMean(perAddressPrecision)).toBe(0.6);
  });
});
