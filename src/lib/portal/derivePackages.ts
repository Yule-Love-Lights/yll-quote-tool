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
// Minimum-quote rule applies per-package: if a package's items sum to
// less than $1,000 (BUSINESS_RULES.minimumQuoteAmount), we round up.
// Empty packages (no items in this quote that match the bucket) get
// total: 0 so they render as "—" and can't be selected.

import { BUSINESS_RULES } from '@/lib/pricing/pricingEngine';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';
import type {
  PackageId,
  PortalLineItem,
  PortalLineItemKind,
  PortalPackage,
} from '@/components/portal/types';

// Which kinds belong to which tier. Tiers stack — B includes A's kinds, etc.
const TIER_A_KINDS: ReadonlySet<PortalLineItemKind> = new Set(['roofline', 'ridge']);
const TIER_B_EXTRA: ReadonlySet<PortalLineItemKind> = new Set(['tree', 'bush', 'column']);
const TIER_C_EXTRA: ReadonlySet<PortalLineItemKind> = new Set(['wreath', 'garland', 'spritzer']);

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

function totalsFor(
  itemIds: string[],
  lineItems: PortalLineItem[],
  result: QuoteResult,
): { total: number; deposit: number } {
  const idSet = new Set(itemIds);
  const subtotal = lineItems.reduce(
    (sum, li) => (idSet.has(li.id) ? sum + li.price : sum),
    0,
  );

  // Empty package — render as "—", not as a $1,000 minimum-charge surprise.
  if (subtotal <= 0) return { total: 0, deposit: 0 };

  const subtotalAfterMin =
    subtotal < BUSINESS_RULES.minimumQuoteAmount
      ? BUSINESS_RULES.minimumQuoteAmount
      : subtotal;

  // Rush + takedown are per-job, not per-package — the customer pays them
  // whether they pick A or C. Pull from the original quote's result so we
  // honor whatever the admin set at quote-creation time. Defensive null-
  // coercion in case an older row is missing these fields.
  const rushFee = typeof result.rushFeeAmount === 'number' ? result.rushFeeAmount : 0;
  const takedown = typeof result.takedownAmount === 'number' ? result.takedownAmount : 0;
  const taxable = subtotalAfterMin + rushFee + takedown;
  const tax = round2(taxable * effectiveTaxRate(result));
  const total = round2(taxable + tax);
  const deposit = round2(total * BUSINESS_RULES.depositPercentage);
  return { total, deposit };
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

  const a = totalsFor(idsForTierA, lineItems, result);
  const b = totalsFor(idsForTierB, lineItems, result);
  const c = totalsFor(idsForTierC, lineItems, result);

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
