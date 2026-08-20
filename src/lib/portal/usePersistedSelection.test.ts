// Pure-logic test for the browsing-selection dedup key (ledger row 239). The
// house convention is pure-logic tests, no jsdom/hook-rendering — mirrors
// src/lib/leads/usePartialCapture.test.ts's coverage of its own dedup key.
//
// FIX (row 239 fix round 2, delta-verify HIGH) replaced the round-1 model
// (dedupKeyAfterFailedSave, a revert-on-failure CAS) with shouldSend, which
// `send()`'s success/failure handlers use directly — lastConfirmedKeyRef is
// only ever written on a CONFIRMED success, never reverted, so a value that
// was never actually saved can never be mistaken for one that was (see the
// shouldSend comment in usePersistedSelection.ts for the full trace of why
// round 1's revert-based model lost data on two consecutive failures, and
// why this model can't). This repo has no jsdom/happy-dom/@testing-library/
// react in node_modules or package.json (checked before writing this), so
// rendering the actual hook and mocking fetch/sendBeacon/document isn't
// possible — shouldSend is the hook's entire send-or-skip decision extracted
// to a pure function, same convention as selectionKey, so this is a direct
// test of the real logic, not a stand-in.

import { describe, it, expect } from 'vitest';
import { selectionKey, shouldSend, type PersistedSelectionFields } from './usePersistedSelection';

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

describe('shouldSend (fix round 2 — confirmed-only dedup, no revert)', () => {
  it('sends when the key differs from the last CONFIRMED key and nothing is in flight', () => {
    expect(shouldSend('B', 'A', new Set())).toBe(true);
  });

  it('skips when the key matches the last CONFIRMED key — nothing changed since the real save', () => {
    expect(shouldSend('A', 'A', new Set())).toBe(false);
  });

  it('skips when a request for this exact value is already in flight, even though it differs from the confirmed key', () => {
    expect(shouldSend('B', 'A', new Set(['B']))).toBe(false);
  });

  it('does not skip for a DIFFERENT in-flight value — only an exact-key match blocks', () => {
    expect(shouldSend('B', 'A', new Set(['C']))).toBe(true);
  });

  it('two different values can be in flight at once, and each is judged independently', () => {
    const inFlight = new Set(['A', 'B']);
    expect(shouldSend('A', 'K0', inFlight)).toBe(false); // A itself is in flight
    expect(shouldSend('C', 'K0', inFlight)).toBe(true); // C is neither confirmed nor in flight
  });

  it('replays the full six-step delta-verify sequence: two consecutive failures never lose data', () => {
    // The exact sequence the round-2 delta-verify found broken under round
    // 1's revert-based model. Traced here against the real shouldSend
    // decision plus the same only-on-success write rule send() uses.
    // lastConfirmedKey is never reassigned below — that IS the point: both
    // attempts fail, so nothing ever confirms A or B, and it stays K0
    // throughout (round 1's model wrongly moved it to A at step 4).
    const lastConfirmedKey = 'K0'; // whatever the server actually holds
    const inFlight = new Set<string>();

    // 1. Selection -> A. send() checks shouldSend, then claims the in-flight
    //    slot before the (slow) fetch goes out.
    expect(shouldSend('A', lastConfirmedKey, inFlight)).toBe(true);
    inFlight.add('A');

    // 2. Selection -> B before A resolves. Same check, independently true —
    //    A being in flight doesn't block a completely different value B.
    expect(shouldSend('B', lastConfirmedKey, inFlight)).toBe(true);
    inFlight.add('B');

    // 3. Fetch A fails: only inFlight is cleaned up. lastConfirmedKey is
    //    NEVER written on failure — no revert, nothing to get wrong.
    inFlight.delete('A');
    expect(lastConfirmedKey).toBe('K0');

    // 4. Fetch B fails: same — inFlight cleanup only, lastConfirmedKey untouched.
    inFlight.delete('B');
    expect(lastConfirmedKey).toBe('K0');

    // 5. lastConfirmedKey is STILL K0 — correctly reflecting that neither A
    //    nor B was ever actually saved (the server still holds K0).
    expect(lastConfirmedKey).toBe('K0');

    // 6. Customer flips back to A. Nothing is in flight for A any more, and
    //    A !== lastConfirmedKey (K0) -> shouldSend is true, so it retries.
    //    Round 1's model returned false here (the reverted slot equalled A)
    //    and silently lost the customer's real selection for good.
    expect(shouldSend('A', lastConfirmedKey, inFlight)).toBe(true);
  });

  it('a confirmed success updates the dedup key, so a later identical value is correctly skipped', () => {
    // Mirrors send()'s .then((res) => { if (res.ok) lastConfirmedKeyRef.current = key })
    let lastConfirmedKey = 'A';
    const inFlight = new Set<string>();

    expect(shouldSend('B', lastConfirmedKey, inFlight)).toBe(true);
    inFlight.add('B');
    // Fetch B succeeds:
    inFlight.delete('B');
    lastConfirmedKey = 'B';

    // A later settle recomputing the SAME value B is now correctly a no-op.
    expect(shouldSend('B', lastConfirmedKey, inFlight)).toBe(false);
  });
});
