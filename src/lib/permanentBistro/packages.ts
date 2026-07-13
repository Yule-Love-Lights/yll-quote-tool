// Auto-derive portal packages for a PERMANENT BISTRO quote. Live: dispatched
// from the portal adapter.
//
// Permanent bistro doesn't use the holiday A/B/C/D tier ladder or permanent's
// per-surface packages (front/sides/back) — it follows event's model instead:
// ONE "what's included" package — every line on the quote, bundled — with the
// customer toggling individual items on the portal. Reuses the shared money
// plumbing (chargesFromResult + effectiveCharges + priceSelection) so
// tax/deposit math is identical to holiday/event/permanent; permanent bistro
// never carries a rush fee or takedown (a permanent install goes up once).
//
// WT-64: the optional maintenance add-on ('permanent-bistro-maintenance') is
// EXCLUDED from the bundle — same treatment as permanent's derivePackagesPermanent
// (MAINTENANCE_ID never in an includedItemIds set). It's an opt-in extra, so it
// must start deselected and require the customer to affirmatively toggle it on
// via its own line-item control, not ride along bundled into the one package.

import { chargesFromResult, effectiveCharges, priceSelection } from '@/lib/portal/derivePackages';
import type { PortalLineItem, PortalPackage } from '@/components/portal/types';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';

const MAINTENANCE_ID = 'permanent-bistro-maintenance';

/**
 * The single permanent-bistro package: everything on the quote EXCEPT the
 * opt-in maintenance add-on, bundled into one card. The customer picks the
 * specific pieces (including maintenance) via the portal's per-item toggles
 * (mirrors derivePackagesEvent / derivePackagesPermanent).
 */
export function derivePackagesPermanentBistro(
  lineItems: PortalLineItem[],
  result: QuoteResult,
): PortalPackage[] {
  if (lineItems.length === 0) return [];
  const bundledItems = lineItems.filter((li) => li.id !== MAINTENANCE_ID);
  // A quote whose only billable line is the maintenance add-on offers no
  // package (mirrors permanent's Whole Home guard) — the add-on is still
  // toggleable via its own WhatsIncluded row regardless.
  if (bundledItems.length === 0) return [];
  // Permanent bistro never carries rush/takedown — force both off (same as
  // event/permanent). Same tax source (chargesFromResult) so the money math
  // stays identical to holiday.
  const charges = effectiveCharges(chargesFromResult(result), false, false);
  const subtotal = bundledItems.reduce((sum, li) => sum + li.price, 0);
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
      includedItemIds: bundledItems.map((li) => li.id),
    },
  ];
}
