// Default B1(b) — auto-derive A/B/C/D packages from a single QuoteResult.
//
// The pricing engine produces ONE total. The portal shows FOUR tiers.
// Until packages become a first-class DB concept, we bucket the existing
// line items into three escalating sets and let the customer pick:
//
//   A "Classic Glow"    → rooflines + ridges only (the silhouette)
//   B "Full Festive"    → A + trees + bushes + columns (bones + greenery)
//   C "Full Yule"       → B + wreaths + garland + spritzers (everything)
//   D "Build Your Own"  → empty; runtime-derived from selected items
//
// Per-package totals include the same per-job add-ons as the original
// quote (rush fee, premium takedown, sales tax) so the customer pays
// the same operational charges regardless of which tier they pick. The
// only thing that varies between A/B/C is the bundled line-item subtotal.
//
// Per-package totals are the REAL tax-inclusive price of the bucket's items
// (no $1,000 floor — the minimum is a customer-side approval gate on the
// portal, not a silent bump; see minimumOrderSubtotal). Empty packages (no
// items in this quote that match the bucket) get total: 0 so they render as
// "—" and can't be selected.

import { BUSINESS_RULES } from '@/lib/pricing/pricingEngine';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';
import type {
  PackageId,
  PortalCharges,
  PortalLineItem,
  PortalLineItemKind,
  PortalPackage,
  SelectionCharges,
  SelectionPrice,
} from '@/components/portal/types';

// Which kinds belong to which tier. Tiers stack — B includes A's kinds, etc.
const TIER_A_KINDS: ReadonlySet<PortalLineItemKind> = new Set(['roofline', 'ridge']);
const TIER_B_EXTRA: ReadonlySet<PortalLineItemKind> = new Set(['tree', 'bush', 'column']);
const TIER_C_EXTRA: ReadonlySet<PortalLineItemKind> = new Set(['wreath', 'garland', 'spritzer', 'bow']);

