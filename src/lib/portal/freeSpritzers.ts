// Free-spritzer detection for the customer portal.
//
// Staff give returning customers free spritzers, and prod says they almost
// never record that as a $0 line item. Measured 2026-09-03 over all 225 live
// quotes: 91 quotes promise free spritzers (318 spritzers, 2 to 8 each) and
// only 3 of them carry a $0 spritzer line. The other 94 of 96 lines write the
// promise into the label of a PAID package line, e.g.
//
//   "Santa's Roofline Display Package · 6 FREE Spritzers!"   ($940)
//
// So the count has to be read out of the label text. That is staff free text,
// which means this module's job is to be honest about what it cannot read: a
// label that clearly promises free spritzers but states no number returns
// `present: true, count: null`, and the portal then says "free spritzers
// included" with no figure rather than inventing one. Exactly one live label
// hits that path today (#1123, "32" LED Spritzers - 6 Free For Staying With
// Us!" — the number sits before the word "free", not after it).
//
// Two real dirty spots in the live data this handles on purpose:
//   - the "sprtizer" transposition (#1146), hence the [it]{2} character class
//   - a label bundling other gifts (#1146, "Free 48" Wreath Upgrade & 2 FREE
//     Sprtizers") — only the spritzer number is read, the wreath is ignored
//
// Nothing here touches money. It reads labels and returns a count for display.

/** How near the word "free" has to sit to a spritzer word for the label to
 *  count as promising free spritzers. Wide enough for "Spritzers - 6 Free For
 *  Staying With Us!" (12 characters apart), tight enough that an unrelated
 *  "for free this year" elsewhere in a long package label does not attach
 *  itself to a paid spritzer line mentioned further along. */
const PROXIMITY_CHARS = 40;

/** "spritzer" plus the transposed spelling that exists in live data. */
const SPRITZER_RE = /spr[it]{2}zers?/gi;
const FREE_RE = /\bfree\b/gi;

/** The two shapes staff actually write: "6 FREE Spritzers!" and
 *  "FREE Spritzers x4". Global, so a label promising two separate batches
 *  sums instead of reporting only the first. */
const COUNTED_RE = /(\d+)\s*free\s+spr[it]{2}zers?|free\s+spr[it]{2}zers?\s*[x×]\s*(\d+)/gi;

export type FreeSpritzerSummary = {
  /** true when at least one label promises free spritzers. */
  present: boolean;
  /** How many, or null when a label promises them without stating a number.
   *  Never 0 when `present` is true: no number means null, not none. */
  count: number | null;
};

const NONE: FreeSpritzerSummary = { present: false, count: null };

function matchPositions(label: string, re: RegExp): number[] {
  // matchAll requires a global regex and does not mutate shared lastIndex
  // state the way a manual scan does, so these module-level regexes stay safe
  // to reuse across calls.
  return Array.from(label.matchAll(re), (m) => m.index ?? 0);
}

/** Does this label promise free spritzers at all? Proximity-based rather than
 *  "contains both words", so a label that happens to mention something else
 *  being free does not turn a paid spritzer line into a gift. */
export function labelPromisesFreeSpritzers(label: string): boolean {
  if (typeof label !== 'string' || label.length === 0) return false;
  const spritzers = matchPositions(label, SPRITZER_RE);
  if (spritzers.length === 0) return false;
  const frees = matchPositions(label, FREE_RE);
  if (frees.length === 0) return false;
  return spritzers.some((s) => frees.some((f) => Math.abs(s - f) <= PROXIMITY_CHARS));
}

/** The stated count in one label, or null when it promises without a number. */
function countInLabel(label: string): number | null {
  let total: number | null = null;
  for (const m of label.matchAll(COUNTED_RE)) {
    const raw = m[1] ?? m[2];
    const n = Number.parseInt(raw, 10);
    // A stated zero is staff writing something odd, not a promise of nothing —
    // treat it as unreadable rather than announcing "0 free spritzers".
    if (Number.isFinite(n) && n > 0) total = (total ?? 0) + n;
  }
  return total;
}

/**
 * Read every line-item label on a quote and report the free spritzers it
 * promises. Labels come from the portal's own line items, so this sees exactly
 * what the customer sees on the page.
 *
 * A quote whose labels promise free spritzers but state no number anywhere
 * comes back `{ present: true, count: null }` — the caller shows the thank you
 * without a figure.
 */
export function summarizeFreeSpritzers(labels: readonly string[]): FreeSpritzerSummary {
  if (!Array.isArray(labels) || labels.length === 0) return NONE;

  let present = false;
  let count: number | null = null;

  for (const label of labels) {
    if (!labelPromisesFreeSpritzers(label)) continue;
    present = true;
    const n = countInLabel(label);
    if (n !== null) count = (count ?? 0) + n;
  }

  return present ? { present, count } : NONE;
}
