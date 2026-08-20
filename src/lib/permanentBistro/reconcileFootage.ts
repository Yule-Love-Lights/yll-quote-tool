// Permanent Bistro Lighting (#244): per-run footage RECONCILE against a
// hand-typed override — the ARRAY analog of the holiday/permanent scalar
// "auto-measured, adjust if needed" fields (QuoteBuilder.tsx's santas/
// gingerbread/C9/stake derive effect, and the permanent side-footage effect).
//
// Those effects compare ONE scalar against ONE derived target. Bistro is an
// ARRAY of independent runs sharing a single satellite line array
// (satelliteBistroLines), so redrawing any ONE run re-fires the whole derive
// effect — without per-run identity, that would clobber a hand-typed
// override on every OTHER, untouched run. BistroLine already carries a
// stable `id` (#117 MED — assigned when a run is drawn, persisted with the
// design), so this reconciles BY ID instead of by array position.
//
// Rule per run (id-keyed):
//   - run has no PRIOR baseline recorded (a brand-new run, or the first
//     reconcile after a reopened quote's rehydrate-and-thaw — see the
//     QuoteBuilder getSetter('bistro') seeding comment) -> take the fresh
//     derived footage (auto-populate).
//   - the fresh derived footage differs from the run's PRIOR baseline -> that
//     run's OWN geometry changed since the last reconcile (a redraw) -> the
//     redraw WINS, take the fresh derived footage. Mirrors the holiday
//     precedent: staff physically dragging a line always wins.
//   - fresh derived footage equals the prior baseline (this run's own
//     geometry is unchanged) but the currently billed value differs from
//     that baseline -> staff typed a manual override -> keep it untouched.
//   - otherwise (unchanged geometry, no override) -> take the fresh value
//     (a no-op; it already equals the billed value).
// A run no longer present in `freshRuns` (deleted) is simply absent from the
// output and from the returned baseline, so it can't resurrect a stale
// override if some future run ever reused its id.
//
// A run with no `id` (shouldn't happen for any run created post-#117, but a
// defensive fallback for legacy/synthesized data) has no identity to
// reconcile against, so it always takes the fresh derived value — the same
// as a brand-new run.

export type BistroRunFootage = { id?: string; footage: number };

export type ReconcileBistroResult = {
  /** The array to stamp onto form.permanentBistro.bistro, in freshRuns order. */
  next: BistroRunFootage[];
  /** The id -> derived-footage baseline to carry into the NEXT reconcile call. */
  nextBaseline: Record<string, number>;
};

/**
 * @param freshRuns   Freshly geometry-derived footage for every CURRENTLY
 *   drawn run, in draw order, each carrying its stable id.
 * @param currentForm The current billed array (form.permanentBistro.bistro)
 *   to reconcile against — may hold a hand-typed override per run.
 * @param baseline    id -> the derived footage recorded at the last
 *   reconcile (or seeded at a reopened quote's rehydrate-thaw).
 */
export function reconcileBistroFootage(
  freshRuns: BistroRunFootage[],
  currentForm: BistroRunFootage[],
  baseline: Record<string, number>,
): ReconcileBistroResult {
  const nextBaseline: Record<string, number> = {};
  const next: BistroRunFootage[] = freshRuns.map((run) => {
    const fresh = run.footage;
    if (run.id == null) {
      // No stable identity to preserve an override against — always follow
      // the fresh derived value (same treatment as a brand-new run).
      return { footage: fresh };
    }
    nextBaseline[run.id] = fresh;
    const priorBaseline = baseline[run.id];
    const currentEntry = currentForm.find((b) => b.id === run.id);
    if (currentEntry == null || priorBaseline == null) {
      // New run, or no recorded baseline yet for it -> auto-populate.
      return { id: run.id, footage: fresh };
    }
    if (fresh !== priorBaseline) {
      // This run's own geometry changed since the last reconcile -> the
      // redraw wins, even over a standing override.
      return { id: run.id, footage: fresh };
    }
    if (currentEntry.footage !== priorBaseline) {
      // Geometry unchanged, but the billed value has drifted from the
      // derived baseline -> staff typed an override -> keep it.
      return { id: run.id, footage: currentEntry.footage };
    }
    // Geometry unchanged, no override -> keep following the derive.
    return { id: run.id, footage: fresh };
  });
  return { next, nextBaseline };
}
