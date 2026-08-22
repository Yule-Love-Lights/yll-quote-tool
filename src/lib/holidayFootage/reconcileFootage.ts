// Holiday satellite footage RECONCILE (row 333): per-field baseline reconcile
// for the four independent holiday derive fields — santas (front gutterline),
// gingerbread (ridge + sides), C9 custom-runs, and stake lighting — each
// derived from its OWN satellite line array. Mirrors the Permanent Bistro fix
// (#244, src/lib/permanentBistro/reconcileFootage.ts) but for SCALAR fields
// instead of an array of id-keyed runs, so no id-keying is needed — just one
// derive baseline per field.
//
// The flaw this replaces: QuoteBuilder's single derive effect
// (satelliteSantasLines/satelliteGingerbreadLines/satelliteC9Lines/
// satelliteStakeLines all in ONE dependency list) re-fires the WHOLE effect
// when ANY one of the four line arrays changes. The old logic compared each
// field's CURRENT BILLED value straight against its freshly re-derived
// target, with no way to tell "staff typed an override" apart from "this
// field's own geometry actually changed" — so redrawing e.g. gingerbread
// re-fired the effect, recomputed santas's target from its UNCHANGED lines,
// found it didn't match a hand-typed santas override, and silently stamped
// the override back to the derived value even though santas was never
// touched.
//
// Rule per field (baseline-keyed, mirrors reconcileBistroFootage exactly):
//   - field isn't currently gated on (C9/stake on a non-holiday quote —
//     event bills santas/gingerbread only, see QuoteBuilder's isHoliday
//     comment) -> never touch it, no baseline.
//   - field has no lines drawn:
//       - had lines on the PREVIOUS derive (the last line was just deleted)
//         -> reset to 0, clear the baseline.
//       - never had lines -> leave the billed value alone (a manual-only
//         field), no baseline.
//   - field has lines, no PRIOR baseline recorded (a brand-new draw, or the
//     first reconcile after a reopened quote's rehydrate-thaw — see the
//     QuoteBuilder getSetter seeding comment) -> auto-populate with the
//     fresh derived footage.
//   - fresh derived footage differs from the field's OWN prior baseline ->
//     THIS field's geometry changed since the last reconcile -> the redraw
//     wins, take the fresh value.
//   - fresh derived footage equals the prior baseline (this field's own
//     geometry is unchanged) but the currently billed value differs from
//     that baseline -> staff typed a manual override -> keep it untouched.
//   - otherwise (unchanged geometry, no override) -> no-op (already at target).

export type HolidayFootageFieldKey = 'santas' | 'gingerbread' | 'c9' | 'stake';

export type HolidayFootageBaseline = Partial<Record<HolidayFootageFieldKey, number>>;

export type HolidayFieldReconcileInput = {
  /** Whether this field is currently in scope to derive at all — the
   *  positive `serviceType === 'holiday'` gate for C9/stake; always true
   *  for santas/gingerbread (event bills those too). */
  active: boolean;
  hasLines: boolean;
  /** Whether this field's satellite line array had lines on the PREVIOUS derive run. */
  hadLinesPrev: boolean;
  /** Freshly geometry-derived footage for this field's current lines. */
  freshFt: number;
  /** The field's current billed value (form.xFootage). */
  currentBilled: number;
  /** The derived footage recorded at the last reconcile (or seeded at a reopened quote's rehydrate-thaw). */
  baseline: number | undefined;
};

export type HolidayFieldReconcileResult = {
  /** The value to stamp onto the field, or null to leave the billed value untouched. */
  target: number | null;
  /** The baseline to carry into the NEXT reconcile call for this field. */
  nextBaseline: number | undefined;
};

