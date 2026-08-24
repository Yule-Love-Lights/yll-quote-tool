// Permanent side footage/corners RECONCILE (row 345): per-field baseline
// reconcile for the FOUR house sides' footage + corners — the scalar analog
// of the holiday reconcile (src/lib/holidayFootage/reconcileFootage.ts,
// row 333) and the bistro id-keyed reconcile
// (src/lib/permanentBistro/reconcileFootage.ts, #244), applied to permanent's
// own shared derive effect in QuoteBuilder.tsx.
//
// The flaw this replaces: QuoteBuilder's single permanent-side derive effect
// derives ALL FOUR sides' footage + corners from permanentSatLines (one
// object holding all four sides' line arrays) in ONE effect with ONE
// dependency list. The old logic compared each field's CURRENT BILLED value
// straight against its freshly re-derived target, with no way to tell "staff
// typed an override" apart from "this field's own geometry actually
// changed" — so redrawing e.g. the front roofline re-fired the whole effect,
// recomputed the LEFT side's target from its UNCHANGED lines, found it
// didn't match a hand-typed left-footage override, and silently stamped the
// override back to the derived value even though left was never touched.
// Exactly the row-333/holiday flaw, one door over.
//
// EIGHT independent fields, not four: footage AND corners per side, and they
// can drift independently (corners is scale-free so it can be right while
// footage awaits a manual entry, or vice versa) — so each gets its OWN
// baseline entry, flat-keyed by `${side}Footage` / `${side}Corners` to match
// form.permanent's own field names directly.
//
// Rule per field (baseline-keyed, mirrors reconcileHolidayFootageField exactly):
//   - field isn't currently derivable (footage with no known satellite scale
//     — deriveSideMeasure returns footage: null; corners is scale-free and
//     always derivable while this side has lines) -> never touch it, no
//     baseline.
//   - field has no lines drawn on its side:
//       - had lines on the PREVIOUS derive (the last line on this side was
//         just deleted) -> reset to 0, clear the baseline.
//       - never had lines -> leave the billed value alone (a manual-only
//         field), no baseline.
//   - field has lines, no PRIOR baseline recorded (a brand-new draw, or the
//     first reconcile after a reopened quote's rehydrate-thaw — see the
//     QuoteBuilder getSetter(side) seeding comment) -> auto-populate with the
//     fresh derived value.
//   - fresh derived value differs from the field's OWN prior baseline ->
//     THIS field's geometry changed since the last reconcile -> the redraw
//     wins, take the fresh value.
//   - fresh derived value equals the prior baseline (this field's own
//     geometry is unchanged) but the currently billed value differs from
//     that baseline -> staff typed a manual override -> keep it untouched.
//   - otherwise (unchanged geometry, no override) -> no-op (already at target).
//
// Merge, not replace: the footage half of a side CAN go inactive mid-session
// (satelliteFeetPerPixel resets to null when staff switch to a manual
// satellite upload — QuoteBuilder.tsx's handleSatelliteSelect) while corners
// stays active (scale-free). Row 333's finding 1 (HIGH) showed that
// rebuilding the whole baseline object from only THIS run's active fields
// silently drops an inactive field's baseline, so toggling scale back on
// later treats it as brand-new and clobbers a standing override. Same fix
// here: mergePermanentSideFootageBaseline only touches an ACTIVE field's key
// and leaves every inactive key exactly as it was.

export type PermanentSideKey = 'front' | 'left' | 'right' | 'back';

export type PermanentSideFieldKey =
  | 'frontFootage' | 'frontCorners'
  | 'leftFootage' | 'leftCorners'
  | 'rightFootage' | 'rightCorners'
  | 'backFootage' | 'backCorners';

export type PermanentSideFootageBaseline = Partial<Record<PermanentSideFieldKey, number>>;

