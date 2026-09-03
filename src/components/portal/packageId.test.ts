import { describe, it, expect } from 'vitest';
import { PACKAGE_IDS, isPackageId } from './types';

// The package id union used to be spelled out literally in six places: this
// type, the approve route's body type and its 400 guard, the selection route's
// type and guard, and the adapter's approval/browsing snapshot parsers. Adding
// permanent's 'E' recommendation card meant all six had to move together, and
// missing the approve route's guard would have refused a customer who tapped
// the new card with a 400 at the last step. These tests pin the list and the
// shared guard so the next id has one place to change.
describe('PackageId', () => {
  it('carries every id a derive path can emit, including permanent E', () => {
    expect(PACKAGE_IDS).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('accepts every id in the list', () => {
    for (const id of PACKAGE_IDS) expect(isPackageId(id)).toBe(true);
  });

  it('rejects anything else', () => {
    for (const value of ['F', 'a', '', 'AB', null, undefined, 0, 1, {}, ['A']]) {
      expect(isPackageId(value)).toBe(false);
    }
  });
});
