import { describe, it, expect } from 'vitest';
import {
  reconcilePermanentSideField,
  derivePermanentSideFootageBaseline,
  mergePermanentSideFootageBaseline,
  type PermanentSideFootageBaseline,
  type PermanentSideFieldKey,
  type PermanentSideFieldReconcileResult,
} from './reconcileSideFootage';

// Row 345 premise verification: a faithful pure extraction of the PRE-FIX
// QuoteBuilder.tsx permanent-side derive effect logic (the direct
// `t[side].footage != null && n.<side>Footage !== t[side].footage` shape at
// lines ~1882-1909 on master before this PR). It compares each field's
// CURRENT BILLED value straight against its freshly re-derived target, with
// no baseline — this is what the four sides' shared single derive effect
// actually did for both footage and corners.
function legacyFieldTarget(
  hasLines: boolean,
  hadLinesPrev: boolean,
  freshValue: number,
  currentBilled: number,
): number | null {
  const target = hasLines ? freshValue : hadLinesPrev ? 0 : null;
  if (target == null) return null;
  return currentBilled !== target ? target : null;
}

describe('row 345 premise: the pre-fix (legacy) target comparison clobbers an untouched side', () => {
  it('reproduces the flaw: redrawing the front roofline resets a hand-typed left-footage override', () => {
    // Left has lines that still derive to 40ft (unchanged geometry), but
    // staff hand-typed an override of 55ft (tape-measured around an AC
    // unit the satellite trace can't see). Because the OLD logic compares
    // the billed value straight against the freshly re-derived target with
    // no baseline, it cannot tell "override" apart from "stale" — any
    // effect re-fire (triggered here by an UNRELATED front redraw sharing
    // the same permanentSatLines object / dependency array) stamps left
    // back to 40.
    const leftResult = legacyFieldTarget(
      /* hasLines */ true,
      /* hadLinesPrev */ true,
      /* freshValue (left lines unchanged) */ 40,
      /* currentBilled (staff override) */ 55,
    );
    expect(leftResult).toBe(40); // BUG: the override is clobbered
    expect(leftResult).not.toBe(55);
  });
});

describe('reconcilePermanentSideField — the fix: baseline-keyed, survives an unrelated side redraw', () => {
  it('auto-populates a brand-new field (no prior baseline)', () => {
    const result = reconcilePermanentSideField({
      active: true,
      hasLines: true,
      hadLinesPrev: false,
      freshValue: 40,
      currentBilled: 0,
      baseline: undefined,
    });
    expect(result).toEqual({ target: 40, nextBaseline: 40 });
  });

  it('follows the derive when nothing has been overridden', () => {
    const result = reconcilePermanentSideField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 40,
      currentBilled: 40,
      baseline: 40,
    });
    expect(result).toEqual({ target: null, nextBaseline: 40 });
  });

  it('preserves a hand-typed override when THIS field itself is unchanged (the row-345 repro, fixed)', () => {
    // Same scenario as the legacy repro above — left unchanged (freshValue
    // still 40, matching its recorded baseline), staff overrode it to 55 —
    // but this time reconcile sees the baseline and knows 55 is a
    // deliberate override, not staleness.
    const result = reconcilePermanentSideField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 40,
      currentBilled: 55,
      baseline: 40,
    });
    expect(result.target).toBeNull(); // override survives — no stamp
    expect(result.nextBaseline).toBe(40);
  });

  it('resets an override when THAT field itself is redrawn (staff redraw wins)', () => {
    const result = reconcilePermanentSideField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 65, // fresh geometry now derives to 65, was 40
      currentBilled: 55, // staff had overridden it to 55
      baseline: 40,
    });
    expect(result).toEqual({ target: 65, nextBaseline: 65 });
  });

  it('resets to 0 and clears the baseline when the last line on a side is deleted', () => {
    const result = reconcilePermanentSideField({
      active: true,
      hasLines: false,
      hadLinesPrev: true,
      freshValue: 0,
      currentBilled: 55,
      baseline: 40,
    });
    expect(result).toEqual({ target: 0, nextBaseline: undefined });
  });

  it('leaves a manual-only field alone when its side never had lines', () => {
    const result = reconcilePermanentSideField({
      active: true,
      hasLines: false,
      hadLinesPrev: false,
      freshValue: 0,
      currentBilled: 25,
      baseline: undefined,
    });
    expect(result).toEqual({ target: null, nextBaseline: undefined });
  });

  it('auto-populates when lines exist but no baseline was ever recorded (reopen-clobber guard not yet seeded)', () => {
    // Documents why QuoteBuilder's getSetter MUST seed the baseline before
    // the first post-thaw effect run — this function's job is not to guess
    // intent when it has no baseline at all.
    const result = reconcilePermanentSideField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 40,
      currentBilled: 55, // an override that predates the seed
      baseline: undefined,
    });
    expect(result.target).toBe(40); // clobbered — this is why the seed exists
  });

  it('never touches a field with no known satellite scale (footage on a manual upload), regardless of lines', () => {
    const result = reconcilePermanentSideField({
      active: false, // footage inactive: no known feetPerPixel
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 999, // never actually computed when inactive; here to prove it's ignored
      currentBilled: 55,
      baseline: 40,
    });
    expect(result).toEqual({ target: null, nextBaseline: undefined });
  });
});

