import { describe, it, expect } from 'vitest';
import {
  reconcileHolidayFootageField,
  deriveHolidayFootageBaseline,
} from './reconcileFootage';

// Row 333 premise verification: a faithful pure extraction of the PRE-FIX
// QuoteBuilder.tsx derive effect logic (the `sameSantas`/`santasTarget`
// shape at the top of master, before this PR — see the row-333 PR body for
// the exact pre-fix line range). It compares each field's CURRENT BILLED
// value straight against its freshly re-derived target, with no baseline —
// this is what the four fields' shared single derive effect actually did.
function legacyFieldTarget(
  hasLines: boolean,
  hadLinesPrev: boolean,
  freshFt: number,
  currentBilled: number,
): number | null {
  const target = hasLines ? freshFt : hadLinesPrev ? 0 : null;
  const same = target == null || currentBilled === target;
  return same ? null : target;
}

describe('row 333 premise: the pre-fix (legacy) target comparison clobbers an untouched field', () => {
  it('reproduces the flaw: redrawing gingerbread resets a hand-typed santas override', () => {
    // Santas has lines that still derive to 100ft (unchanged geometry), but
    // staff hand-typed an override of 120ft. Because the OLD logic compares
    // the billed value straight against the freshly re-derived target with
    // no baseline, it cannot tell "override" apart from "stale" — any effect
    // re-fire (triggered here by an UNRELATED gingerbread redraw sharing the
    // same dependency array) stamps santas back to 100.
    const santasResult = legacyFieldTarget(
      /* hasLines */ true,
      /* hadLinesPrev */ true,
      /* freshFt (santas lines unchanged) */ 100,
      /* currentBilled (staff override) */ 120,
    );
    expect(santasResult).toBe(100); // BUG: the override is clobbered
    expect(santasResult).not.toBe(120);
  });
});

describe('reconcileHolidayFootageField — the fix: baseline-keyed, survives an unrelated field redraw', () => {
  it('auto-populates a brand-new field (no prior baseline)', () => {
    const result = reconcileHolidayFootageField({
      active: true,
      hasLines: true,
      hadLinesPrev: false,
      freshFt: 100,
      currentBilled: 0,
      baseline: undefined,
    });
    expect(result).toEqual({ target: 100, nextBaseline: 100 });
  });

  it('follows the derive when nothing has been overridden', () => {
    const result = reconcileHolidayFootageField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshFt: 100,
      currentBilled: 100,
      baseline: 100,
    });
    expect(result).toEqual({ target: null, nextBaseline: 100 });
  });

  it('preserves a hand-typed override when THIS field itself is unchanged (the row-333 repro, fixed)', () => {
    // Same scenario as the legacy repro above — santas unchanged (freshFt
    // still 100, matching its recorded baseline), staff overrode it to 120 —
    // but this time reconcile sees the baseline and knows 120 is a deliberate
    // override, not staleness.
    const result = reconcileHolidayFootageField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshFt: 100,
      currentBilled: 120,
      baseline: 100,
    });
    expect(result.target).toBeNull(); // override survives — no stamp
    expect(result.nextBaseline).toBe(100);
  });

  it('resets an override when THAT field itself is redrawn (staff redraw wins)', () => {
    const result = reconcileHolidayFootageField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshFt: 130, // fresh geometry now derives to 130, was 100
      currentBilled: 120, // staff had overridden it to 120
      baseline: 100,
    });
    expect(result).toEqual({ target: 130, nextBaseline: 130 });
  });

  it('resets to 0 and clears the baseline when the last line is deleted', () => {
    const result = reconcileHolidayFootageField({
      active: true,
      hasLines: false,
      hadLinesPrev: true,
      freshFt: 0,
      currentBilled: 120,
      baseline: 100,
    });
    expect(result).toEqual({ target: 0, nextBaseline: undefined });
  });

  it('leaves a manual-only field alone when it never had lines', () => {
    const result = reconcileHolidayFootageField({
      active: true,
      hasLines: false,
      hadLinesPrev: false,
      freshFt: 0,
      currentBilled: 50,
      baseline: undefined,
    });
    expect(result).toEqual({ target: null, nextBaseline: undefined });
  });

  it('auto-populates when lines exist but no baseline was ever recorded (reopen-clobber guard not yet seeded)', () => {
    // Documents why QuoteBuilder's getSetter MUST seed the baseline before
    // the first post-thaw effect run — this function's job is not to guess
    // intent when it has no baseline at all.
    const result = reconcileHolidayFootageField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshFt: 100,
      currentBilled: 120, // an override that predates the seed
      baseline: undefined,
    });
    expect(result.target).toBe(100); // clobbered — this is why the seed exists
  });

  it('never touches a gated-off field (C9/stake on a non-holiday quote), regardless of lines', () => {
    const result = reconcileHolidayFootageField({
      active: false,
      hasLines: true,
      hadLinesPrev: true,
      freshFt: 40,
      currentBilled: 999,
      baseline: 30,
    });
    expect(result).toEqual({ target: null, nextBaseline: undefined });
  });
});

