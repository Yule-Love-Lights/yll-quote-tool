import { describe, it, expect } from 'vitest';
import { computeInitialSelection } from './SelectionContext';
import type { PortalPackage } from './types';

// Minimal package list — only id + includedItemIds matter for the seed.
const pkg = (id: PortalPackage['id'], includedItemIds: string[]): PortalPackage => ({
  id,
  name: `Package ${id}`,
  tagline: '',
  total: 0,
  deposit: 0,
  includedItemIds,
});

const PACKAGES: PortalPackage[] = [
  pkg('A', ['roofline-santas']),
  pkg('B', ['roofline-santas', 'bush-1', 'wreath-1']),
  pkg('C', ['roofline-santas', 'bush-1', 'bush-2', 'wreath-1', 'garland-1']),
];

describe('computeInitialSelection (#12)', () => {
  it('FALLBACK: seeds from the initial package when no recommended ids are given', () => {
    const seed = computeInitialSelection(PACKAGES, 'B');
    expect(seed.packageId).toBe('B');
    expect(seed.selectedItemIds).toEqual(['roofline-santas', 'bush-1', 'wreath-1']);
  });

  it('FALLBACK: an empty recommended list is treated as absent (unchanged default)', () => {
    const seed = computeInitialSelection(PACKAGES, 'C', []);
    expect(seed.packageId).toBe('C');
    expect(seed.selectedItemIds).toEqual(PACKAGES[2].includedItemIds);
  });

  it('FALLBACK: empty selection when the initial package id is unknown', () => {
    const seed = computeInitialSelection(PACKAGES, 'D');
    expect(seed.packageId).toBe('D');
    expect(seed.selectedItemIds).toEqual([]);
  });

  it('RECOMMENDED: seeds EXACTLY the recommended ids and switches to custom (D)', () => {
    const seed = computeInitialSelection(PACKAGES, 'B', ['roofline-santas', 'wreath-1']);
    expect(seed.packageId).toBe('D');
    expect(seed.selectedItemIds).toEqual(['roofline-santas', 'wreath-1']);
  });

  it('RECOMMENDED: ignores the package bundle entirely (only the recommended ids)', () => {
    const seed = computeInitialSelection(PACKAGES, 'C', ['garland-1']);
    expect(seed.packageId).toBe('D');
    expect(seed.selectedItemIds).toEqual(['garland-1']);
  });

  it('RECOMMENDED: copies the ids (does not return the same array reference)', () => {
    const ids = ['bush-1'];
    const seed = computeInitialSelection(PACKAGES, 'B', ids);
    expect(seed.selectedItemIds).not.toBe(ids);
    expect(seed.selectedItemIds).toEqual(['bush-1']);
  });
});
