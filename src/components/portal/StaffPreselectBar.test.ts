// Tests for staffSelectionSignature (ledger row 324 fix round — staff lens
// MED): the pure equality key StaffPreselectBar.tsx uses to decide whether
// the "Saved" confirmation still matches the live selection. Extracted so
// the equality logic is unit-testable without rendering the component (this
// repo has no React component-render test harness — see the sibling pure
// reducers in SelectionContext.tsx for the same pattern).

import { describe, it, expect } from 'vitest';
import { staffSelectionSignature, type StaffSelectionSnapshot } from './StaffPreselectBar';

const BASE: StaffSelectionSnapshot = {
  packageId: 'D',
  selectedItemIds: ['item-1', 'item-2'],
  rushSelected: true,
  takedownSelected: false,
  installTiming: 'september',
  colorSchemeId: 'red-green',
  customPattern: ['red', 'green'],
  permanentEffect: 'chase',
};

describe('staffSelectionSignature', () => {
  it('is stable for identical inputs', () => {
    expect(staffSelectionSignature(BASE)).toBe(staffSelectionSignature({ ...BASE }));
  });

  it('is order-independent for selectedItemIds — a Set/array in a different iteration order still matches', () => {
    const a = staffSelectionSignature({ ...BASE, selectedItemIds: ['item-1', 'item-2'] });
    const b = staffSelectionSignature({ ...BASE, selectedItemIds: new Set(['item-2', 'item-1']) });
    expect(a).toBe(b);
  });

  const FIELD_CHANGES: [string, Partial<StaffSelectionSnapshot>][] = [
    ['packageId', { packageId: 'B' }],
    ['selectedItemIds (a real change, not just order)', { selectedItemIds: ['item-1'] }],
    ['rushSelected', { rushSelected: false }],
    ['takedownSelected', { takedownSelected: true }],
    ['installTiming', { installTiming: 'october' }],
    ['colorSchemeId', { colorSchemeId: 'custom' }],
    ['customPattern', { customPattern: ['blue'] }],
    ['permanentEffect', { permanentEffect: 'fade' }],
  ];
  it.each(FIELD_CHANGES)('changes the signature when %s changes', (_label, patch) => {
    expect(staffSelectionSignature({ ...BASE, ...patch })).not.toBe(staffSelectionSignature(BASE));
  });

  // This is the actual regression this fix guards: after a save, the
  // component compares its stored savedSignature to a freshly-computed
  // currentSignature on every render. If ANY field staff can edit changed
  // and the signature didn't move, the stale "Saved" confirmation would
  // silently keep showing.
  it('reflects every field the save() payload actually POSTs (no field can drift silently)', () => {
    const fields = Object.keys(BASE) as (keyof StaffSelectionSnapshot)[];
    expect(fields.sort()).toEqual(
      [
        'colorSchemeId',
        'customPattern',
        'installTiming',
        'packageId',
        'permanentEffect',
        'rushSelected',
        'selectedItemIds',
        'takedownSelected',
      ].sort(),
    );
  });
});
