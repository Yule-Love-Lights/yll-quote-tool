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
// Rule per field (baseline-keyed, mirrors reconcileHolidayFootageField, with
// ONE addition this file needed and holiday's didn't — see `active` vs
// `canDerive` below):
//   - field is out of SCOPE entirely (`active: false` — not currently used by
//     any permanent call site; kept for parity with the holiday/bistro
//     reconcilers and as a future hook, since QuoteBuilder's derive effect
//     already gates the whole effect on `form.serviceType === 'permanent'`
//     before any of the 8 fields are reconciled) -> never touch it, no
//     baseline, full stop — not even the delete-transition below.
//   - field has no lines drawn on its side:
//       - had lines on the PREVIOUS derive (the last line on this side was
//         just deleted) -> reset to 0, clear the baseline. This fires
//         REGARDLESS of `canDerive` — corners resets the same way footage
//         does even when footage has no known satellite scale (a manual
//         satellite upload). Row 345 premerge finding 1 (HIGH): the
//         pre-fix code gated this on `active: hasScale` for footage, so
//         deleting a side's last line while on a manual upload left its
//         footage stuck at a stale non-zero value with zero lines and zero
//         corners — a state the reopened-quote billed-but-untraced warning
//         can't even catch, since PS-B1's own signal is "has footage but no
//         trace," which this state satisfies by construction.
//       - never had lines -> leave the billed value alone (a manual-only
//         field), no baseline.
//   - field HAS lines but no fresh value can be derived this run
//     (`canDerive: false` — footage with no known satellite scale; corners
//     is scale-free so it's always derivable while its side has lines) ->
//     nothing to compare against. Leave the billed value untouched AND echo
//     the existing baseline through unchanged (not cleared) — so a later
//     satellite scale (an address re-pull) resumes the override comparison
//     exactly where it left off, instead of treating the field as brand-new
//     and re-stamping over a standing override the moment scale returns.
//     This is what lets mergePermanentSideFootageBaseline (below) apply
//     every field's result unconditionally — the "leave an inactive field's
//     key alone" job that row 333's merge fix did for holiday is done HERE
//     instead, inside the field-level echo, so it can't disagree with the
//     delete-transition reset above (which explicitly DOES want its `undefined`
//     applied even with no scale).
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
// Why `active` and `canDerive` are two separate flags (row 345 premerge
// finding 1, HIGH, all four lenses): the pre-fix code had ONE `active` flag
// doing both jobs at once — `active: hasScale` for footage. In the holiday
// reconciler `active` genuinely means "out of scope" (C9/stake are simply
// not billed on an event quote). Permanent has no such out-of-scope field —
// all 8 fields are always in scope once the effect's own
// `serviceType === 'permanent'` gate has passed — so overloading `active` to
// also mean "derivable right now" made the delete-transition branch
// (unreachable once `!active` short-circuits) invisible exactly when a side
// had lines, lost its scale (a manual satellite upload mid-session), and
// then had its last line deleted. Splitting the two flags keeps the
// delete-transition reachable in every scale state while still gating the
// fresh-value comparison on whether a fresh value actually exists.
//
// Merge is now unconditional, not gated (contrast with row 333's holiday
// merge, which still gates on `active`): every field's `nextBaseline` above
// already encodes exactly what should happen to its baseline entry in every
// state — echoed unchanged when not derivable, explicitly cleared on a
// delete-transition, or recomputed from a fresh value — so
// mergePermanentSideFootageBaseline can apply every result as-is. See its
// own comment below for why gating it by scale (the old design) would have
// left a delete-transition's explicit "clear this baseline" silently
// skipped whenever the side had no known scale.

export type PermanentSideKey = 'front' | 'left' | 'right' | 'back';

export type PermanentSideFieldKey =
  | 'frontFootage' | 'frontCorners'
  | 'leftFootage' | 'leftCorners'
  | 'rightFootage' | 'rightCorners'
  | 'backFootage' | 'backCorners';

export type PermanentSideFootageBaseline = Partial<Record<PermanentSideFieldKey, number>>;

