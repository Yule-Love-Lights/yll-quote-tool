// Auto-derive portal packages for a PERMANENT quote (#88 P5).
//
// Permanent lighting is priced per SURFACE (front/sides/back), not the
// holiday roofline/spritzer/decor tier ladder — so it gets its own, much
// simpler package derivation instead of reusing `derivePackages` (which is
// keyed on the holiday Santa's/Gingerbread roofline group and doesn't apply
// here). It DOES reuse the shared money plumbing (`chargesFromResult` +
// `effectiveCharges` + `priceSelection`) so tax/deposit math is identical to
// holiday — permanent just never carries a rush fee or takedown.
//
// Packages are keyed on the pricing engine's STABLE line-item ids
// ('permanent-front' / 'permanent-sides' / 'permanent-back'), never label
// regexes — a side is only offered as a package when its line item is
// actually present on the quote. 'permanent-maintenance' is a toggleable
// add-on line, never a package.

import { chargesFromResult, effectiveCharges, priceSelection } from '@/lib/portal/derivePackages';
import type { PortalLineItem, PortalPackage } from '@/components/portal/types';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';

const FRONT_ID = 'permanent-front';
const SIDES_ID = 'permanent-sides';
const BACK_ID = 'permanent-back';

function priceIds(
  ids: string[],
  lineItems: PortalLineItem[],
  charges: ReturnType<typeof effectiveCharges>,
): { total: number; deposit: number } {
  const idSet = new Set(ids);
  const subtotal = lineItems.reduce(
    (sum, li) => (idSet.has(li.id) ? sum + li.price : sum),
    0,
  );
  return priceSelection(subtotal, charges);
}

export function derivePackagesPermanent(
  lineItems: PortalLineItem[],
  result: QuoteResult,
): PortalPackage[] {
  // Permanent never carries rush/takedown — force both off. Same tax source
  // (chargesFromResult) as holiday so the money math stays identical.
  const charges = effectiveCharges(chargesFromResult(result), false, false);

  const hasFront = lineItems.some((li) => li.id === FRONT_ID);
  const hasSides = lineItems.some((li) => li.id === SIDES_ID);
  const hasBack = lineItems.some((li) => li.id === BACK_ID);

  const packages: PortalPackage[] = [];

  if (hasFront) {
    const p = priceIds([FRONT_ID], lineItems, charges);
    packages.push({
      id: 'A',
      name: 'Front of Home',
      tagline: 'The front of your home.',
      total: p.total,
      deposit: p.deposit,
      includedItemIds: [FRONT_ID],
    });
  }

  if (hasSides) {
    const p = priceIds([SIDES_ID], lineItems, charges);
    packages.push({
      id: 'B',
      name: 'Both Sides',
      tagline: 'Left + right sides.',
      total: p.total,
      deposit: p.deposit,
      includedItemIds: [SIDES_ID],
    });
  }

  if (hasBack) {
    const p = priceIds([BACK_ID], lineItems, charges);
    packages.push({
      id: 'C',
      name: 'Back of Home',
      tagline: 'The back of your home.',
      total: p.total,
      deposit: p.deposit,
      includedItemIds: [BACK_ID],
    });
  }

  const presentSideIds = [FRONT_ID, SIDES_ID, BACK_ID].filter((id) =>
    lineItems.some((li) => li.id === id),
  );
  if (presentSideIds.length > 0) {
    const p = priceIds(presentSideIds, lineItems, charges);
    packages.push({
      id: 'D',
      name: 'Whole Home',
      tagline: 'Every side we can light.',
      total: p.total,
      deposit: p.deposit,
      includedItemIds: presentSideIds,
    });
  }

  return packages;
}
