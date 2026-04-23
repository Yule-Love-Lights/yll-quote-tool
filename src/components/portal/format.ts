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

// Deposit is always 50% per business rules.
export function depositFor(total: number): number {
  return Math.round(total * 50) / 100;
}