export function reconcileHolidayFootageField(
  input: HolidayFieldReconcileInput,
): HolidayFieldReconcileResult {
  const { active, hasLines, hadLinesPrev, freshFt, currentBilled, baseline } = input;
  if (!active) return { target: null, nextBaseline: undefined };
  if (!hasLines) {
    if (hadLinesPrev) return { target: 0, nextBaseline: undefined };
    return { target: null, nextBaseline: undefined };
  }
  if (baseline == null || freshFt !== baseline) {
    // Brand-new derive, or this field's own geometry changed since the last
    // reconcile -> the redraw wins, even over a standing override.
    return { target: freshFt, nextBaseline: freshFt };
  }
  if (currentBilled !== baseline) {
    // Geometry unchanged, but the billed value has drifted from the derived
    // baseline -> staff typed an override -> keep it.
    return { target: null, nextBaseline: freshFt };
  }
  // Geometry unchanged, no override -> already at target, no-op.
  return { target: null, nextBaseline: freshFt };
}

/**
 * Seeds a reconcile baseline for all four fields from the CURRENTLY drawn
 * (pre-edit) satellite lines — called once, at a reopened quote's
 * rehydrate-thaw (the first real line edit after loading, across ANY of the
 * four fields), so the reconcile above sees a real prior baseline for every
 * already-billed field instead of treating them as brand-new and stamping
 * fresh geometry over a saved manual override (the S24 reopen-clobber
 * class). Mirrors deriveBistroFootageMap
 * (src/lib/permanentBistro/reconcileFootage.ts).
 */
export function deriveHolidayFootageBaseline(fields: {
  santas: { hasLines: boolean; freshFt: number };
  gingerbread: { hasLines: boolean; freshFt: number };
  c9: { active: boolean; hasLines: boolean; freshFt: number };
  stake: { active: boolean; hasLines: boolean; freshFt: number };
}): HolidayFootageBaseline {
  const baseline: HolidayFootageBaseline = {};
  if (fields.santas.hasLines) baseline.santas = fields.santas.freshFt;
  if (fields.gingerbread.hasLines) baseline.gingerbread = fields.gingerbread.freshFt;
  if (fields.c9.active && fields.c9.hasLines) baseline.c9 = fields.c9.freshFt;
  if (fields.stake.active && fields.stake.hasLines) baseline.stake = fields.stake.freshFt;
  return baseline;
}

// Row 333 premerge finding 1 (HIGH, staff): C9/stake are gated `active:
// isHoliday`, and reconcileHolidayFootageField returns `nextBaseline:
// undefined` for an inactive field (by design — see its own comment). The
// derive effect used to rebuild prevHolidayDerivedRef.current from scratch
// every run, so an effect run while serviceType !== 'holiday' silently
// dropped the c9/stake baseline entries entirely. Reachable clobber: draw C9
// on holiday -> hand-type an override -> switch to Event -> edit
// santas/gingerbread (redraw, so the shared effect re-fires) -> switch back
// to holiday -> one more ordinary edit -> C9 has no recorded baseline, gets
// treated as a brand-new draw, and the override gets stamped back to raw
// geometry.
//
// Fix: MERGE into the previous baseline instead of replacing it wholesale.
// An inactive field's key is left completely untouched (whatever it already
// held survives); only an ACTIVE field's key is recomputed from this run's
// reconcile result (set when a fresh baseline exists, cleared when the field
// reports none — e.g. its last line was just deleted). This also resolves
// the paired admin-lens LOW: because the baseline now survives a period of
// inactivity, toggling back to holiday no longer sees a missing baseline and
// redundantly re-stamps the field.
export function mergeHolidayFootageBaseline(
  prevBaseline: HolidayFootageBaseline,
  active: Record<HolidayFootageFieldKey, boolean>,
  results: Record<HolidayFootageFieldKey, HolidayFieldReconcileResult>,
): HolidayFootageBaseline {
  const next: HolidayFootageBaseline = { ...prevBaseline };
  (Object.keys(results) as HolidayFootageFieldKey[]).forEach((field) => {
    if (!active[field]) return; // inactive: leave its existing baseline entry alone
    const nb = results[field].nextBaseline;
    if (nb != null) next[field] = nb;
    else delete next[field];
  });
  return next;
}
