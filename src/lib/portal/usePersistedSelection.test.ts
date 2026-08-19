// Pure-logic test for the browsing-selection dedup key (ledger row 239). The
// house convention is pure-logic tests, no jsdom/hook-rendering — mirrors
// src/lib/leads/usePartialCapture.test.ts's coverage of its own dedup key.
//
// FIX A (row 239 fix round, customer lens HIGH) added dedupKeyAfterFailedSave
// — the pure CAS decision `send()`'s markFailed() calls when a save fails, so
// the failure-then-retry path is exercised directly here. This repo has no
// jsdom/happy-dom/@testing-library/react in node_modules or package.json
// (checked before writing this), so rendering the actual hook and mocking
// fetch/sendBeacon/document isn't possible — dedupKeyAfterFailedSave is the
// hook's entire retry decision extracted to a pure function, same convention
// as selectionKey, so this is a direct test of the real logic, not a stand-in.

import { describe, it, expect } from 'vitest';
import { selectionKey, dedupKeyAfterFailedSave, type PersistedSelectionFields } from './usePersistedSelection';

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

describe('dedupKeyAfterFailedSave (FIX A — failed-save retry)', () => {
  it('reverts to the prior key when nothing newer has claimed the slot — the failed value is retried', () => {
    // send() optimistically set lastSavedKeyRef to 'B' before the request went
    // out; the request then failed and nothing else has touched the ref since
    // (currentKey === attemptedKey === 'B'), so it reverts to 'A'.
    expect(dedupKeyAfterFailedSave('B', 'A', 'B')).toBe('A');
  });

  it('does NOT stomp a newer key claimed by a later send while this one was in flight', () => {
    // The first attempt (key 'B') is still in flight when the customer
    // changes the selection again and a second send claims the slot with
    // 'C'. When the FIRST attempt's failure lands, currentKey is 'C', not
    // 'B' — reverting would incorrectly erase the newer pending value.
    expect(dedupKeyAfterFailedSave('B', 'A', 'C')).toBe('C');
  });

  it('a later failure correctly reverts to what the EARLIER attempt actually saved', () => {
    // Attempt 1 (key 'B', prior 'A') succeeds — the server now holds 'B'.
    // Attempt 2 (key 'C', prior 'B') was already in flight and then fails.
    // currentKey is still 'C' (attempt 1's success doesn't touch the ref), so
    // attempt 2's own attemptedKey ('C') still owns the slot and it reverts
    // to ITS prior key, 'B' — which matches what the server really has.
    expect(dedupKeyAfterFailedSave('C', 'B', 'C')).toBe('B');
  });

  it('is idempotent when called with matching attempted/current and no intervening change', () => {
    expect(dedupKeyAfterFailedSave('X', 'X', 'X')).toBe('X');
  });
});
