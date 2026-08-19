// Pure-logic test for the browsing-selection dedup key (ledger row 239). The
// house convention is pure-logic tests, no jsdom/hook-rendering — mirrors
// src/lib/leads/usePartialCapture.test.ts's coverage of its own dedup key.

import { describe, it, expect } from 'vitest';
import { selectionKey, type PersistedSelectionFields } from './usePersistedSelection';

const BASE: PersistedSelectionFields = {
  packageId: 'A',
  selectedItemIds: ['item-1', 'item-2'],
  rushSelected: false,
  takedownSelected: false,
  installTiming: 'none',
  colorSchemeId: 'as-designed',
  customPattern: [],
  permanentEffect: 'chase',
};

describe('selectionKey (dedup)', () => {
  it('is identical for identical selections → an unchanged debounce settle is skipped', () => {
    expect(selectionKey(BASE)).toBe(selectionKey({ ...BASE }));
  });

  it('is identical regardless of selectedItemIds ORDER (a Set can reorder on toggle)', () => {
    const a = selectionKey({ ...BASE, selectedItemIds: ['item-1', 'item-2'] });
    const b = selectionKey({ ...BASE, selectedItemIds: ['item-2', 'item-1'] });
    expect(a).toBe(b);
  });

  it('changes when packageId changes', () => {
    expect(selectionKey(BASE)).not.toBe(selectionKey({ ...BASE, packageId: 'D' }));
  });

  it('changes when the selected item SET changes (not just order)', () => {
    expect(selectionKey(BASE)).not.toBe(
      selectionKey({ ...BASE, selectedItemIds: ['item-1', 'item-3'] }),
    );
  });

  it('changes when rushSelected/takedownSelected/installTiming change', () => {
    expect(selectionKey(BASE)).not.toBe(selectionKey({ ...BASE, rushSelected: true }));
    expect(selectionKey(BASE)).not.toBe(selectionKey({ ...BASE, takedownSelected: true }));
    expect(selectionKey(BASE)).not.toBe(selectionKey({ ...BASE, installTiming: 'september' }));
  });

  it('changes when colorSchemeId/customPattern/permanentEffect change', () => {
    expect(selectionKey(BASE)).not.toBe(selectionKey({ ...BASE, colorSchemeId: 'red-green' }));
    expect(selectionKey(BASE)).not.toBe(selectionKey({ ...BASE, customPattern: ['red', 'gold'] }));
    expect(selectionKey(BASE)).not.toBe(selectionKey({ ...BASE, permanentEffect: 'static' }));
  });
});
