import { describe, it, expect } from 'vitest';
import {
  reconcileHolidayFootageField,
  deriveHolidayFootageBaseline,
  mergeHolidayFootageBaseline,
  reconcileAnalysisFootage,
  type HolidayFootageBaseline,
  type HolidayFootageFieldKey,
  type HolidayFieldReconcileResult,
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

// S46 premerge finding 1 (HIGH, staff): the OLD wiring rebuilt
// prevHolidayDerivedRef.current from scratch every effect run — an inactive
// field's key (C9/stake off-holiday) never made it into the spread, so it
// was silently dropped instead of preserved. This is the naive
// "replace-not-merge" shape that bug shipped with, kept here ONLY to
// document/repro the class (never used by QuoteBuilder.tsx).
function legacyReplaceBaseline(
  results: Record<HolidayFootageFieldKey, HolidayFieldReconcileResult>,
): HolidayFootageBaseline {
  const baseline: HolidayFootageBaseline = {};
  (Object.keys(results) as HolidayFootageFieldKey[]).forEach((field) => {
    const nb = results[field].nextBaseline;
    if (nb != null) baseline[field] = nb;
  });
  return baseline;
}

describe('mergeHolidayFootageBaseline — finding 1 fix: an inactive field keeps its baseline', () => {
  it('preserves an inactive field key untouched, and recomputes an active one', () => {
    const prev: HolidayFootageBaseline = { santas: 100, c9: 40 };
    const results: Record<HolidayFootageFieldKey, HolidayFieldReconcileResult> = {
      santas: { target: 110, nextBaseline: 110 },
      gingerbread: { target: null, nextBaseline: undefined },
      // c9 inactive this run (off-holiday) — its own result is whatever
      // reconcileHolidayFootageField's inactive branch returns, but the
      // merge must not even look at it.
      c9: { target: null, nextBaseline: undefined },
      stake: { target: null, nextBaseline: undefined },
    };
    const next = mergeHolidayFootageBaseline(
      prev,
      { santas: true, gingerbread: true, c9: false, stake: false },
      results,
    );
    expect(next).toEqual({ santas: 110, c9: 40 }); // c9 survives inactivity
  });

  it('clears an ACTIVE field whose result reports no baseline (its last line was deleted)', () => {
    // stake carries a baseline while INACTIVE: the merge must preserve it,
    // which a naive replace-not-merge drops. The S46 delta-verify proved the
    // earlier all-active fixture passed under BOTH implementations by
    // coincidence, so the inactive key is what makes this test discriminate.
    const prev: HolidayFootageBaseline = { santas: 100, c9: 40, stake: 25 };
    const results: Record<HolidayFootageFieldKey, HolidayFieldReconcileResult> = {
      santas: { target: null, nextBaseline: 100 },
      gingerbread: { target: null, nextBaseline: undefined },
      c9: { target: 0, nextBaseline: undefined }, // active, last line just deleted
      stake: { target: null, nextBaseline: undefined },
    };
    const next = mergeHolidayFootageBaseline(
      prev,
      { santas: true, gingerbread: true, c9: true, stake: false },
      results,
    );
    // c9 key removed (ACTIVE, reported none) · stake preserved (INACTIVE)
    expect(next).toEqual({ santas: 100, stake: 25 });
  });
});

// S46 premerge finding 1 — the round-trip regression the fix brief asked
// for: an override survives a full toggle-away/toggle-back cycle, composed
// from the exact two functions QuoteBuilder.tsx's real effect chains
// together each run (reconcileHolidayFootageField +
// mergeHolidayFootageBaseline). No component-render harness exists for
// QuoteBuilder.tsx (see the reopen-clobber composed test above for the same
// convention).
describe('row 333 / S46 finding 1 — c9 override survives a holiday -> event -> holiday round trip', () => {
  it('with the FIX (merge): the c9 override is still standing after toggling away and back', () => {
    // Run 1 (holiday): both santas and c9 are drawn for the first time —
    // brand-new baseline, auto-populate.
    let baseline: HolidayFootageBaseline = {};
    const run1 = {
      santas: reconcileHolidayFootageField({ active: true, hasLines: true, hadLinesPrev: false, freshFt: 100, currentBilled: 0, baseline: baseline.santas }),
      gingerbread: reconcileHolidayFootageField({ active: true, hasLines: false, hadLinesPrev: false, freshFt: 0, currentBilled: 0, baseline: baseline.gingerbread }),
      c9: reconcileHolidayFootageField({ active: true, hasLines: true, hadLinesPrev: false, freshFt: 40, currentBilled: 0, baseline: baseline.c9 }),
      stake: reconcileHolidayFootageField({ active: true, hasLines: false, hadLinesPrev: false, freshFt: 0, currentBilled: 0, baseline: baseline.stake }),
    };
    baseline = mergeHolidayFootageBaseline(
      baseline,
      { santas: true, gingerbread: true, c9: true, stake: true },
      run1,
    );
    expect(baseline).toEqual({ santas: 100, c9: 40 });
    // Staff hand-types a c9 override (60ft) sometime after — no reconcile
    // call happens from typing alone, only billed state changes.
    const c9Billed = 60;

    // Run 2: toggle to Event, then redraw santas (an always-active field) —
    // the shared effect re-fires; c9/stake are gated off (isHoliday=false).
    const run2 = {
      santas: reconcileHolidayFootageField({ active: true, hasLines: true, hadLinesPrev: true, freshFt: 110, currentBilled: 100, baseline: baseline.santas }),
      gingerbread: reconcileHolidayFootageField({ active: true, hasLines: false, hadLinesPrev: false, freshFt: 0, currentBilled: 0, baseline: baseline.gingerbread }),
      c9: reconcileHolidayFootageField({ active: false, hasLines: true, hadLinesPrev: true, freshFt: 40, currentBilled: c9Billed, baseline: baseline.c9 }),
      stake: reconcileHolidayFootageField({ active: false, hasLines: false, hadLinesPrev: false, freshFt: 0, currentBilled: 0, baseline: baseline.stake }),
    };
    baseline = mergeHolidayFootageBaseline(
      baseline,
      { santas: true, gingerbread: true, c9: false, stake: false },
      run2,
    );
    expect(baseline).toEqual({ santas: 110, c9: 40 }); // c9's baseline survived the inactive run

    // Run 3: toggle back to holiday, edit again (redraw gingerbread) — c9's
    // OWN geometry never changed (still 40ft), and its baseline (40) is
    // still on record, so the override (60) is recognized and kept.
    const run3 = {
      santas: reconcileHolidayFootageField({ active: true, hasLines: true, hadLinesPrev: true, freshFt: 110, currentBilled: 110, baseline: baseline.santas }),
      gingerbread: reconcileHolidayFootageField({ active: true, hasLines: true, hadLinesPrev: false, freshFt: 75, currentBilled: 0, baseline: baseline.gingerbread }),
      c9: reconcileHolidayFootageField({ active: true, hasLines: true, hadLinesPrev: true, freshFt: 40, currentBilled: c9Billed, baseline: baseline.c9 }),
      stake: reconcileHolidayFootageField({ active: true, hasLines: false, hadLinesPrev: false, freshFt: 0, currentBilled: 0, baseline: baseline.stake }),
    };
    expect(run3.c9.target).toBeNull(); // the override survives — nothing stamps it back to 40
  });

  it('WITHOUT the fix (naive replace-not-merge), the same round trip clobbers the override', () => {
    let baseline: HolidayFootageBaseline = {};
    const run1 = {
      santas: reconcileHolidayFootageField({ active: true, hasLines: true, hadLinesPrev: false, freshFt: 100, currentBilled: 0, baseline: baseline.santas }),
      gingerbread: reconcileHolidayFootageField({ active: true, hasLines: false, hadLinesPrev: false, freshFt: 0, currentBilled: 0, baseline: baseline.gingerbread }),
      c9: reconcileHolidayFootageField({ active: true, hasLines: true, hadLinesPrev: false, freshFt: 40, currentBilled: 0, baseline: baseline.c9 }),
      stake: reconcileHolidayFootageField({ active: true, hasLines: false, hadLinesPrev: false, freshFt: 0, currentBilled: 0, baseline: baseline.stake }),
    };
    baseline = legacyReplaceBaseline(run1);
    const c9Billed = 60;

    // Run 2: toggle to Event, redraw santas. The legacy replace rebuilds the
    // baseline from ONLY this run's results — c9/stake are inactive and
    // report nextBaseline: undefined, so their keys vanish entirely.
    const run2 = {
      santas: reconcileHolidayFootageField({ active: true, hasLines: true, hadLinesPrev: true, freshFt: 110, currentBilled: 100, baseline: baseline.santas }),
      gingerbread: reconcileHolidayFootageField({ active: true, hasLines: false, hadLinesPrev: false, freshFt: 0, currentBilled: 0, baseline: baseline.gingerbread }),
      c9: reconcileHolidayFootageField({ active: false, hasLines: true, hadLinesPrev: true, freshFt: 40, currentBilled: c9Billed, baseline: baseline.c9 }),
      stake: reconcileHolidayFootageField({ active: false, hasLines: false, hadLinesPrev: false, freshFt: 0, currentBilled: 0, baseline: baseline.stake }),
    };
    baseline = legacyReplaceBaseline(run2);
    expect(baseline).toEqual({ santas: 110 }); // BUG: c9's baseline is gone

    // Run 3: toggle back to holiday, edit again. c9 now has NO recorded
    // baseline, so it's treated as a brand-new draw and its fresh (unchanged)
    // geometry stamps straight over the standing override.
    const run3c9 = reconcileHolidayFootageField({
      active: true, hasLines: true, hadLinesPrev: true, freshFt: 40, currentBilled: c9Billed, baseline: baseline.c9,
    });
    expect(run3c9.target).toBe(40); // BUG: the override is clobbered back to raw geometry
    expect(run3c9.target).not.toBe(null);
  });
});

// S46 premerge finding 2 (technical MED): React StrictMode dev double-invokes
// a setState functional updater to check purity — it discards the first
// call's RETURN VALUE, but not any side effect performed during that call.
// The fix moved the ref mutation OUT of the updater entirely, so these pure
// helpers are now called exactly once per effect run and never need to
// tolerate being invoked twice with a self-referential ref argument — but
// this documents that they're safe to call twice with IDENTICAL inputs
// regardless (same result both times, no hidden state).
describe('S46 finding 2 — reconcile helpers are idempotent under repeated calls with identical inputs', () => {
  it('reconcileHolidayFootageField returns the same result called twice with the same inputs', () => {
    const input = {
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshFt: 130,
      currentBilled: 120,
      baseline: 100,
    };
    const call1 = reconcileHolidayFootageField(input);
    const call2 = reconcileHolidayFootageField(input);
    expect(call2).toEqual(call1);
    expect(call2).toEqual({ target: 130, nextBaseline: 130 });
  });

  it('mergeHolidayFootageBaseline returns the same result called twice with the same inputs', () => {
    const prev: HolidayFootageBaseline = { santas: 100, c9: 40 };
    const active = { santas: true, gingerbread: true, c9: false, stake: false };
    const results: Record<HolidayFootageFieldKey, HolidayFieldReconcileResult> = {
      santas: { target: 110, nextBaseline: 110 },
      gingerbread: { target: null, nextBaseline: undefined },
      c9: { target: null, nextBaseline: undefined },
      stake: { target: null, nextBaseline: undefined },
    };
    const call1 = mergeHolidayFootageBaseline(prev, active, results);
    const call2 = mergeHolidayFootageBaseline(prev, active, results);
    expect(call2).toEqual(call1);
    expect(call2).toEqual({ santas: 110, c9: 40 });
    // and the shared input object was never mutated by either call
    expect(prev).toEqual({ santas: 100, c9: 40 });
  });
});

describe('row 209: reconcileAnalysisFootage — street re-analyze must not clobber satellite-derived footage', () => {
  it('applies the AI text estimate for a field with no satellite lines drawn (the ordinary, un-clobbered case)', () => {
    const out = reconcileAnalysisFootage({
      aiSantasFootage: 80,
      aiGingerbreadFootage: 45,
      hasSatelliteSantasLines: false,
      hasSatelliteGingerbreadLines: false,
      satelliteHasScale: true,
    });
    expect(out).toEqual({ santasFootage: 80, gingerbreadFootage: 45 });
  });

  it('keeps the field untouched (omits it) when satellite lines already exist for it', () => {
    const out = reconcileAnalysisFootage({
      aiSantasFootage: 80,
      aiGingerbreadFootage: 45,
      hasSatelliteSantasLines: true,
      hasSatelliteGingerbreadLines: true,
      satelliteHasScale: true,
    });
    expect(out).toEqual({});
  });

  it('is independent per field: santas has satellite lines, gingerbread does not', () => {
    const out = reconcileAnalysisFootage({
      aiSantasFootage: 80,
      aiGingerbreadFootage: 45,
      hasSatelliteSantasLines: true,
      hasSatelliteGingerbreadLines: false,
      satelliteHasScale: true,
    });
    // santas is omitted (kept from satellite geometry); gingerbread applies
    // the AI text estimate, because it has nothing else to go on yet.
    expect(out).toEqual({ gingerbreadFootage: 45 });
  });

  it('the reverse split: gingerbread has satellite lines, santas does not', () => {
    const out = reconcileAnalysisFootage({
      aiSantasFootage: 80,
      aiGingerbreadFootage: 45,
      hasSatelliteSantasLines: false,
      hasSatelliteGingerbreadLines: true,
      satelliteHasScale: true,
    });
    expect(out).toEqual({ santasFootage: 80 });
  });

  // Fix round (staff lens MED): the manual-satellite flow (#9) traces lines
  // with NO scale, purely for training value — nothing was ever DERIVED from
  // them (the measurement effect bails on null scale), so the AI estimate is
  // still the only real measurement and must apply.
  it('scale-less manual-satellite lines do NOT protect a field — the AI estimate still applies', () => {
    const out = reconcileAnalysisFootage({
      aiSantasFootage: 80,
      aiGingerbreadFootage: 45,
      hasSatelliteSantasLines: true,
      hasSatelliteGingerbreadLines: true,
      satelliteHasScale: false,
    });
    expect(out).toEqual({ santasFootage: 80, gingerbreadFootage: 45 });
  });
});
