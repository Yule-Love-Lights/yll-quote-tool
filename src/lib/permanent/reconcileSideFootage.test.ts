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

// Row 345 PREMERGE finding 1 premise verification: a faithful extraction of
// the ORIGINAL (pre-finding-1-fix) reconcilePermanentSideField, which folded
// derivability into the SAME `active` flag as scope — `active: hasScale` for
// footage at the real call site. See the current reconcilePermanentSideField
// above (with the separate `canDerive` flag) for the fix.
function legacyReconcileOneActiveFlag(input: {
  active: boolean;
  hasLines: boolean;
  hadLinesPrev: boolean;
  freshValue: number;
  currentBilled: number;
  baseline: number | undefined;
}): PermanentSideFieldReconcileResult {
  const { active, hasLines, hadLinesPrev, freshValue, currentBilled, baseline } = input;
  if (!active) return { target: null, nextBaseline: undefined };
  if (!hasLines) {
    if (hadLinesPrev) return { target: 0, nextBaseline: undefined };
    return { target: null, nextBaseline: undefined };
  }
  if (baseline == null || freshValue !== baseline) return { target: freshValue, nextBaseline: freshValue };
  if (currentBilled !== baseline) return { target: null, nextBaseline: freshValue };
  return { target: null, nextBaseline: freshValue };
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
      canDerive: true,
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
      canDerive: true,
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
      canDerive: true,
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
      canDerive: true,
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
      canDerive: true,
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
      canDerive: true,
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
      canDerive: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 40,
      currentBilled: 55, // an override that predates the seed
      baseline: undefined,
    });
    expect(result.target).toBe(40); // clobbered — this is why the seed exists
  });

  it('fully out-of-scope (active: false) never touches the field, regardless of anything else', () => {
    // Not driven by any real permanent call site today (see this file's own
    // header comment) — kept for parity with the holiday reconciler, whose
    // `active` genuinely does mean "out of scope" (C9/stake off-holiday).
    const result = reconcilePermanentSideField({
      active: false,
      canDerive: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 999,
      currentBilled: 55,
      baseline: 40,
    });
    expect(result).toEqual({ target: null, nextBaseline: undefined });
  });
});

describe('reconcilePermanentSideField — canDerive: false (no known satellite scale)', () => {
  it('leaves a lined field with no derivable value untouched, echoing the baseline through unchanged', () => {
    // Row 345 finding 1 fix: this is the corrected replacement for what used
    // to be `active: false` on the OLD single-flag design (see the "WITHOUT
    // the fix" describe block below for the direct before/after). The
    // baseline is echoed through (40), not cleared, so a later address
    // re-pull (scale restored) resumes the override comparison exactly
    // where it left off.
    const result = reconcilePermanentSideField({
      active: true,
      canDerive: false, // footage inactive: no known feetPerPixel
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 999, // never actually computed when canDerive is false; here to prove it's ignored
      currentBilled: 55,
      baseline: 40,
    });
    expect(result).toEqual({ target: null, nextBaseline: 40 });
  });

  it('with no prior baseline either, still leaves the field untouched (nothing to echo)', () => {
    const result = reconcilePermanentSideField({
      active: true,
      canDerive: false,
      hasLines: true,
      hadLinesPrev: false,
      freshValue: 999,
      currentBilled: 0,
      baseline: undefined,
    });
    expect(result).toEqual({ target: null, nextBaseline: undefined });
  });
});

