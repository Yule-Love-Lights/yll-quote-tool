// Formatting helpers used across portal sections. Centralized so we
// don't sprinkle Intl formatters through every section component.

export function formatUsd(amount: number, opts?: { fraction?: boolean }): string {
  const fraction = opts?.fraction ?? !Number.isInteger(amount);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: fraction ? 2 : 0,
    maximumFractionDigits: fraction ? 2 : 0,
  }).format(amount);
}


// #184 — dropped the "Your " lead entirely: "Your Our Recommendation" / "Your
// Build Your Own" read as broken English for every package name that isn't a
// plain adjective (most of them). The active package name alone reads fine on
// its own ("Our Recommendation — line by line.", "Build Your Own — line by
// line."), so no lead-word logic is needed anymore.
export function formatIncludedHeading(activeName: string): string {
  return `${activeName.trim()} — line by line.`;
}

// Sum selected line items against a map for the Build Your Own / Custom path.
export function sumSelectedItems(
  selectedIds: Set<string>,
  priceMap: Map<string, number>,
): number {
  let total = 0;
  for (const id of selectedIds) {
    total += priceMap.get(id) ?? 0;
  }
  return total;
}

// Customer-facing quote reference. Real DB IDs are UUIDs ("a1b2c3d4-e5f6-...")
// which are ugly on screen and unmemorable on a phone call. We render a
// short, distinguishable prefix instead — "YLL-A1B2C3D4". Stable per quote;
// no information loss because the route still uses the full UUID.
export function formatQuoteRef(quoteId: string): string {
  // Mock IDs already follow YLL-YEAR-### format — pass them through.
  if (/^YLL-/i.test(quoteId)) return quoteId;
  // UUIDs: take the first segment (8 hex chars) and prefix.
  const head = quoteId.replace(/-/g, '').slice(0, 8).toUpperCase();
  return `YLL-${head}`;
}