function effectiveTaxRate(result: QuoteResult): number {
  // Prefer the actual ratio from this specific quote (handles future cases
  // where tax exemption or local rate adjustments land per-quote). Fall
  // back to the canonical business-rules rate when the original taxable
  // amount was zero or missing (older rows pre-dating the field would
  // NaN the division otherwise).
  const taxable = typeof result.taxableAmount === 'number' ? result.taxableAmount : 0;
  const tax = typeof result.taxAmount === 'number' ? result.taxAmount : 0;
  if (taxable > 0) return tax / taxable;
  return BUSINESS_RULES.taxRate;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Per-quote fee CONFIG pulled from the pricing result: the canonical rush +
// premium-takedown amounts (charged when toggled ON) and the default on/off
// state staff set in the builder (a fee defaults on when the staff quote
// already includes it), plus the effective tax rate. Shared by the
// package-card totals here AND the live SelectionContext total (#4/#18).
export function chargesFromResult(result: QuoteResult): PortalCharges {
  return {
    taxRate: effectiveTaxRate(result),
    rush: {
      amount: BUSINESS_RULES.rushFeeAmount,
      defaultOn: (typeof result.rushFeeAmount === 'number' ? result.rushFeeAmount : 0) > 0,
    },
    takedown: {
      amount: BUSINESS_RULES.premiumTakedownFee,
      defaultOn: (typeof result.takedownAmount === 'number' ? result.takedownAmount : 0) > 0,
    },
  };
}

// Resolve the fee config + a toggle state (customer's, or the staff defaults)
// into the effective SelectionCharges priceSelection consumes: each fee adds
// its canonical amount only when its toggle is on.
export function effectiveCharges(
  charges: PortalCharges,
  rushOn: boolean,
  takedownOn: boolean,
): SelectionCharges {
  return {
    rushFee: rushOn ? charges.rush.amount : 0,
    takedown: takedownOn ? charges.takedown.amount : 0,
    taxRate: charges.taxRate,
  };
}

// Price a selection subtotal into the full tax-inclusive breakdown: add the
// per-job rush/takedown, then tax, then a 50% deposit. NO $1,000 floor — the
// minimum is enforced as a portal approval gate (see minimumOrderSubtotal), so
// prices always reflect exactly what's selected. An empty selection is
// all-zero (renders as "—"). This is THE single place selection pricing lives:
// packages A/B/C and the custom Build-Your-Own path both call it.
export function priceSelection(
  subtotal: number,
  charges: SelectionCharges,
): SelectionPrice {
  if (subtotal <= 0) {
    return { subtotal: 0, rushFee: 0, takedown: 0, taxable: 0, tax: 0, total: 0, deposit: 0 };
  }

  const taxable = subtotal + charges.rushFee + charges.takedown;
  const tax = round2(taxable * charges.taxRate);
  const total = round2(taxable + tax);
  const deposit = round2(total * BUSINESS_RULES.depositPercentage);
  return {
    subtotal,
    rushFee: charges.rushFee,
    takedown: charges.takedown,
    taxable,
    tax,
    total,
    deposit,
  };
}

// The pre-tax subtotal the customer's selection must reach before they can
// approve on the portal ($1,000) — OR 0 (waived) when the whole quote's items
// sum below the minimum, i.e. staff intentionally sent a sub-$1,000 quote and
// gating would make it un-approvable. (#18 — minimum is a gate, not a floor.)
export function minimumOrderSubtotal(lineItems: PortalLineItem[]): number {
  const sum = lineItems.reduce((s, li) => s + li.price, 0);
  return sum >= BUSINESS_RULES.minimumQuoteAmount ? BUSINESS_RULES.minimumQuoteAmount : 0;
}

function totalsFor(
  itemIds: string[],
  lineItems: PortalLineItem[],
  charges: SelectionCharges,
): { total: number; deposit: number } {
  const idSet = new Set(itemIds);
  const subtotal = lineItems.reduce(
    (sum, li) => (idSet.has(li.id) ? sum + li.price : sum),
    0,
  );
  return priceSelection(subtotal, charges);
}

export function derivePackages(
  lineItems: PortalLineItem[],
  result: QuoteResult,
): PortalPackage[] {
  const idsForTierA = lineItems
    .filter((li) => TIER_A_KINDS.has(li.kind))
    .map((li) => li.id);

  const idsForTierB = lineItems
    .filter((li) => TIER_A_KINDS.has(li.kind) || TIER_B_EXTRA.has(li.kind))
    .map((li) => li.id);

  const idsForTierC = lineItems
    .filter(
      (li) =>
        TIER_A_KINDS.has(li.kind) ||
        TIER_B_EXTRA.has(li.kind) ||
        TIER_C_EXTRA.has(li.kind),
    )
    .map((li) => li.id);

  // Package cards reflect the STAFF quote, so price them with the staff-default
  // rush/takedown toggle state. The live portal total (SelectionContext)
  // re-prices with the customer's toggles.
  const config = chargesFromResult(result);
  const charges = effectiveCharges(config, config.rush.defaultOn, config.takedown.defaultOn);
  const a = totalsFor(idsForTierA, lineItems, charges);
  const b = totalsFor(idsForTierB, lineItems, charges);
  const c = totalsFor(idsForTierC, lineItems, charges);

  // Tier C "à la carte" reference — what the bundle WOULD cost if the
  // customer bought everything individually. Currently same as the bundle
  // (no bundle discount applied yet). The portal renders "you save $X" only
  // when aLaCarteTotal > total, which happens once we wire bundle discounts.
  const tierCSubtotal = lineItems
    .filter((li) => idsForTierC.includes(li.id))
    .reduce((s, li) => s + li.price, 0);
  const aLaCarteTotal = tierCSubtotal > 0 ? tierCSubtotal : undefined;

  // "Recommended" goes on the middle tier IF it has items; otherwise on the
  // most-stocked tier so the page never has zero recommendations.
  const recommendedId: PackageId =
    b.total > 0 ? 'B' : c.total > 0 ? 'C' : a.total > 0 ? 'A' : 'D';

  return [
    {
      id: 'A',
      name: 'Classic Glow',
      tagline: 'Roofline only. Clean, simple, elegant.',
      total: a.total,
      deposit: a.deposit,
      includedItemIds: idsForTierA,
      recommended: recommendedId === 'A',
    },
    {
      id: 'B',
      name: 'Full Festive',
      tagline: 'Roofline + trees and bushes. Most popular.',
      total: b.total,
      deposit: b.deposit,
      includedItemIds: idsForTierB,
      recommended: recommendedId === 'B',
    },
    {
      id: 'C',
      name: 'The Full Yule',
      tagline: 'Everything — roofline, trees, bushes, wreaths, garland.',
      total: c.total,
      deposit: c.deposit,
      includedItemIds: idsForTierC,
      aLaCarteTotal,
      recommended: recommendedId === 'C',
    },
    {
      id: 'D',
      name: 'Build Your Own',
      tagline: 'Custom — toggle anything.',
      total: 0, // computed at runtime by SelectionContext from selected items
      deposit: 0,
      includedItemIds: [],
    },
  ];
}

// Pick a sensible initial package: 'B' if it has items, else the
// highest-tier package that actually has items. Avoids the portal landing
// the customer on an empty card on day one.
export function pickInitialPackageId(packages: PortalPackage[]): PackageId {
  const b = packages.find((p) => p.id === 'B');
  if (b && b.total > 0) return 'B';
  const c = packages.find((p) => p.id === 'C');
  if (c && c.total > 0) return 'C';
  const a = packages.find((p) => p.id === 'A');
  if (a && a.total > 0) return 'A';
  return 'D';
}
