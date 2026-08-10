// Auto-derive portal packages for a PERMANENT BISTRO quote.
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
  // #199 F1: threaded straight to chargesFromResult — see its own comment
  // (derivePackages.ts) for why the live inputs.depositPercent must win over
  // a possibly-stale result.depositRate.
  depositPercent?: number,
): PortalPackage[] {
  if (lineItems.length === 0) return [];
  // Permanent bistro never carries rush/takedown — force both off (same as
  // event/permanent). Same tax source (chargesFromResult) so the money math
  // stays identical to holiday.
  const charges = effectiveCharges(chargesFromResult(result, depositPercent), false, false);
  const subtotal = lineItems.reduce((sum, li) => sum + li.price, 0);
  const p = priceSelection(subtotal, charges);
  return [
    {
      id: 'D',
      // #184 — the What's Included heading no longer prepends "Your " (it
      // renders the bare name), so this name is free to read naturally either
      // way; kept plain regardless.
      name: 'Bistro Lighting',
      tagline: "Everything we'll light for your space.",
      total: p.total,
      deposit: p.deposit,
      recommended: true,
      includedItemIds: lineItems.map((li) => li.id),
    },
  ];
}