// Row 345 PREMERGE finding 1 (HIGH, all four lenses): the delete-transition
// (last line on a side deleted) must reset a field to 0 REGARDLESS of
// whether a fresh value can currently be derived — footage on a side with no
// known satellite scale (a manual satellite upload mid-session) is exactly
// the reachable case the pre-fix code missed, because it gated the whole
// delete-transition behind the SAME `active: hasScale` flag that also gated
// derivability.
describe('row 345 finding 1: the no-scale delete-transition (footage and corners must agree)', () => {
  it('resets footage to 0 and clears its baseline even with canDerive: false', () => {
    const result = reconcilePermanentSideField({
      active: true,
      canDerive: false, // no known satellite scale — a manual satellite upload
      hasLines: false, // the side's last line was just deleted
      hadLinesPrev: true,
      freshValue: 0, // unused by the delete-transition branch
      currentBilled: 42, // stale footage from before the last line was deleted
      baseline: 30,
    });
    expect(result).toEqual({ target: 0, nextBaseline: undefined });
  });

  it('BEFORE the fix (single active flag folding derivability + delete-transition), the same deletion left footage stuck non-zero', () => {
    const result = legacyReconcileOneActiveFlag({
      active: false, // hasScale: false — the pre-fix code's only way to express "no scale"
      hasLines: false,
      hadLinesPrev: true,
      freshValue: 0,
      currentBilled: 42,
      baseline: 30,
    });
    // BUG: `!active` short-circuits before the delete-transition branch ever
    // runs, so the stale 42 is never zeroed.
    expect(result).toEqual({ target: null, nextBaseline: undefined });
    expect(result.target).not.toBe(0);
  });

  it('footage and corners AGREE about a vanished trace: both zero out on the same run, even with no satellite scale', () => {
    // Corners is scale-free (canDerive: true always while lines exist), so
    // it already reset correctly pre-fix. The bug was footage disagreeing
    // with it — ending at a state with zero lines, zero corners, and a
    // stale non-zero footage that PS-B1's own untraced-but-billed warning
    // can't catch (its signal is exactly "billed but untraced," which this
    // satisfies).
    const footage = reconcilePermanentSideField({
      active: true,
      canDerive: false, // no scale
      hasLines: false,
      hadLinesPrev: true,
      freshValue: 0,
      currentBilled: 42,
      baseline: 30,
    });
    const corners = reconcilePermanentSideField({
      active: true,
      canDerive: true, // scale-free
      hasLines: false,
      hadLinesPrev: true,
      freshValue: 0,
      currentBilled: 3,
      baseline: 2,
    });
    expect(footage.target).toBe(0);
    expect(corners.target).toBe(0);
    expect(footage.nextBaseline).toBeUndefined();
    expect(corners.nextBaseline).toBeUndefined();
  });
});

