import { describe, it, expect } from 'vitest';
import { reconcileBistroFootage, deriveBistroFootageMap, roundBistroFootageOnBlur } from './reconcileFootage';

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

// #244 premerge finding 3 (technical, MED — reopen-clobber seed guard).
describe('deriveBistroFootageMap (the seed decision QuoteBuilder.getSetter(\'bistro\') calls)', () => {
  it('maps each id-carrying line to its computed footage', () => {
    const lines = [{ id: 'a', points: [] }, { id: 'b', points: [] }];
    const map = deriveBistroFootageMap(lines, (l) => (l.id === 'a' ? 20 : 15));
    expect(map).toEqual({ a: 20, b: 15 });
  });

  it('skips a line with no stable id (nothing to key the baseline on)', () => {
    const lines = [{ points: [] }, { id: 'b', points: [] }];
    const map = deriveBistroFootageMap(lines, () => 20);
    expect(map).toEqual({ b: 20 });
  });

  it('skips a line whose footage cannot be computed yet (null — no satellite scale)', () => {
    const lines = [{ id: 'a', points: [] }];
    const map = deriveBistroFootageMap(lines, () => null);
    expect(map).toEqual({});
  });
});

// #244 premerge finding 3: WIRING-LEVEL test — no component-render harness
// exists in this repo for QuoteBuilder.tsx (no jsdom/testing-library in this
// project's vitest setup), so this composes the exact two pure functions
// QuoteBuilder.tsx's real code path chains together (getSetter('bistro')'s
// seed step -> deriveBistroFootageMap; the derive effect -> reconcileBistroFootage)
// to exercise rehydrate -> first-edit -> derive end to end. See the report for
// the mutation-probe that confirms this actually fails without the seed.
describe('#244 reopen-clobber guard — rehydrate -> first-edit -> derive (composed)', () => {
  it('an existing override survives the FIRST post-rehydrate edit, even though a DIFFERENT run redraws', () => {
    // Rehydrate: two persisted runs. Run 'a' was saved with a staff override
    // (35ft) that disagrees with its own geometry (which still derives to 20ft
    // — the operator typed 35 by tape measure, never redrew the line).
    const persistedLines = [
      { id: 'a', points: [[0, 0], [1, 0]] as [number, number][] },
      { id: 'b', points: [[0, 0], [0, 1]] as [number, number][] },
    ];
    const billedForm = [
      { id: 'a', footage: 35 },
      { id: 'b', footage: 15 },
    ];
    const computeFootage = (l: { id?: string }) => (l.id === 'a' ? 20 : 15);

    // getSetter('bistro')'s seed step: fires on the FIRST edit while still
    // frozen (#142), seeded from the CURRENT pre-edit lines.
    const seededBaseline = deriveBistroFootageMap(persistedLines, computeFootage);

    // First edit: the operator redraws run 'b' only — 'a's geometry is
    // unchanged, but the shared satelliteBistroLines array still re-fires the
    // derive effect for BOTH runs.
    const freshRuns = persistedLines.map((l) => ({ id: l.id, footage: computeFootage(l) }));
    const { next } = reconcileBistroFootage(freshRuns, billedForm, seededBaseline);

    expect(next).toEqual([
      { id: 'a', footage: 35 }, // override survives — the guard this test protects
      { id: 'b', footage: 15 },
    ]);
  });

  it('WITHOUT the seed (baseline empty, the pre-#244-guard bug), the same first edit clobbers the override', () => {
    const billedForm = [{ id: 'a', footage: 35 }];
    const freshRuns = [{ id: 'a', footage: 20 }];

    const { next } = reconcileBistroFootage(freshRuns, billedForm, {}); // no seed at all
    expect(next).toEqual([{ id: 'a', footage: 20 }]); // clobbered — this is the bug the seed prevents
  });
});

// #244 delta-verify HIGH (money-silent): the previous fix round's
// window.confirm before "Analyze from Address" discards bistro runs did NOT
// actually protect a hand-typed override on Cancel, because
// setSatelliteFeetPerPixel(the NEW scale) already fires unconditionally
// BEFORE the confirm block in QuoteBuilder.tsx (~line 2644) — so a decline
// left permDeriveFrozenRef untouched (still thawed from the earlier draw) and
// the kept run re-derived against the new scale on the next effect pass,
// with reconcileBistroFootage's "this run's geometry changed -> redraw wins"
// branch silently clobbering the override. The fix freezes the derive on
// decline (QuoteBuilder.tsx's `else { permDeriveFrozenRef.current = true; }`
// in the same block). No component-render harness exists for QuoteBuilder.tsx
// (same limitation the file's other "composed" describe block above
// documents), so this models the derive effect's own guard shape exactly —
// `if (permDeriveFrozenRef.current) return;` (QuoteBuilder.tsx ~line 1774)
// before it would otherwise call reconcileBistroFootage — via a local
// `frozen` flag standing in for the ref.
describe('#244 delta-verify HIGH — Analyze-from-Address decline must freeze the derive, not just window.confirm()', () => {
  // Mirrors QuoteBuilder.tsx's derive effect body exactly: frozen -> no-op
  // (never calls reconcile); unfrozen -> reconcile against the fresh,
  // new-scale-derived footage.
  const simulateBistroDeriveEffect = (
    frozen: boolean,
    freshRuns: Parameters<typeof reconcileBistroFootage>[0],
    currentForm: Parameters<typeof reconcileBistroFootage>[1],
    baseline: Parameters<typeof reconcileBistroFootage>[2],
  ) =>
    frozen
      ? { next: currentForm, nextBaseline: baseline }
      : reconcileBistroFootage(freshRuns, currentForm, baseline);

  // Run 'a': drawn once, auto-derived to 20ft at the OLD scale (baseline
  // records 20). Staff then hand-typed an override of 35ft (tape measure).
  const baseline = { a: 20 };
  const billedFormWithOverride = [{ id: 'a', footage: 35 }];
  // Analyze-from-Address re-runs and pulls a NEW satellite scale; the SAME
  // (unredrawn) geometry now derives to a different footage under it —
  // exactly the repro's 35 -> ~22 clobber.
  const freshRunsAtNewScale = [{ id: 'a', footage: 22 }];

  it('FROZEN (the fix — decline sets permDeriveFrozenRef.current = true): the override survives the scale change', () => {
    const result = simulateBistroDeriveEffect(true, freshRunsAtNewScale, billedFormWithOverride, baseline);
    expect(result.next).toEqual([{ id: 'a', footage: 35 }]); // override survives
  });

  it('UNFROZEN (the bug — decline left the derive thawed): the same scale change silently clobbers the override', () => {
    const result = simulateBistroDeriveEffect(false, freshRunsAtNewScale, billedFormWithOverride, baseline);
    expect(result.next).toEqual([{ id: 'a', footage: 22 }]); // clobbered — this was the bug
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
