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
// ('permanent-front' / 'permanent-left' / 'permanent-right' / 'permanent-back'
// — plus the pre-#132 combined 'permanent-sides' still present on legacy stored
// results), never label regexes — a side is only offered as a package when its
// line item is actually present on the quote. 'permanent-maintenance' is a
// toggleable add-on line, never a package.

import { chargesFromResult, effectiveCharges, priceSelection } from '@/lib/portal/derivePackages';
import type { PortalLineItem, PortalPackage } from '@/components/portal/types';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';

const FRONT_ID = 'permanent-front';
const LEFT_ID = 'permanent-left';
const RIGHT_ID = 'permanent-right';
// Pre-#132 results carry ONE combined sides line under this id — keep honoring
// it so the sides package doesn't vanish from an already-sent quote's portal.
const LEGACY_SIDES_ID = 'permanent-sides';
const BACK_ID = 'permanent-back';
const MAINTENANCE_ID = 'permanent-maintenance';

/** Same id set regardless of order — used to suppress a duplicate tier. */
function sameIdSet(a: string[], b: string[]): boolean {
  return a.length === b.length && new Set([...a, ...b]).size === a.length;
}

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
  // The sides package bundles whichever side lines this result carries: the
  // split left/right lines (#132) or a legacy combined 'permanent-sides' line.
  const sideIds = lineItems
    .map((li) => li.id)
    .filter((id) => id === LEFT_ID || id === RIGHT_ID || id === LEGACY_SIDES_ID);
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

  // Package B = "Front & Sides" (#133, Jason S24): the front PLUS whichever
  // side lines are present, so tapping tier 2 selects front + side(s). On a
  // quote with no front line it degrades to the sides alone (named honestly).
  //
  // WT-05: the name must reflect which side ids are ACTUALLY present — a
  // one-side home (townhome/corner lot) is NOT required to carry both
  // LEFT_ID and RIGHT_ID, so "Both Sides" / "Front & Sides" would falsely
  // claim both sides are covered. The combined legacy line always means
  // both (it's one pre-#132 line covering the whole sides surface).
  if (sideIds.length > 0) {
    const bIds = hasFront ? [FRONT_ID, ...sideIds] : sideIds;
    const bothSides =
      sideIds.includes(LEGACY_SIDES_ID) || (sideIds.includes(LEFT_ID) && sideIds.includes(RIGHT_ID));
    const oneSideLabel = sideIds.includes(LEFT_ID) ? 'Left Side' : 'Right Side';
    const p = priceIds(bIds, lineItems, charges);
    packages.push({
      id: 'B',
      name: hasFront
        ? bothSides
          ? 'Front & Sides'
          : `Front & ${oneSideLabel}`
        : bothSides
          ? 'Both Sides'
          : oneSideLabel,
      tagline: hasFront
        ? bothSides
          ? 'The front plus both sides.'
          : `The front plus your ${oneSideLabel.toLowerCase()}.`
        : bothSides
          ? 'Left + right sides.'
          : `Your ${oneSideLabel.toLowerCase()}.`,
      total: p.total,
      deposit: p.deposit,
      includedItemIds: bIds,
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

  // Whole Home (D) = every billable line — the present surfaces PLUS any
  // custom/manual (#27) line items — EXCEPT the opt-in maintenance add-on.
  //   • #125-3: custom items carry a non-'permanent-' id, so they sit in NO
  //     A/B/C surface package. Without them here they default OFF on the portal
  //     and go silently UNBILLED at approval (the approve route only bills the
  //     selected ids). Bundling them into D fixes that — mirrors holiday's
  //     "everything" tier (derivePackages Tier C).
  //   • #125-2: only emit D when it bundles MORE THAN ONE billable line AND its
  //     id set differs from every A/B/C package already offered. A single-surface
  //     quote makes D byte-identical to its lone A/B/C package, and (post-#132) a
  //     left+right-only quote makes D identical to B — both redundant tiers.
  //     (One surface + a custom item is two lines that no A/B/C covers, so D
  //     still appears and carries the custom line.)
  const wholeHomeIds = lineItems
    .map((li) => li.id)
    .filter((id) => id !== MAINTENANCE_ID);
  if (wholeHomeIds.length > 1 && !packages.some((pkg) => sameIdSet(pkg.includedItemIds, wholeHomeIds))) {
    const p = priceIds(wholeHomeIds, lineItems, charges);
    packages.push({
      id: 'D',
      name: 'Whole Home',
      tagline: 'Every side we can light.',
      total: p.total,
      deposit: p.deposit,
      includedItemIds: wholeHomeIds,
    });
  }

  return packages;
}