describe('reconcileHolidayFootageField — composed cross-field scenario (the row-333 repro, fixed end to end)', () => {
  it('redrawing gingerbread does not clobber an untouched santas override', () => {
    // Baseline from the last reconcile: santas derives to 100, gingerbread to 60.
    const baseline: Record<'santas' | 'gingerbread', number> = { santas: 100, gingerbread: 60 };
    // Staff hand-typed santas to 120 sometime after the last reconcile.
    const billed = { santas: 120, gingerbread: 60 };

    // Gingerbread gets redrawn (its own geometry actually changes to 75);
    // santas's lines are untouched (still derive to 100) but the SHARED
    // effect re-fires for both because they're in one dependency array.
    const santasResult = reconcileHolidayFootageField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshFt: 100, // unchanged
      currentBilled: billed.santas,
      baseline: baseline.santas,
    });
    const gingerbreadResult = reconcileHolidayFootageField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshFt: 75, // redrawn
      currentBilled: billed.gingerbread,
      baseline: baseline.gingerbread,
    });

    expect(santasResult.target).toBeNull(); // override survives
    expect(gingerbreadResult.target).toBe(75); // redraw wins for the touched field
  });
});

describe('deriveHolidayFootageBaseline (the seed decision QuoteBuilder.getSetter calls on thaw)', () => {
  it('seeds a baseline entry for every field that currently has lines', () => {
    const baseline = deriveHolidayFootageBaseline({
      santas: { hasLines: true, freshFt: 100 },
      gingerbread: { hasLines: true, freshFt: 60 },
      c9: { active: true, hasLines: true, freshFt: 40 },
      stake: { active: true, hasLines: false, freshFt: 0 },
    });
    expect(baseline).toEqual({ santas: 100, gingerbread: 60, c9: 40 });
  });

  it('skips C9/stake when not active (non-holiday quote), even with lines drawn', () => {
    const baseline = deriveHolidayFootageBaseline({
      santas: { hasLines: true, freshFt: 100 },
      gingerbread: { hasLines: false, freshFt: 0 },
      c9: { active: false, hasLines: true, freshFt: 40 },
      stake: { active: false, hasLines: true, freshFt: 20 },
    });
    expect(baseline).toEqual({ santas: 100 });
  });

  it('produces an empty baseline when nothing has lines', () => {
    const baseline = deriveHolidayFootageBaseline({
      santas: { hasLines: false, freshFt: 0 },
      gingerbread: { hasLines: false, freshFt: 0 },
      c9: { active: true, hasLines: false, freshFt: 0 },
      stake: { active: true, hasLines: false, freshFt: 0 },
    });
    expect(baseline).toEqual({});
  });
});

// Row 333 — reopen-clobber composed regression, mirrors reconcileFootage.test.ts's
// (#244) "rehydrate -> first-edit -> derive" composed test. No component-render
// harness exists for QuoteBuilder.tsx, so this composes the exact two pure
// functions QuoteBuilder.tsx's real code path chains together: the getSetter
// thaw seed (deriveHolidayFootageBaseline) -> the derive effect
// (reconcileHolidayFootageField).
describe('row 333 reopen-clobber guard — rehydrate -> first-edit -> derive (composed)', () => {
  it('a santas override survives the first post-rehydrate edit, even though gingerbread redraws', () => {
    // Rehydrate: santas persisted with a staff override (120ft) that
    // disagrees with its own geometry (still derives to 100ft — never
    // redrawn, staff tape-measured it). Gingerbread persisted at 60ft,
    // matching its geometry.
    const seededBaseline = deriveHolidayFootageBaseline({
      santas: { hasLines: true, freshFt: 100 },
      gingerbread: { hasLines: true, freshFt: 60 },
      c9: { active: true, hasLines: false, freshFt: 0 },
      stake: { active: true, hasLines: false, freshFt: 0 },
    });

    // First edit: staff redraws gingerbread only — santas's lines are
    // untouched, but the shared derive effect still re-fires for both.
    const santasResult = reconcileHolidayFootageField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshFt: 100, // unchanged
      currentBilled: 120, // the override
      baseline: seededBaseline.santas,
    });
    const gingerbreadResult = reconcileHolidayFootageField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshFt: 80, // redrawn
      currentBilled: 60,
      baseline: seededBaseline.gingerbread,
    });

    expect(santasResult.target).toBeNull(); // override survives — the guard this test protects
    expect(gingerbreadResult.target).toBe(80);
  });

  it('WITHOUT the seed (baseline empty, the pre-row-333 bug), the same first edit clobbers the override', () => {
    const santasResult = reconcileHolidayFootageField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshFt: 100,
      currentBilled: 120,
      baseline: undefined, // no seed at all
    });
    expect(santasResult.target).toBe(100); // clobbered — this is the bug the seed prevents
  });
});