export type PermanentSideFieldReconcileInput = {
  /** Whether this field is in SCOPE at all. Not currently driven false by any
   *  permanent call site (the derive effect already gates the whole run on
   *  `form.serviceType === 'permanent'` before reconciling any of the 8
   *  fields) — kept for parity with the holiday/bistro reconcilers, whose
   *  own `active` genuinely does gate out-of-scope fields (C9/stake off a
   *  holiday quote). See `canDerive` below for the flag that replaces what
   *  permanent's OLD `active` used to mean. */
  active: boolean;
  hasLines: boolean;
  /** Whether this side's satellite line array had lines on the PREVIOUS derive run. */
  hadLinesPrev: boolean;
  /** Whether a fresh value CAN be derived this run — false for a footage
   *  field with no known satellite scale (a manual satellite upload);
   *  always true for corners (scale-free) while its side has lines. Row 345
   *  premerge finding 1 (HIGH): this used to be folded into `active`, which
   *  made the delete-transition below unreachable whenever a side had no
   *  scale — deleting its last line left a stale non-zero footage stamped
   *  with zero lines and zero corners. Splitting it out keeps the
   *  delete-transition reachable in every scale state. */
  canDerive: boolean;
  /** Freshly geometry-derived value for this field's current lines. Ignored
   *  when `canDerive` is false — the caller has nothing real to pass here
   *  in that case. */
  freshValue: number;
  /** The field's current billed value (form.permanent.<side><Footage|Corners>). */
  currentBilled: number;
  /** The derived value recorded at the last reconcile (or seeded at a reopened quote's rehydrate-thaw). */
  baseline: number | undefined;
  /**
   * Row 379 (S48 #921 delta-verify MED): true when `baseline` was captured
   * under a DIFFERENT satellite scale than the one that produced this run's
   * `freshValue` — reachable across a service-type switch (reopen a
   * permanent quote frozen -> switch to permanent_bistro before the first
   * edit thaws it -> a fresh street lookup pulls a new scale and thaws ->
   * switch back to permanent). `freshValue !== baseline` in that case is a
   * SCALE artifact, not evidence this field's own geometry changed, so it
   * must not be trusted the way a real redraw is. Only meaningful for
   * footage (scale-derived); corners is scale-free and callers should always
   * pass false (the default) for it. Optional + defaulted so every existing
   * call site (which has no scale-provenance concept) is unaffected.
   */
  scaleChanged?: boolean;
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
  const { active, hasLines, hadLinesPrev, canDerive, freshValue, currentBilled, baseline, scaleChanged = false } = input;
  if (!active) return { target: null, nextBaseline: undefined };
  if (!hasLines) {
    // Fires REGARDLESS of canDerive — a side with no known scale still needs
    // its footage zeroed (and its baseline cleared) when its last line is
    // deleted; see the row-345-finding-1 header comment above.
    if (hadLinesPrev) return { target: 0, nextBaseline: undefined };
    return { target: null, nextBaseline: undefined };
  }
  if (!canDerive) {
    // Lines exist, but there's no fresh value to compare against this run
    // (no known satellite scale). Leave the billed value alone AND echo the
    // baseline through unchanged, rather than clearing it — so a later
    // scale (an address re-pull) resumes the override comparison exactly
    // where it left off instead of treating the field as brand-new.
    return { target: null, nextBaseline: baseline };
  }
  if (scaleChanged && baseline != null) {
    // Row 379: `baseline` was captured under a scale that is no longer the
    // one in effect. `freshValue !== baseline` here proves nothing about
    // this side's own geometry — it may be purely the scale difference — so
    // don't let it win the way a real redraw does (`target: freshValue`
    // below would silently rescale/clobber a standing override on a side
    // nobody touched). Resync the baseline to this run's fresh value under
    // the NEW scale and leave the billed value exactly as the operator left
    // it; the next run compares like-for-like again. If baseline is null
    // there's nothing to resync against — falls through to the brand-new
    // auto-populate branch below, same as any first-ever derive.
    return { target: null, nextBaseline: freshValue };
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
 * shape, i.e. `canDerive: false` for that field) — that side's footage key
 * is left out of the baseline entirely (nothing to seed a comparison
 * against yet); corners is scale-free so it seeds whenever the side has
 * lines. Row 345 finding 1 re-check: this is still correct under the
 * canDerive split — a field with no seeded baseline and canDerive false
 * simply echoes `undefined` through reconcilePermanentSideField's own
 * `!canDerive` branch until a scale first appears, at which point it's
 * treated as a brand-new draw (same as any field that's never had a
 * recorded baseline).
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

// Shape mirrors mergeHolidayFootageBaseline (row 333 finding 1, HIGH): MERGE
// into the previous baseline instead of replacing it wholesale, so a field
// this call doesn't touch keeps whatever it already had.
//
// Row 345 finding 1 fix changed what the `active` argument means here in
// practice: reconcilePermanentSideField now handles "leave an
// undeliverable field's baseline alone" ITSELF (the `canDerive: false`
// branch echoes `baseline` back unchanged), so QuoteBuilder's real call
// site passes `active: true` for all 8 fields, every run — the per-field
// skip this argument still supports below is dead at that call site (kept
// for shape parity with the holiday merge, and because a false-and-skip is
// still a safe no-op if a future caller ever needs it). This matters
// because the OLD design gated this by `hasScale` for footage, and that
// would have SILENTLY REVERSED the row 345 finding 1 fix: the
// delete-transition branch above explicitly wants its `nextBaseline:
// undefined` (a real "clear this field's baseline") applied even when
// there's no scale, and a scale-gated skip here would have left the STALE
// pre-delete baseline value sitting in the map — self-consistent (the field
// never gets a fresh comparison until scale returns) but wrong for the
// same reason the finding-1 fix exists: this side has zero lines, zero
// corners, and should have zero recorded baseline too.
export function mergePermanentSideFootageBaseline(
  prevBaseline: PermanentSideFootageBaseline,
  active: Record<PermanentSideFieldKey, boolean>,
  results: Record<PermanentSideFieldKey, PermanentSideFieldReconcileResult>,
): PermanentSideFootageBaseline {
  const next: PermanentSideFootageBaseline = { ...prevBaseline };
  (Object.keys(results) as PermanentSideFieldKey[]).forEach((field) => {
    if (!active[field]) return; // caller opted this field out entirely: leave its existing entry alone
    const nb = results[field].nextBaseline;
    if (nb != null) next[field] = nb;
    else delete next[field];
  });
  return next;
}

/**
 * Which permanent side fields currently hold a STANDING MANUAL OVERRIDE
 * (ledger row 405).
 *
 * Same test the reconcile itself uses to decide an override exists: a field
 * has a recorded derived baseline, and the billed value no longer equals it
 * (`currentBilled !== baseline`, the "staff typed an override -> keep it"
 * branch above). Extracted so the re-analyze path can ASK the question before
 * it throws the baselines away, rather than discovering the answer after.
 *
 * Why this exists: "Analyze from Address" for a DIFFERENT address resets
 * `prevPermSideDerivedRef`/`prevPermSideScaleRef` on purpose — without that
 * reset, the second address's real footage is misread as a pure scale
 * artifact and the FIRST address's wrong number sticks forever. But the reset
 * also discards any hand-typed override, and unlike the two sibling
 * satellite-replacement paths (`handleSatelliteSelect`, `applyPulledSatellite`)
 * that path had NO confirm — so footage, which drives price, could be wiped
 * with no warning. This tells the caller exactly which fields are at stake so
 * the operator can be told what they are about to lose.
 *
 * A field with no baseline is NOT an override: it was never derived, so there
 * is nothing to have drifted from (a manual-only field on a side with no
 * lines is the ordinary case, and warning about it would be noise).
 */
export function permanentSideOverriddenFields(
  baseline: PermanentSideFootageBaseline,
  billed: Partial<Record<PermanentSideFieldKey, number | null | undefined>>,
): PermanentSideFieldKey[] {
  return (Object.keys(baseline) as PermanentSideFieldKey[]).filter((key) => {
    const base = baseline[key];
    if (base == null) return false;
    const current = billed[key];
    if (current == null) return false;
    return current !== base;
  });
}

/** Human-readable "Front footage", "Left corners", ... for a confirm dialog. */
export function describePermanentSideField(key: PermanentSideFieldKey): string {
  const side = key.replace(/(Footage|Corners)$/, '');
  const what = key.endsWith('Footage') ? 'footage' : 'corners';
  return `${side.charAt(0).toUpperCase()}${side.slice(1)} ${what}`;
}
