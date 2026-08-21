import { describe, it, expect } from 'vitest';
import { reconcileBistroFootage, roundBistroFootageOnBlur } from './reconcileFootage';

describe('reconcileBistroFootage', () => {
  it('auto-populates a brand-new run (no prior baseline, no billed entry)', () => {
    const result = reconcileBistroFootage(
      [{ id: 'a', footage: 20 }],
      [],
      {},
    );
    expect(result.next).toEqual([{ id: 'a', footage: 20 }]);
    expect(result.nextBaseline).toEqual({ a: 20 });
  });

  it('follows the derive when nothing has been overridden', () => {
    const result = reconcileBistroFootage(
      [{ id: 'a', footage: 20 }, { id: 'b', footage: 15 }],
      [{ id: 'a', footage: 20 }, { id: 'b', footage: 15 }],
      { a: 20, b: 15 },
    );
    expect(result.next).toEqual([{ id: 'a', footage: 20 }, { id: 'b', footage: 15 }]);
    expect(result.nextBaseline).toEqual({ a: 20, b: 15 });
  });

  it('preserves a hand-typed override on an UNTOUCHED run when a DIFFERENT run redraws', () => {
    // Run 'a' was overridden to 35 (baseline still says its geometry derives
    // to 20). Run 'b' gets a fresh run 'c' added alongside it — 'a' must not
    // move just because the shared satelliteBistroLines array changed.
    const result = reconcileBistroFootage(
      [{ id: 'a', footage: 20 }, { id: 'b', footage: 15 }, { id: 'c', footage: 8 }],
      [{ id: 'a', footage: 35 }, { id: 'b', footage: 15 }],
      { a: 20, b: 15 },
    );
    expect(result.next).toEqual([
      { id: 'a', footage: 35 }, // override survives
      { id: 'b', footage: 15 }, // untouched, follows derive
      { id: 'c', footage: 8 },  // new run, auto-populated
    ]);
    expect(result.nextBaseline).toEqual({ a: 20, b: 15, c: 8 });
  });

  it('resets an override when THAT run itself is redrawn (staff redraw wins)', () => {
    const result = reconcileBistroFootage(
      [{ id: 'a', footage: 27 }], // fresh geometry now derives to 27, was 20
      [{ id: 'a', footage: 35 }], // staff had overridden it to 35
      { a: 20 },
    );
    expect(result.next).toEqual([{ id: 'a', footage: 27 }]);
    expect(result.nextBaseline).toEqual({ a: 27 });
  });

  it('drops a deleted run from both the output and the next baseline', () => {
    const result = reconcileBistroFootage(
      [{ id: 'b', footage: 15 }], // 'a' no longer drawn
      [{ id: 'a', footage: 35 }, { id: 'b', footage: 15 }],
      { a: 20, b: 15 },
    );
    expect(result.next).toEqual([{ id: 'b', footage: 15 }]);
    expect(result.nextBaseline).toEqual({ b: 15 });
  });

  it('auto-populates when a billed entry exists but carries no recorded baseline (reopen-clobber guard not yet seeded)', () => {
    // This is the shape a NOT-yet-seeded reconcile would see right after a
    // reopen if the baseline seed step were skipped — documents why
    // QuoteBuilder's getSetter('bistro') MUST seed the baseline before the
    // first post-thaw effect run, not this function's job to guess intent.
    const result = reconcileBistroFootage(
      [{ id: 'a', footage: 20 }],
      [{ id: 'a', footage: 35 }],
      {},
    );
    expect(result.next).toEqual([{ id: 'a', footage: 20 }]);
  });

  it('treats a run with no id as always-follow-the-derive (no identity to preserve an override against)', () => {
    const result = reconcileBistroFootage(
      [{ footage: 20 }],
      [{ footage: 999 }],
      {},
    );
    expect(result.next).toEqual([{ footage: 20 }]);
    expect(result.nextBaseline).toEqual({});
  });

  it('no-ops cleanly on an empty freshRuns list', () => {
    const result = reconcileBistroFootage([], [{ id: 'a', footage: 35 }], { a: 20 });
    expect(result.next).toEqual([]);
    expect(result.nextBaseline).toEqual({});
  });
});

// #244 premerge finding 1 (HIGH, money — #139 parity).
describe('roundBistroFootageOnBlur', () => {
  it('rounds a hand-typed value up to the next 5ft step', () => {
    expect(roundBistroFootageOnBlur(22)).toBe(25);
    expect(roundBistroFootageOnBlur(37)).toBe(40);
  });

  it('no-ops (returns null) when already a multiple of 5', () => {
    expect(roundBistroFootageOnBlur(35)).toBeNull();
    expect(roundBistroFootageOnBlur(0)).toBeNull();
  });

  it('no-ops (returns null) when nothing has been typed yet', () => {
    expect(roundBistroFootageOnBlur(null)).toBeNull();
  });
});
