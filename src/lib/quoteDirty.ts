/**
 * Unsaved-edit detection for the quote builder (ledger row 406).
 *
 * Row 406 is a CONFIRMED prod defect: a hand-typed value on a PRICED field
 * (Front footage 95 -> 100) was silently lost. `form` is seeded ONCE from a
 * Server Component prop and edit mode has no autosave, so any reload between
 * the edit and Calculate silently restores the server value, and Calculate
 * then saves the OLD number. Nothing on screen said anything was pending.
 *
 * The signal has to be a CONJUNCTION, because each half alone false-positives
 * in a way that would make the warning noise:
 *
 *   - "the form object changed" alone fires on PROGRAMMATIC writes. Several
 *     effects call setForm at mount on a reopened quote (the permanent-side
 *     derive, the satellite/footage effects). None of those are operator work
 *     — they recompute identically after a reload — so a warning there is
 *     pure noise on a quote nobody has touched.
 *   - "the operator typed something" alone fires on inputs that are NOT part
 *     of the persisted form, the HighLevel contact SEARCH box being the
 *     obvious one. Typing a name to look someone up changes nothing that a
 *     reload could lose.
 *
 * Requiring both means: a real footage edit (typed AND changes the payload)
 * is dirty; a mount derive (changes the payload, nobody typed) is not; a
 * contact search (typed, payload identical) is not. An edit typed and then
 * undone back to its original value is likewise not dirty, which is correct —
 * there is nothing left to lose.
 */

/**
 * JSON.stringify with keys sorted at every level.
 *
 * Plain JSON.stringify is order-sensitive, and the builder rebuilds form
 * slices with spreads (`{ ...f, permanent: { ...f.permanent, x } }`). Spreads
 * preserve insertion order today, but a slice rebuilt field-by-field anywhere
 * in a 7900-line component would reorder keys and read as a change when the
 * VALUES are identical — a false "unsaved changes" warning that no operator
 * action could clear. Sorting removes that whole class.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) return val;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(val as Record<string, unknown>).sort()) {
      sorted[k] = (val as Record<string, unknown>)[k];
    }
    return sorted;
  });
}

/**
 * True when the operator has typed something AND the form no longer matches
 * the snapshot that was last successfully persisted.
 *
 * `userTouched` is a one-way latch — it is never reset on save. Resetting it
 * would drop an edit made WHILE a save was in flight: that save persists the
 * snapshot it sent, so the newer edit is genuinely still unsaved, and the
 * comparison below is what notices. Leaving the latch on is harmless precisely
 * because the comparison, not the latch, decides.
 */
export function quoteHasUnsavedEdits(opts: {
  userTouched: boolean;
  currentForm: string;
  lastPersistedForm: string;
}): boolean {
  return opts.userTouched && opts.currentForm !== opts.lastPersistedForm;
}