// Row 379 (S48 #921 delta-verify MED): a baseline can be paired with a scale
// it was not derived under, reachable across a service-type switch (reopen a
// permanent quote frozen -> switch to permanent_bistro before the first edit
// thaws it -> a fresh street lookup pulls a new scale and thaws -> switch
// back to permanent). Without `scaleChanged`, a mere scale difference makes
// freshValue !== baseline look exactly like a real redraw and silently
// stamps the new-scale value over a standing override.
describe('reconcilePermanentSideField — scaleChanged (row 379: baseline captured under a different scale)', () => {
  it('does NOT clobber a standing override when the mismatch is purely a scale artifact', () => {
    // Same lines as when the baseline was seeded (40ft under the old scale),
    // but the new scale re-derives them to 46ft — a pure scale artifact, not
    // a redraw. Staff has an override on record (55ft).
    const result = reconcilePermanentSideField({
      active: true,
      canDerive: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 46, // re-derived under the NEW scale
      currentBilled: 55, // staff's override, untouched by the scale change
      baseline: 40, // captured under the OLD scale
      scaleChanged: true,
    });
    expect(result.target).toBeNull(); // override survives — no stamp
    expect(result.nextBaseline).toBe(46); // baseline resyncs to the new scale
  });

  it('also does not clobber an un-overridden (derived-only) billed value on a scale mismatch', () => {
    const result = reconcilePermanentSideField({
      active: true,
      canDerive: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 46,
      currentBilled: 40, // matches the OLD baseline exactly (no override)
      baseline: 40,
      scaleChanged: true,
    });
    expect(result.target).toBeNull(); // still no stamp — the scale artifact isn't a redraw
    expect(result.nextBaseline).toBe(46);
  });

  it('WITHOUT scaleChanged (the pre-379 behavior), the same scale artifact silently clobbers the override', () => {
    const result = reconcilePermanentSideField({
      active: true,
      canDerive: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 46,
      currentBilled: 55,
      baseline: 40,
      // scaleChanged omitted — defaults to false
    });
    expect(result.target).toBe(46); // BUG (pre-fix shape): the override is stamped over
  });

  it('with no prior baseline, scaleChanged is moot — falls through to the brand-new auto-populate branch', () => {
    const result = reconcilePermanentSideField({
      active: true,
      canDerive: true,
      hasLines: true,
      hadLinesPrev: false,
      freshValue: 46,
      currentBilled: 0,
      baseline: undefined,
      scaleChanged: true,
    });
    expect(result).toEqual({ target: 46, nextBaseline: 46 });
  });

  it('a real redraw (scaleChanged false) still wins normally — the guard does not mask genuine geometry changes', () => {
    const result = reconcilePermanentSideField({
      active: true,
      canDerive: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 65,
      currentBilled: 55,
      baseline: 40,
      scaleChanged: false,
    });
    expect(result).toEqual({ target: 65, nextBaseline: 65 });
  });

  it('a genuine second scale change (two mismatches before the operator ever redraws) still keeps resyncing safely, never clobbering', () => {
    // Simulates row 379's own named residual: a second scale/geometry change
    // before switching back to permanent. Even chained, scaleChanged never
    // lets a scale-only difference touch the billed value.
    const run1 = reconcilePermanentSideField({
      active: true, canDerive: true, hasLines: true, hadLinesPrev: true,
      freshValue: 46, currentBilled: 55, baseline: 40, scaleChanged: true,
    });
    const run2 = reconcilePermanentSideField({
      active: true, canDerive: true, hasLines: true, hadLinesPrev: true,
      freshValue: 52, currentBilled: 55, baseline: run1.nextBaseline, scaleChanged: true,
    });
    expect(run1.target).toBeNull();
    expect(run2.target).toBeNull();
    expect(run2.nextBaseline).toBe(52);
  });
});

// Row 399 (lens review on #938, escalated MED-dormant -> HIGH-live): the
// scaleChanged guard row 379 added made a REAL two-address re-analyze
// indistinguishable from a pure scale artifact, because nothing at
// QuoteBuilder.tsx's permanentImageryOnly seed site ever reset
// prevPermSideDerivedRef/prevPermSideScaleRef before the wholesale line
// replace — so a SECOND "Analyze from Address" for a DIFFERENT address (an
// ordinary typo-correction workflow; the button is never disabled after a
// first success) inherited the FIRST address's baseline+scale. Composes
// reconcilePermanentSideField exactly as QuoteBuilder.tsx's derive effect
// does across two consecutive analyze runs, using the SAME scaleChanged
// formula the effect computes at ~line 2101, so this pins the caller-side
// bug/fix, not just the reconcile function in isolation.
function computeScaleChanged(prevScale: number | null | undefined, currentScale: number | null): boolean {
  return prevScale !== undefined && prevScale !== currentScale;
}