export type PermanentSideFieldReconcileInput = {
  /** Whether this field is currently derivable at all — false for a
   *  footage field with no known satellite scale; always true for corners
   *  (scale-free) while its side has lines. */
  active: boolean;
  hasLines: boolean;
  /** Whether this side's satellite line array had lines on the PREVIOUS derive run. */
  hadLinesPrev: boolean;
  /** Freshly geometry-derived value for this field's current lines. */
  freshValue: number;
  /** The field's current billed value (form.permanent.<side><Footage|Corners>). */
  currentBilled: number;
  /** The derived value recorded at the last reconcile (or seeded at a reopened quote's rehydrate-thaw). */
  baseline: number | undefined;
};

export type PermanentSideFieldReconcileResult = {
  /** The value to stamp onto the field, or null to leave the billed value untouched. */
  target: number | null;
  /** The baseline to carry into the NEXT reconcile call for this field. */
  nextBaseline: number | undefined;
};

export function reconcilePermanentSideField(
  input: PermanentSideFieldReconcileInput,
): PermanentSideFieldReconcileResult {
  const { active, hasLines, hadLinesPrev, freshValue, currentBilled, baseline } = input;
  if (!active) return { target: null, nextBaseline: undefined };
  if (!hasLines) {
    if (hadLinesPrev) return { target: 0, nextBaseline: undefined };
    return { target: null, nextBaseline: undefined };
  }
  if (baseline == null || freshValue !== baseline) {
    // Brand-new derive, or this field's own geometry changed since the last
    // reconcile -> the redraw wins, even over a standing override.
    return { target: freshValue, nextBaseline: freshValue };
  }
  if (currentBilled !== baseline) {
    // Geometry unchanged, but the billed value has drifted from the derived
    // baseline -> staff typed an override -> keep it.
    return { target: null, nextBaseline: freshValue };
  }
  // Geometry unchanged, no override -> already at target, no-op.
  return { target: null, nextBaseline: freshValue };
}

/**
 * Seeds a reconcile baseline for all eight fields from the CURRENTLY drawn
 * (pre-edit) satellite lines — called once, at a reopened quote's
 * rehydrate-thaw (the first real line edit after loading, on ANY of the four
 * sides), so the reconcile above sees a real prior baseline for every
 * already-billed field instead of treating them as brand-new and stamping
 * fresh geometry over a saved manual override (the S24 reopen-clobber
 * class). Mirrors deriveHolidayFootageBaseline / deriveBistroFootageMap.
 *
 * `footage: null` means no known satellite scale (deriveSideMeasure's own
 * shape) — that side's footage key is left out of the baseline entirely,
 * same as an inactive field; corners is scale-free so it seeds whenever the
 * side has lines.
 */
export function derivePermanentSideFootageBaseline(
  sides: Record<PermanentSideKey, { hasLines: boolean; footage: number | null; corners: number }>,
): PermanentSideFootageBaseline {
  const baseline: PermanentSideFootageBaseline = {};
  (Object.keys(sides) as PermanentSideKey[]).forEach((side) => {
    const s = sides[side];
    if (!s.hasLines) return;
    if (s.footage != null) baseline[`${side}Footage`] = s.footage;
    baseline[`${side}Corners`] = s.corners;
  });
  return baseline;
}

// Mirrors mergeHolidayFootageBaseline (row 333 finding 1, HIGH): MERGE into
// the previous baseline instead of replacing it wholesale. An inactive
// field's key (footage with no known scale) is left completely untouched;
// only an ACTIVE field's key is recomputed from this run's reconcile result
// (set when a fresh baseline exists, cleared when the field reports none —
// e.g. its side's last line was just deleted).
export function mergePermanentSideFootageBaseline(
  prevBaseline: PermanentSideFootageBaseline,
  active: Record<PermanentSideFieldKey, boolean>,
  results: Record<PermanentSideFieldKey, PermanentSideFieldReconcileResult>,
): PermanentSideFootageBaseline {
  const next: PermanentSideFootageBaseline = { ...prevBaseline };
  (Object.keys(results) as PermanentSideFieldKey[]).forEach((field) => {
    if (!active[field]) return; // inactive: leave its existing baseline entry alone
    const nb = results[field].nextBaseline;
    if (nb != null) next[field] = nb;
    else delete next[field];
  });
  return next;
}