describe('reconcilePermanentSideField — corners reconciles independently of footage', () => {
  it('preserves a hand-typed corners override while footage on the SAME side follows its own redraw', () => {
    // Corners unchanged (still 3, matching baseline) but staff corrected
    // it to 4 (a dormer the trace undercounts). Footage on the SAME side
    // redraws to a new value in the same effect run — the two fields must
    // reconcile independently.
    const cornersResult = reconcilePermanentSideField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 3,
      currentBilled: 4, // staff override
      baseline: 3,
    });
    const footageResult = reconcilePermanentSideField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 65, // redrawn
      currentBilled: 40,
      baseline: 40,
    });
    expect(cornersResult.target).toBeNull(); // corners override survives
    expect(footageResult.target).toBe(65); // footage redraw wins
  });
});

describe('reconcilePermanentSideField — composed cross-side scenario (the row-345 repro, fixed end to end)', () => {
  it('redrawing the front roofline does not clobber an untouched left-footage override', () => {
    // Baseline from the last reconcile: front derives to 30, left to 40.
    const baseline: Record<'frontFootage' | 'leftFootage', number> = { frontFootage: 30, leftFootage: 40 };
    // Staff hand-typed left to 55 sometime after the last reconcile.
    const billed = { front: 30, left: 55 };

    // Front gets redrawn (its own geometry actually changes to 35); left's
    // lines are untouched (still derive to 40) but the SHARED effect
    // re-fires for both because permanentSatLines is one object holding
    // all four sides.
    const frontResult = reconcilePermanentSideField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 35, // redrawn
      currentBilled: billed.front,
      baseline: baseline.frontFootage,
    });
    const leftResult = reconcilePermanentSideField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 40, // unchanged
      currentBilled: billed.left,
      baseline: baseline.leftFootage,
    });

    expect(frontResult.target).toBe(35); // redraw wins for the touched side
    expect(leftResult.target).toBeNull(); // override survives
  });
});

