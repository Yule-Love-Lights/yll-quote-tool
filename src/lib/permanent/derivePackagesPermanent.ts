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
  // #199 F1: threaded straight to chargesFromResult — see its own comment
  // (derivePackages.ts) for why the live inputs.depositPercent must win over
  // a possibly-stale result.depositRate.
  depositPercent?: number,
): PortalPackage[] {
  // Permanent never carries rush/takedown — force both off. Same tax source
  // (chargesFromResult) as holiday so the money math stays identical.
  const charges = effectiveCharges(chargesFromResult(result, depositPercent), false, false);

  const hasFront = lineItems.some((li) => li.id === FRONT_ID);
  // The sides package bundles whichever side lines this result carries: the
  // split left/right lines (#132) or a legacy combined 'permanent-sides' line.
  const sideIds = lineItems
    .map((li) => li.id)
    .filter((id) => id === LEFT_ID || id === RIGHT_ID || id === LEGACY_SIDES_ID);
  const hasBack = lineItems.some((li) => li.id === BACK_ID);

  // Custom/manual lines staff marked "bundle into every package" (the builder's
  // per-line choice; see PortalLineItem.bundleInAllTiers). They ride each
  // surface package below so a customer who picks Front & Sides is still billed
  // for, and still gets, that work. The default is OFF, which keeps a custom
  // line in Whole Home alone exactly as before. The maintenance add-on is
  // excluded by name: it is an opt-in line that belongs in no package at all,
  // and it must not become bundle-able through this door.
  const allTierCustomIds = lineItems
    .filter((li) => li.bundleInAllTiers === true && li.id !== MAINTENANCE_ID)
    .map((li) => li.id);

  // WT-05: `sideIds` only tells us a side line is present, not that BOTH
  // sides are — a townhome/corner-lot quote can measure just one. Name the
  // package for the specific side(s) actually billed so the customer is
  // never shown "Both Sides" when only one was measured. The legacy combined
  // line always represents both sides bundled into one line.
  const hasLeft = lineItems.some((li) => li.id === LEFT_ID);
  const hasRight = lineItems.some((li) => li.id === RIGHT_ID);
  const hasLegacySides = lineItems.some((li) => li.id === LEGACY_SIDES_ID);
  const isBothSides = hasLegacySides || (hasLeft && hasRight);

  const packages: PortalPackage[] = [];

  if (hasFront) {
    const ids = [FRONT_ID, ...allTierCustomIds];
    const p = priceIds(ids, lineItems, charges);
    packages.push({
      id: 'A',
      name: 'Front of Home',
      tagline: 'The front of your home.',
      total: p.total,
      deposit: p.deposit,
      includedItemIds: ids,
    });
  }

  // Package B = "Front & Sides" (#133, Jason S24): the front PLUS both sides,
  // so tapping tier 2 selects front + left + right. On a quote with no front
  // line it degrades to the sides alone. WT-05: the name/tagline are keyed on
  // WHICH side ids are actually present — a one-side-only quote is named for
  // that specific side, never "Both Sides" / "Front & Sides".
  if (sideIds.length > 0) {
    const bIds = [...(hasFront ? [FRONT_ID, ...sideIds] : sideIds), ...allTierCustomIds];
    const p = priceIds(bIds, lineItems, charges);

    let sidesName: string;
    let sidesTagline: string;
    if (isBothSides) {
      sidesName = hasFront ? 'Front & Sides' : 'Both Sides';
      sidesTagline = hasFront ? 'The front plus both sides.' : 'Left + right sides.';
    } else if (hasLeft) {
      sidesName = hasFront ? 'Front & Left Side' : 'Left Side';
      sidesTagline = hasFront ? 'The front plus the left side.' : 'The left side.';
    } else {
      sidesName = hasFront ? 'Front & Right Side' : 'Right Side';
      sidesTagline = hasFront ? 'The front plus the right side.' : 'The right side.';
    }

    packages.push({
      id: 'B',
      name: sidesName,
      tagline: sidesTagline,
      total: p.total,
      deposit: p.deposit,
      includedItemIds: bIds,
    });
  }

  if (hasBack) {
    const ids = [BACK_ID, ...allTierCustomIds];
    const p = priceIds(ids, lineItems, charges);
    packages.push({
      id: 'C',
      name: 'Back of Home',
      tagline: 'The back of your home.',
      total: p.total,
      deposit: p.deposit,
      includedItemIds: ids,
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

  // "Our Recommendation" (E) — the set staff ticked in the builder (any of the
  // four sides, plus any custom line marked recommended).
  //
  // Until this existed, a permanent quote had no way to SAY that a set was the
  // staff pick. The recommend ticks only pre-selected a tier when the ticked
  // set happened to equal that tier exactly (see the portal page's permanent
  // seed); any other mix opened on an unlabelled custom selection, so the
  // customer never learned it was a recommendation.
  //
  // Two shapes, deliberately:
  //   • the ticked set IS an offered tier → badge that tier and mint nothing,
  //     because a second card with the same items and the same price is just a
  //     confusing duplicate (the same reasoning as holiday's same-price tier
  //     dedupe in the adapter).
  //   • the ticked set is a mix no tier covers → its own card, LAST, so the
  //     "Tier N" numbering the portal derives by position stays contiguous for
  //     A/B/C/D.
  // Nothing ticked → no card and no badge, unchanged.
  //
  // The maintenance add-on is excluded for the same reason it is excluded from
  // every other package: it is opt-in, and bundling it would silently bill it.
  const recommendedIds = lineItems
    .filter((li) => li.recommended === true && li.id !== MAINTENANCE_ID)
    .map((li) => li.id);
  if (recommendedIds.length > 0) {
    const alreadyOffered = packages.find((pkg) => sameIdSet(pkg.includedItemIds, recommendedIds));
    if (alreadyOffered) {
      alreadyOffered.recommended = true;
    } else {
      const p = priceIds(recommendedIds, lineItems, charges);
      packages.push({
        id: 'E',
        name: 'Our Recommendation',
        tagline: 'Hand-picked by our team for your home.',
        total: p.total,
        deposit: p.deposit,
        recommended: true,
        includedItemIds: recommendedIds,
      });
    }
  }

  return packages;
}