describe('reconcilePermanentSideField — row 399: a second, different-address analyze', () => {
  it('BUG (the un-reset refs QuoteBuilder.tsx shipped before row 399): house B\'s real footage is silently suppressed and house A\'s wrong number sticks', () => {
    // Run 1: brand-new permanent quote, "Analyze from Address" for address A
    // (a typo — wrong house). No prior baseline/scale.
    const scaleA = 0.5; // ft/px at address A's latitude
    const run1 = reconcilePermanentSideField({
      active: true, canDerive: true, hasLines: true, hadLinesPrev: false,
      freshValue: 30, currentBilled: 0, baseline: undefined,
      scaleChanged: computeScaleChanged(undefined, scaleA),
    });
    expect(run1.target).toBe(30); // brand-new -> applied
    // Mirrors QuoteBuilder.tsx's real post-run bookkeeping — WITHOUT the
    // row-399 reset, nothing else touches these refs before the next analyze.
    const prevBaseline = run1.nextBaseline;
    const prevScale = scaleA;

    // Operator notices the typo, corrects the address, and re-runs "Analyze
    // from Address" for the REAL house (address B) — a completely different
    // latitude, so a different satellite scale, and a genuinely different
    // 52ft front (not a rescale of the same geometry).
    const scaleB = 0.5137;
    const run2 = reconcilePermanentSideField({
      active: true, canDerive: true, hasLines: true, hadLinesPrev: true,
      freshValue: 52, currentBilled: run1.target ?? 0, baseline: prevBaseline,
      scaleChanged: computeScaleChanged(prevScale, scaleB),
    });
    expect(run2.target).toBeNull(); // BUG: house B's real 52ft is suppressed
    expect(run2.nextBaseline).toBe(52); // and the baseline silently resyncs — the guard can never fire again
    // The billed value stays at house A's WRONG 30ft, permanently and silently.
  });

  it('FIXED (row 399): resetting prevPermSideDerivedRef/prevPermSideScaleRef before the second analyze lets house B\'s real footage win outright', () => {
    let prevBaseline: number | undefined;
    let prevScale: number | null | undefined;
    const scaleA = 0.5;
    const run1 = reconcilePermanentSideField({
      active: true, canDerive: true, hasLines: true, hadLinesPrev: false,
      freshValue: 30, currentBilled: 0, baseline: prevBaseline,
      scaleChanged: computeScaleChanged(prevScale, scaleA),
    });
    prevBaseline = run1.nextBaseline;
    prevScale = scaleA;

    // Row 399 fix: QuoteBuilder.tsx's permanentImageryOnly seed site now
    // resets BOTH refs to their brand-new (unseeded) state in the same
    // breath as the wholesale setPermanentSatLines replace, before the
    // second analyze's derive effect ever runs.
    prevBaseline = undefined; // prevPermSideDerivedRef.current = {}
    prevScale = undefined; // prevPermSideScaleRef.current = undefined

    const scaleB = 0.5137;
    const run2 = reconcilePermanentSideField({
      active: true, canDerive: true, hasLines: true, hadLinesPrev: true,
      freshValue: 52, currentBilled: run1.target ?? 0, baseline: prevBaseline,
      scaleChanged: computeScaleChanged(prevScale, scaleB),
    });
    expect(run2.target).toBe(52); // FIXED: house B's real footage wins outright
    expect(run2.nextBaseline).toBe(52);
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
      canDerive: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 3,
      currentBilled: 4, // staff override
      baseline: 3,
    });
    const footageResult = reconcilePermanentSideField({
      active: true,
      canDerive: true,
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
      canDerive: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 35, // redrawn
      currentBilled: billed.front,
      baseline: baseline.frontFootage,
    });
    const leftResult = reconcilePermanentSideField({
      active: true,
      canDerive: true,
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

describe('derivePermanentSideFootageBaseline (the seed decision QuoteBuilder.getSetter/thawPermDerive calls on thaw)', () => {
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
// (derivePermanentSideFootageBaseline, now invoked via the shared
// thawPermDerive() helper — row 345 finding 2) -> the derive effect
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
      canDerive: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 40, // unchanged
      currentBilled: 55, // the override
      baseline: seededBaseline.leftFootage,
    });
    const frontResult = reconcilePermanentSideField({
      active: true,
      canDerive: true,
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
      canDerive: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 40,
      currentBilled: 55,
      baseline: undefined, // no seed at all
    });
    expect(leftResult.target).toBe(40); // clobbered — this is the bug the seed prevents
  });
});