describe('derivePermanentSideFootageBaseline (the seed decision QuoteBuilder.getSetter calls on thaw)', () => {
  it('seeds a footage + corners baseline entry for every side that currently has lines', () => {
    const baseline = derivePermanentSideFootageBaseline({
      front: { hasLines: true, footage: 30, corners: 3 },
      left: { hasLines: true, footage: 40, corners: 2 },
      right: { hasLines: false, footage: null, corners: 0 },
      back: { hasLines: false, footage: null, corners: 0 },
    });
    expect(baseline).toEqual({
      frontFootage: 30, frontCorners: 3,
      leftFootage: 40, leftCorners: 2,
    });
  });

  it('skips a side\'s footage key (but keeps corners) when there is no known satellite scale', () => {
    const baseline = derivePermanentSideFootageBaseline({
      front: { hasLines: true, footage: null, corners: 3 }, // manual upload: no scale
      left: { hasLines: false, footage: null, corners: 0 },
      right: { hasLines: false, footage: null, corners: 0 },
      back: { hasLines: false, footage: null, corners: 0 },
    });
    expect(baseline).toEqual({ frontCorners: 3 });
  });

  it('produces an empty baseline when nothing has lines', () => {
    const baseline = derivePermanentSideFootageBaseline({
      front: { hasLines: false, footage: null, corners: 0 },
      left: { hasLines: false, footage: null, corners: 0 },
      right: { hasLines: false, footage: null, corners: 0 },
      back: { hasLines: false, footage: null, corners: 0 },
    });
    expect(baseline).toEqual({});
  });
});

// Row 345 reopen-clobber composed regression, mirrors row 333's "rehydrate ->
// first-edit -> derive" composed test. No component-render harness exists
// for QuoteBuilder.tsx, so this composes the exact two pure functions
// QuoteBuilder.tsx's real code path chains together: the getSetter thaw seed
// (derivePermanentSideFootageBaseline) -> the derive effect
// (reconcilePermanentSideField).
describe('row 345 reopen-clobber guard — rehydrate -> first-edit -> derive (composed)', () => {
  it('a left-footage override survives the first post-rehydrate edit, even though front redraws', () => {
    // Rehydrate: left persisted with a staff override (55ft) that
    // disagrees with its own geometry (still derives to 40ft — never
    // redrawn, staff tape-measured around an obstacle). Front persisted at
    // 30ft, matching its geometry.
    const seededBaseline = derivePermanentSideFootageBaseline({
      front: { hasLines: true, footage: 30, corners: 3 },
      left: { hasLines: true, footage: 40, corners: 2 },
      right: { hasLines: false, footage: null, corners: 0 },
      back: { hasLines: false, footage: null, corners: 0 },
    });

    // First edit: staff redraws front only — left's lines are untouched,
    // but the shared derive effect still re-fires for both.
    const leftResult = reconcilePermanentSideField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 40, // unchanged
      currentBilled: 55, // the override
      baseline: seededBaseline.leftFootage,
    });
    const frontResult = reconcilePermanentSideField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 35, // redrawn
      currentBilled: 30,
      baseline: seededBaseline.frontFootage,
    });

    expect(leftResult.target).toBeNull(); // override survives — the guard this test protects
    expect(frontResult.target).toBe(35);
  });

  it('WITHOUT the seed (baseline empty, the pre-row-345 bug), the same first edit clobbers the override', () => {
    const leftResult = reconcilePermanentSideField({
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 40,
      currentBilled: 55,
      baseline: undefined, // no seed at all
    });
    expect(leftResult.target).toBe(40); // clobbered — this is the bug the seed prevents
  });
});

// Row 345 finding-1-class check (pre-empted from row 333's own HIGH,
// verified reachable here too — see reconcileSideFootage.ts's own comment):
// a naive replace-not-merge baseline update drops an inactive field's key.
function legacyReplaceBaseline(
  results: Record<PermanentSideFieldKey, PermanentSideFieldReconcileResult>,
): PermanentSideFootageBaseline {
  const baseline: PermanentSideFootageBaseline = {};
  (Object.keys(results) as PermanentSideFieldKey[]).forEach((field) => {
    const nb = results[field].nextBaseline;
    if (nb != null) baseline[field] = nb;
  });
  return baseline;
}

