// Auto-derive portal packages for a PERMANENT BISTRO quote (PENDING wiring).
//
// Permanent bistro doesn't use the holiday A/B/C/D tier ladder or permanent's
// per-surface packages (front/sides/back) — it follows event's model instead:
// ONE "what's included" package — every line on the quote, bundled — with the
// customer toggling individual items on the portal. Reuses the shared money
// plumbing (chargesFromResult + effectiveCharges + priceSelection) so
// tax/deposit math is identical to holiday/event/permanent; permanent bistro
// never carries a rush fee or takedown (a permanent install goes up once).

import { chargesFromResult, effectiveCharges, priceSelection } from '@/lib/portal/derivePackages';
import type { PortalLineItem, PortalPackage } from '@/components/portal/types';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';

/**
 * The single permanent-bistro package: everything on the quote bundled into
 * one card. The customer picks the specific pieces via the portal's per-item
 * toggles (mirrors derivePackagesEvent).
 */
export function derivePackagesPermanentBistro(
  lineItems: PortalLineItem[],
  result: QuoteResult,
): PortalPackage[] {
  if (lineItems.length === 0) return [];
  // Permanent bistro never carries rush/takedown — force both off (same as
  // event/permanent). Same tax source (chargesFromResult) so the money math
  // stays identical to holiday.
  const charges = effectiveCharges(chargesFromResult(result), false, false);
  const subtotal = lineItems.reduce((sum, li) => sum + li.price, 0);
  const p = priceSelection(subtotal, charges);
  return [
    {
      id: 'D',
      // If this ever surfaces under a "What's Included" heading that prepends
      // "Your " (mirrors event's #119 note), the name must NOT itself lead
      // with "Your".
      name: 'Bistro Lighting',
      total: p.total,
      deposit: p.deposit,
      recommended: true,
      includedItemIds: lineItems.map((li) => li.id),
    },
  ];
}