// Row 345 PREMERGE finding 2 (HIGH): permDeriveFrozenRef is shared across
// several thaw sites in QuoteBuilder.tsx, and the seed above was only ever
// called from ONE of them (the isPermanentSide getSetter). The "Recount from
// drawn lines" button (PermanentSection's accessories recount, wired to
// QuoteBuilder's onRecount) thaws the SAME ref with no seed at all — and
// because seedPermanentSideBaselineIfFrozen's own guard requires the ref to
// still be frozen, once Recount thaws it the seed could never fire again, so
// the operator's NEXT line edit (on ANY one side) ran the derive effect
// against an EMPTY baseline for every side, clobbering every side's override
// at once. The fix (thawPermDerive(), used at every clear site including
// onRecount) is component-only — it reads permanentSatLines/refs/state that
// only exist inside QuoteBuilder.tsx, and this repo has no component-render
// harness for that file — so the regression is pinned here at the level
// thawPermDerive's own contract depends on: the seed must be taken from the
// CURRENTLY DRAWN lines before the ref is cleared, exactly like the rehydrate
// case above. Recount itself never changes permanentSatLines (see
// PermanentSection.tsx's recountAccessories / QuoteBuilder's onRecount — it
// only flips the ref and accessoriesSource), so from the reconcile's point of
// view a Recount-then-edit sequence is DATA-IDENTICAL to a
// rehydrate-then-edit sequence: seed from current lines, then the next edit
// reconciles against that seed.
describe('row 345 finding 2: Recount-then-edit — the seed must fire even when the thaw was NOT a line edit', () => {
  it('a right-footage override survives the first edit after Recount, even though front redraws', () => {
    // Before Recount: right persisted with a staff override (70ft) that
    // disagrees with its own geometry (still derives to 50ft). Front
    // persisted at 30ft, matching its geometry. Recount does not touch any
    // line — it only thaws the ref (see thawPermDerive's own comment in
    // QuoteBuilder.tsx) — so the seed must be taken from these SAME
    // currently-drawn lines.
    const seededAtRecount = derivePermanentSideFootageBaseline({
      front: { hasLines: true, footage: 30, corners: 2 },
      left: { hasLines: false, footage: null, corners: 0 },
      right: { hasLines: true, footage: 50, corners: 4 },
      back: { hasLines: false, footage: null, corners: 0 },
    });

    // First edit AFTER Recount: staff redraws front only — right's lines
    // are untouched, but the shared derive effect still re-fires for both
    // (permanentSatLines is one object holding all four sides).
    const rightResult = reconcilePermanentSideField({
      active: true,
      canDerive: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 50, // unchanged
      currentBilled: 70, // the override
      baseline: seededAtRecount.rightFootage,
    });
    const frontResult = reconcilePermanentSideField({
      active: true,
      canDerive: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 38, // redrawn
      currentBilled: 30,
      baseline: seededAtRecount.frontFootage,
    });

    expect(rightResult.target).toBeNull(); // override survives Recount + an unrelated redraw
    expect(frontResult.target).toBe(38);
  });

  it('WITHOUT the fix (Recount thaws with no seed — the pre-fix onRecount body), the next edit clobbers every untouched side', () => {
    // Pre-fix onRecount was `permDeriveFrozenRef.current = false;` with no
    // call to seedPermanentSideBaselineIfFrozen — and because that seed
    // function's own guard requires the ref to still be frozen, it can
    // never fire again once Recount has already thawed it. The next derive
    // run for EVERY side sees baseline: undefined, identical in shape to
    // the "no seed at all" rehydrate case above.
    const rightResult = reconcilePermanentSideField({
      active: true,
      canDerive: true,
      hasLines: true,
      hadLinesPrev: true,
      freshValue: 50, // unchanged geometry
      currentBilled: 70, // the override
      baseline: undefined, // Recount thawed the ref but never seeded this
    });
    expect(rightResult.target).toBe(50); // BUG: clobbered back to raw geometry
    expect(rightResult.target).not.toBe(70);
  });
});

// Row 345 premerge finding 1-class check (pre-empted from row 333's own HIGH,
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