describe('mergePermanentSideFootageBaseline — an inactive field (no satellite scale) keeps its baseline', () => {
  it('preserves an inactive footage key untouched, and recomputes an active one', () => {
    const prev: PermanentSideFootageBaseline = { frontFootage: 30, frontCorners: 3 };
    const results: Partial<Record<PermanentSideFieldKey, PermanentSideFieldReconcileResult>> = {
      frontFootage: { target: null, nextBaseline: undefined }, // inactive this run (no scale)
      frontCorners: { target: 4, nextBaseline: 4 }, // scale-free, still active
    };
    const active: Partial<Record<PermanentSideFieldKey, boolean>> = {
      frontFootage: false,
      frontCorners: true,
    };
    const next = mergePermanentSideFootageBaseline(
      prev,
      active as Record<PermanentSideFieldKey, boolean>,
      results as Record<PermanentSideFieldKey, PermanentSideFieldReconcileResult>,
    );
    expect(next).toEqual({ frontFootage: 30, frontCorners: 4 }); // footage survives inactivity
  });

  it('clears an ACTIVE field whose result reports no baseline (its side\'s last line was deleted)', () => {
    // rightFootage carries a baseline while INACTIVE (no scale this run):
    // the merge must preserve it, which a naive replace-not-merge drops.
    const prev: PermanentSideFootageBaseline = { frontFootage: 30, rightFootage: 25 };
    const results: Partial<Record<PermanentSideFieldKey, PermanentSideFieldReconcileResult>> = {
      frontFootage: { target: 0, nextBaseline: undefined }, // active, last line just deleted
      rightFootage: { target: null, nextBaseline: undefined },
    };
    const active: Partial<Record<PermanentSideFieldKey, boolean>> = {
      frontFootage: true,
      rightFootage: false,
    };
    const next = mergePermanentSideFootageBaseline(
      prev,
      active as Record<PermanentSideFieldKey, boolean>,
      results as Record<PermanentSideFieldKey, PermanentSideFieldReconcileResult>,
    );
    // frontFootage key removed (ACTIVE, reported none) · rightFootage preserved (INACTIVE)
    expect(next).toEqual({ rightFootage: 25 });
  });

  it('a naive replace-not-merge (legacyReplaceBaseline) drops the inactive key the fix preserves', () => {
    const results: Record<PermanentSideFieldKey, PermanentSideFieldReconcileResult> = {
      frontFootage: { target: null, nextBaseline: undefined },
      frontCorners: { target: 4, nextBaseline: 4 },
      leftFootage: { target: null, nextBaseline: undefined },
      leftCorners: { target: null, nextBaseline: undefined },
      rightFootage: { target: null, nextBaseline: undefined },
      rightCorners: { target: null, nextBaseline: undefined },
      backFootage: { target: null, nextBaseline: undefined },
      backCorners: { target: null, nextBaseline: undefined },
    };
    const legacy = legacyReplaceBaseline(results);
    expect(legacy).toEqual({ frontCorners: 4 }); // BUG: frontFootage's old baseline is gone from the rebuild
  });
});

