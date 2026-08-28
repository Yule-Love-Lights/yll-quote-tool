import { describe, it, expect } from 'vitest';
import { stableStringify, quoteHasUnsavedEdits } from './quoteDirty';

describe('stableStringify (key-order independence)', () => {
  it('gives two objects with the same values the same string regardless of key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('sorts keys at EVERY level, not just the top', () => {
    const one = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const two = { outer: { a: { b: 3, y: 2 }, z: 1 } };
    expect(stableStringify(one)).toBe(stableStringify(two));
  });

  it('still distinguishes a real value change', () => {
    expect(stableStringify({ frontFootage: 95 })).not.toBe(stableStringify({ frontFootage: 100 }));
  });

  it('preserves array ORDER (a reordered array is a real change, unlike reordered keys)', () => {
    expect(stableStringify({ lines: [1, 2] })).not.toBe(stableStringify({ lines: [2, 1] }));
  });

  it('does not confuse null with an object', () => {
    expect(stableStringify({ customerId: null })).toBe('{"customerId":null}');
  });
});

describe('quoteHasUnsavedEdits (the row-406 conjunction)', () => {
  const persisted = stableStringify({ frontFootage: 95 });
  const edited = stableStringify({ frontFootage: 100 });

  it('is TRUE for the confirmed defect: operator typed 95 -> 100 and has not saved', () => {
    expect(
      quoteHasUnsavedEdits({ userTouched: true, currentForm: edited, lastPersistedForm: persisted }),
    ).toBe(true);
  });

  it('is FALSE when a mount-time derive changed the form but nobody typed', () => {
    // The permanent-side derive and the satellite/footage effects call setForm
    // at mount on a reopened quote. That is not operator work and must not warn.
    expect(
      quoteHasUnsavedEdits({ userTouched: false, currentForm: edited, lastPersistedForm: persisted }),
    ).toBe(false);
  });

  it('is FALSE when the operator typed only into a non-persisted input', () => {
    // e.g. the HighLevel contact SEARCH box: keystrokes happen, the payload
    // never moves, so there is nothing a reload could lose.
    expect(
      quoteHasUnsavedEdits({ userTouched: true, currentForm: persisted, lastPersistedForm: persisted }),
    ).toBe(false);
  });

  it('is FALSE once an edit is typed and then undone back to the saved value', () => {
    expect(
      quoteHasUnsavedEdits({ userTouched: true, currentForm: persisted, lastPersistedForm: persisted }),
    ).toBe(false);
  });

  it('STAYS TRUE for an edit made while a save was in flight', () => {
    // The save persists the snapshot it SENT. The latch is never reset, so a
    // newer edit still compares against that sent snapshot and stays dirty.
    const sentAndPersisted = edited;
    const editedAgainDuringSave = stableStringify({ frontFootage: 105 });
    expect(
      quoteHasUnsavedEdits({
        userTouched: true,
        currentForm: editedAgainDuringSave,
        lastPersistedForm: sentAndPersisted,
      }),
    ).toBe(true);
  });

  it('is FALSE right after a successful save with no further edits', () => {
    expect(
      quoteHasUnsavedEdits({ userTouched: true, currentForm: edited, lastPersistedForm: edited }),
    ).toBe(false);
  });
});
