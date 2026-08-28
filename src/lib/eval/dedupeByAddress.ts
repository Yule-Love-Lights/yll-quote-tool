// dedupeByAddress — groups eval rows by NORMALIZED address so a corpus-wide
// summary can report a per-address view alongside the per-row one.
//
// WHY THIS EXISTS: the training_examples corpus has duplicate captures of
// the same house (one address captured 9 times across different quotes/
// visits). A corpus-wide summary that pools every ROW equally lets that one
// much-captured house dominate the headline precision/recall/F1 the way one
// repeat customer would dominate an average review score. This module never
// discards or merges rows — it only groups them so a caller can compute a
// macro-average (one number per address, then averaged across addresses,
// equal weight regardless of capture count) alongside the existing
// micro-average (one number per row). Both views carry information; this
// module produces neither on its own, it just does the grouping + averaging
// primitives the caller composes with its own per-category summarizer.
//
// Pure + I/O-free, like placementEval.ts — the only caller is
// scripts/eval-placement.ts.

export function normalizeAddress(address: string | null | undefined): string {
  if (!address) return '';
  return address.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Groups items by normalized address. An item with a blank/missing address
// becomes its OWN singleton group — never pooled with other addressless
// items. We have no way to know two addressless rows are the same house, so
// grouping them on nothing would reintroduce the exact false-pooling bug
// this module exists to avoid.
export function groupByAddress<T extends { address: string | null }>(
  items: readonly T[],
): T[][] {
  const groups = new Map<string, T[]>();
  const singletons: T[][] = [];
  for (const item of items) {
    const key = normalizeAddress(item.address);
    if (key === '') {
      singletons.push([item]);
      continue;
    }
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values(), ...singletons];
}

// Macro-average (equal weight per group) of a numeric-or-null field that has
// ALREADY been reduced to one value per group (e.g. one precision value per
// address). A null (mathematically undefined — e.g. a category with zero
// examples in that group) is EXCLUDED from the mean, never treated as 0 —
// the same null-vs-0 convention placementEval.ts documents at its top.
// Returns null when every value is null (nothing to average).
export function macroMean(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) / present.length : null;
}