// Row 345 — round-trip regression: a footage override survives satellite
// scale going away (a manual upload mid-session, per QuoteBuilder.tsx's
// handleSatelliteSelect) and coming back, composed from the exact two
// functions QuoteBuilder.tsx's real effect chains together each run
// (reconcilePermanentSideField + mergePermanentSideFootageBaseline).
describe('row 345 — a left-footage override survives satellite scale toggling off and back on', () => {
  it('with the FIX (merge): the override is still standing after the scale gap', () => {
    // Run 1: left drawn for the first time (scale known) — brand-new
    // baseline, auto-populate.
    let baseline: PermanentSideFootageBaseline = {};
    const activeAll: Record<PermanentSideFieldKey, boolean> = {
      frontFootage: true, frontCorners: true,
      leftFootage: true, leftCorners: true,
      rightFootage: true, rightCorners: true,
      backFootage: true, backCorners: true,
    };
    const run1: Record<PermanentSideFieldKey, PermanentSideFieldReconcileResult> = {
      frontFootage: reconcilePermanentSideField({ active: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.frontFootage }),
      frontCorners: reconcilePermanentSideField({ active: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.frontCorners }),
      leftFootage: reconcilePermanentSideField({ active: true, hasLines: true, hadLinesPrev: false, freshValue: 40, currentBilled: 0, baseline: baseline.leftFootage }),
      leftCorners: reconcilePermanentSideField({ active: true, hasLines: true, hadLinesPrev: false, freshValue: 2, currentBilled: 0, baseline: baseline.leftCorners }),
      rightFootage: reconcilePermanentSideField({ active: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.rightFootage }),
      rightCorners: reconcilePermanentSideField({ active: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.rightCorners }),
      backFootage: reconcilePermanentSideField({ active: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.backFootage }),
      backCorners: reconcilePermanentSideField({ active: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.backCorners }),
    };
    baseline = mergePermanentSideFootageBaseline(baseline, activeAll, run1);
    expect(baseline).toEqual({ leftFootage: 40, leftCorners: 2 });

    // Staff hand-types a left-footage override (55ft) sometime after — no
    // reconcile call happens from typing alone, only billed state changes.
    const leftFootageBilled = 55;

    // Run 2: staff switches to a manual satellite upload — scale resets to
    // null, so footage on EVERY side goes inactive; corners stays active
    // (scale-free). The shared effect still re-fires (satelliteFeetPerPixel
    // is a dependency).
    const activeNoScale: Record<PermanentSideFieldKey, boolean> = {
      frontFootage: false, frontCorners: true,
      leftFootage: false, leftCorners: true,
      rightFootage: false, rightCorners: true,
      backFootage: false, backCorners: true,
    };
    const run2: Record<PermanentSideFieldKey, PermanentSideFieldReconcileResult> = {
      frontFootage: reconcilePermanentSideField({ active: false, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.frontFootage }),
      frontCorners: reconcilePermanentSideField({ active: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.frontCorners }),
      leftFootage: reconcilePermanentSideField({ active: false, hasLines: true, hadLinesPrev: true, freshValue: 40, currentBilled: leftFootageBilled, baseline: baseline.leftFootage }),
      leftCorners: reconcilePermanentSideField({ active: true, hasLines: true, hadLinesPrev: true, freshValue: 2, currentBilled: 2, baseline: baseline.leftCorners }),
      rightFootage: reconcilePermanentSideField({ active: false, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.rightFootage }),
      rightCorners: reconcilePermanentSideField({ active: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.rightCorners }),
      backFootage: reconcilePermanentSideField({ active: false, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.backFootage }),
      backCorners: reconcilePermanentSideField({ active: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.backCorners }),
    };
    baseline = mergePermanentSideFootageBaseline(baseline, activeNoScale, run2);
    expect(baseline).toEqual({ leftFootage: 40, leftCorners: 2 }); // leftFootage's baseline survived the scale-off run

    // Run 3: a fresh address pull restores a known scale. Left's OWN
    // geometry never changed (still 40ft), and its baseline (40) is still
    // on record, so the override (55) is recognized and kept.
    const run3leftFootage = reconcilePermanentSideField({
      active: true, hasLines: true, hadLinesPrev: true, freshValue: 40, currentBilled: leftFootageBilled, baseline: baseline.leftFootage,
    });
    expect(run3leftFootage.target).toBeNull(); // the override survives — nothing stamps it back to 40
  });

  it('WITHOUT the fix (naive replace-not-merge), the same scale gap clobbers the override', () => {
    let baseline: PermanentSideFootageBaseline = {};
    const run1: Record<PermanentSideFieldKey, PermanentSideFieldReconcileResult> = {
      frontFootage: { target: null, nextBaseline: undefined },
      frontCorners: { target: null, nextBaseline: undefined },
      leftFootage: reconcilePermanentSideField({ active: true, hasLines: true, hadLinesPrev: false, freshValue: 40, currentBilled: 0, baseline: undefined }),
      leftCorners: { target: null, nextBaseline: undefined },
      rightFootage: { target: null, nextBaseline: undefined },
      rightCorners: { target: null, nextBaseline: undefined },
      backFootage: { target: null, nextBaseline: undefined },
      backCorners: { target: null, nextBaseline: undefined },
    };
    baseline = legacyReplaceBaseline(run1);
    const leftFootageBilled = 55;

    // Run 2: scale resets to null (manual upload) — the legacy replace
    // rebuilds the baseline from ONLY this run's active fields; leftFootage
    // is inactive and reports nextBaseline: undefined, so its key vanishes.
    const run2: Record<PermanentSideFieldKey, PermanentSideFieldReconcileResult> = {
      frontFootage: { target: null, nextBaseline: undefined },
      frontCorners: { target: null, nextBaseline: undefined },
      leftFootage: reconcilePermanentSideField({ active: false, hasLines: true, hadLinesPrev: true, freshValue: 40, currentBilled: leftFootageBilled, baseline: baseline.leftFootage }),
      leftCorners: { target: null, nextBaseline: undefined },
      rightFootage: { target: null, nextBaseline: undefined },
      rightCorners: { target: null, nextBaseline: undefined },
      backFootage: { target: null, nextBaseline: undefined },
      backCorners: { target: null, nextBaseline: undefined },
    };
    baseline = legacyReplaceBaseline(run2);
    expect(baseline).toEqual({}); // BUG: leftFootage's baseline is gone

    // Run 3: scale comes back. leftFootage now has NO recorded baseline, so
    // it's treated as a brand-new draw and its fresh (unchanged) geometry
    // stamps straight over the standing override.
    const run3leftFootage = reconcilePermanentSideField({
      active: true, hasLines: true, hadLinesPrev: true, freshValue: 40, currentBilled: leftFootageBilled, baseline: baseline.leftFootage,
    });
    expect(run3leftFootage.target).toBe(40); // BUG: the override is clobbered back to raw geometry
    expect(run3leftFootage.target).not.toBeNull();
  });
});