// NOTE on reachability (row 345 finding 1 fix, re-checked): QuoteBuilder's
// real call site now passes `active: true` for all 8 fields to
// mergePermanentSideFootageBaseline, every run — reconcilePermanentSideField
// itself now handles "leave a currently-undeliverable field's baseline
// alone" (the canDerive: false echo), so the `active`-gated skip this merge
// function still supports below is NOT exercised by the real integration
// path any more. These tests still cover it directly as a pure-function
// contract (parity with mergeHolidayFootageBaseline, and a safety net for
// any future caller that DOES need per-field scope gating), but they are no
// longer a description of what QuoteBuilder.tsx actually does at runtime.
describe('mergePermanentSideFootageBaseline — an inactive field (caller opts it out) keeps its baseline', () => {
  it('preserves an inactive footage key untouched, and recomputes an active one', () => {
    const prev: PermanentSideFootageBaseline = { frontFootage: 30, frontCorners: 3 };
    const results: Partial<Record<PermanentSideFieldKey, PermanentSideFieldReconcileResult>> = {
      frontFootage: { target: null, nextBaseline: undefined }, // inactive this run (caller opted out)
      frontCorners: { target: 4, nextBaseline: 4 }, // still active
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
    // rightFootage carries a baseline while opted OUT this run: the merge
    // must preserve it, which a naive replace-not-merge drops.
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
    // frontFootage key removed (active, reported none) · rightFootage preserved (opted out)
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

  it('row 345 finding 1: the merge must NOT skip a delete-transition clear just because the field had no scale this run', () => {
    // The scenario the finding-1 fix protects at the MERGE layer too: a
    // footage field with no known scale (canDerive: false) whose side just
    // lost its last line reports nextBaseline: undefined (a real "clear
    // this"). If the merge were gated by scale (the OLD design — active:
    // hasScale for footage) rather than by the caller's OWN choice, it
    // would treat "no scale" as "leave it alone" and silently keep the
    // STALE pre-delete baseline — self-consistent, but wrong, since the
    // side now has zero lines and should have zero recorded baseline.
    const prev: PermanentSideFootageBaseline = { frontFootage: 30 };
    const scaleGatedActive: Record<PermanentSideFieldKey, boolean> = {
      frontFootage: false, frontCorners: true, // false: "no scale" mistakenly reused as the merge gate
      leftFootage: true, leftCorners: true,
      rightFootage: true, rightCorners: true,
      backFootage: true, backCorners: true,
    };
    const results: Record<PermanentSideFieldKey, PermanentSideFieldReconcileResult> = {
      frontFootage: { target: 0, nextBaseline: undefined }, // delete-transition fired correctly
      frontCorners: { target: 0, nextBaseline: undefined },
      leftFootage: { target: null, nextBaseline: undefined },
      leftCorners: { target: null, nextBaseline: undefined },
      rightFootage: { target: null, nextBaseline: undefined },
      rightCorners: { target: null, nextBaseline: undefined },
      backFootage: { target: null, nextBaseline: undefined },
      backCorners: { target: null, nextBaseline: undefined },
    };
    const scaleGatedNext = mergePermanentSideFootageBaseline(prev, scaleGatedActive, results);
    expect(scaleGatedNext).toEqual({ frontFootage: 30 }); // BUG (if this gating were used): stale baseline survives

    // QuoteBuilder's REAL call site (row 345 finding 1 fix): active: true
    // for every field, every run — the merge applies the delete-transition
    // clear correctly.
    const realActive: Record<PermanentSideFieldKey, boolean> = {
      frontFootage: true, frontCorners: true,
      leftFootage: true, leftCorners: true,
      rightFootage: true, rightCorners: true,
      backFootage: true, backCorners: true,
    };
    const realNext = mergePermanentSideFootageBaseline(prev, realActive, results);
    expect(realNext).toEqual({}); // fixed: frontFootage's stale baseline is actually cleared
  });
});

// Row 345 — round-trip regression: a footage override survives satellite
// scale going away (a manual upload mid-session, per QuoteBuilder.tsx's
// handleSatelliteSelect) and coming back, composed from the exact two
// functions QuoteBuilder.tsx's real effect chains together each run
// (reconcilePermanentSideField + mergePermanentSideFootageBaseline), using
// the REAL call-site shape (active: true always, canDerive carrying the
// scale gate).
describe('row 345 — a left-footage override survives satellite scale toggling off and back on', () => {
  it('the override is still standing after the scale gap', () => {
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
      frontFootage: reconcilePermanentSideField({ active: true, canDerive: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.frontFootage }),
      frontCorners: reconcilePermanentSideField({ active: true, canDerive: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.frontCorners }),
      leftFootage: reconcilePermanentSideField({ active: true, canDerive: true, hasLines: true, hadLinesPrev: false, freshValue: 40, currentBilled: 0, baseline: baseline.leftFootage }),
      leftCorners: reconcilePermanentSideField({ active: true, canDerive: true, hasLines: true, hadLinesPrev: false, freshValue: 2, currentBilled: 0, baseline: baseline.leftCorners }),
      rightFootage: reconcilePermanentSideField({ active: true, canDerive: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.rightFootage }),
      rightCorners: reconcilePermanentSideField({ active: true, canDerive: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.rightCorners }),
      backFootage: reconcilePermanentSideField({ active: true, canDerive: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.backFootage }),
      backCorners: reconcilePermanentSideField({ active: true, canDerive: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.backCorners }),
    };
    baseline = mergePermanentSideFootageBaseline(baseline, activeAll, run1);
    expect(baseline).toEqual({ leftFootage: 40, leftCorners: 2 });

    // Staff hand-types a left-footage override (55ft) sometime after — no
    // reconcile call happens from typing alone, only billed state changes.
    const leftFootageBilled = 55;

    // Run 2: staff switches to a manual satellite upload — scale resets to
    // null, so footage on EVERY side can no longer be DERIVED
    // (canDerive: false); corners stays derivable (scale-free). `active`
    // stays true for every field — the real call site never sets it false.
    // The shared effect still re-fires (satelliteFeetPerPixel is a
    // dependency).
    const run2: Record<PermanentSideFieldKey, PermanentSideFieldReconcileResult> = {
      frontFootage: reconcilePermanentSideField({ active: true, canDerive: false, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.frontFootage }),
      frontCorners: reconcilePermanentSideField({ active: true, canDerive: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.frontCorners }),
      leftFootage: reconcilePermanentSideField({ active: true, canDerive: false, hasLines: true, hadLinesPrev: true, freshValue: 40, currentBilled: leftFootageBilled, baseline: baseline.leftFootage }),
      leftCorners: reconcilePermanentSideField({ active: true, canDerive: true, hasLines: true, hadLinesPrev: true, freshValue: 2, currentBilled: 2, baseline: baseline.leftCorners }),
      rightFootage: reconcilePermanentSideField({ active: true, canDerive: false, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.rightFootage }),
      rightCorners: reconcilePermanentSideField({ active: true, canDerive: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.rightCorners }),
      backFootage: reconcilePermanentSideField({ active: true, canDerive: false, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.backFootage }),
      backCorners: reconcilePermanentSideField({ active: true, canDerive: true, hasLines: false, hadLinesPrev: false, freshValue: 0, currentBilled: 0, baseline: baseline.backCorners }),
    };
    baseline = mergePermanentSideFootageBaseline(baseline, activeAll, run2);
    expect(baseline).toEqual({ leftFootage: 40, leftCorners: 2 }); // leftFootage's baseline survived the scale-off run

    // Run 3: a fresh address pull restores a known scale. Left's OWN
    // geometry never changed (still 40ft), and its baseline (40) is still
    // on record, so the override (55) is recognized and kept.
    const run3leftFootage = reconcilePermanentSideField({
      active: true, canDerive: true, hasLines: true, hadLinesPrev: true, freshValue: 40, currentBilled: leftFootageBilled, baseline: baseline.leftFootage,
    });
    expect(run3leftFootage.target).toBeNull(); // the override survives — nothing stamps it back to 40
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
      canDerive: true,
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