// Idempotency under React StrictMode double-invoke (mirrors row 333's S46
// finding-2 coverage): both helpers are pure and safe to call twice with
// identical inputs, which is what matters now that QuoteBuilder.tsx (per
// this row's hard constraint) mutates the baseline ref OUTSIDE the setForm
// updater, not inside it.
describe('reconcile helpers are idempotent under repeated calls with identical inputs', () => {
  it('reconcilePermanentSideField returns the same result called twice with the same inputs', () => {
    const input = {
      active: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 65,
      currentBilled: 55,
      baseline: 40,
    };
    const call1 = reconcilePermanentSideField(input);
    const call2 = reconcilePermanentSideField(input);
    expect(call2).toEqual(call1);
    expect(call2).toEqual({ target: 65, nextBaseline: 65 });
  });

  it('mergePermanentSideFootageBaseline returns the same result called twice with the same inputs, without mutating its input', () => {
    const prev: PermanentSideFootageBaseline = { frontFootage: 30, leftFootage: 40 };
    const active: Record<PermanentSideFieldKey, boolean> = {
      frontFootage: true, frontCorners: true,
      leftFootage: false, leftCorners: true,
      rightFootage: true, rightCorners: true,
      backFootage: true, backCorners: true,
    };
    const results: Record<PermanentSideFieldKey, PermanentSideFieldReconcileResult> = {
      frontFootage: { target: 35, nextBaseline: 35 },
      frontCorners: { target: null, nextBaseline: undefined },
      leftFootage: { target: null, nextBaseline: undefined },
      leftCorners: { target: null, nextBaseline: undefined },
      rightFootage: { target: null, nextBaseline: undefined },
      rightCorners: { target: null, nextBaseline: undefined },
      backFootage: { target: null, nextBaseline: undefined },
      backCorners: { target: null, nextBaseline: undefined },
    };
    const call1 = mergePermanentSideFootageBaseline(prev, active, results);
    const call2 = mergePermanentSideFootageBaseline(prev, active, results);
    expect(call2).toEqual(call1);
    expect(call2).toEqual({ frontFootage: 35, leftFootage: 40 }); // leftFootage survives inactivity
    expect(prev).toEqual({ frontFootage: 30, leftFootage: 40 }); // input never mutated
  });
});
