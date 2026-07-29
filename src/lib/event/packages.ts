// Auto-derive portal packages for an EVENT quote (#96 Phase B).
//
// Events don't use the holiday A/B/C/D tier ladder (or permanent's per-side
// packages). Naldo's model: ONE "what's included" package — every line on the
// quote, bundled — with the customer toggling individual items on the portal.
// derivePackagesEvent returns that single PortalPackage[] so it slots into the
// portal adapter's package dispatch and reuses the holiday portal (same as
// permanent). It reuses the shared money plumbing (chargesFromResult +
// effectiveCharges + priceSelection) so tax/deposit math is identical; events
// never carry a rush fee or takedown.
//
// eventSuggestions() is the light "a couple soft add-ons" logic (Naldo's package
// answer) — a pure fn kept for the future event-portal suggestions UI.

import { chargesFromResult, effectiveCharges, priceSelection } from '@/lib/portal/derivePackages';
import type { PortalLineItem, PortalPackage } from '@/components/portal/types';
import type { LineItem, QuoteResult } from '@/lib/pricing/pricingEngine';

/**
 * The single event package: everything on the quote bundled into one card. The
 * customer picks the specific pieces via the portal's per-item toggles.
 */
export function derivePackagesEvent(
  lineItems: PortalLineItem[],
  result: QuoteResult,
): PortalPackage[] {
  if (lineItems.length === 0) return [];
  // The adapter surfaces BOTH mutually-exclusive roofline options as toggleable
  // line items: Santa's (front only) and Gingerbread (front + ridge + sides).
  // Gingerbread already contains the front footage, so bundling Santa's too
  // double-bills the front (and that inflated total freezes into the approval
  // snapshot + Valor deposit). Drop Santa's when Gingerbread is present (mirrors
  // derivePackages' `excludeRooflineId`) from BOTH the id list and the subtotal.
  const excludeRooflineId = lineItems.some((li) => li.id === 'roofline-gingerbread')
    ? 'roofline-santas'
    : null;
  const included = lineItems.filter((li) => li.id !== excludeRooflineId);
  // Events never carry rush/takedown — force both off (same as permanent). Same
  // tax source (chargesFromResult) so the money math stays identical to holiday.
  const charges = effectiveCharges(chargesFromResult(result), false, false);
  const subtotal = included.reduce((sum, li) => sum + li.price, 0);
  const p = priceSelection(subtotal, charges);
  return [
    {
      id: 'D',
      // #184 — the What's Included heading no longer prepends "Your " (it
      // renders the bare name), so this name is free to read naturally either
      // way; kept plain regardless.
      name: 'Event Lighting',
      tagline: "Everything we'll light for your event.",
      total: p.total,
      deposit: p.deposit,
      recommended: true,
      includedItemIds: included.map((li) => li.id),
    },
  ];
}

// ── Soft add-on suggestions (deferred portal UI) ────────────────────────────

export type EventAddOnKey = 'roofline' | 'curtain' | 'spritzers' | 'bushWraps' | 'bistro';

export type EventSuggestion = {
  key: EventAddOnKey;
  /** Short customer-facing name (draft — leads with the feeling, not the trade term). */
  label: string;
  /** One-line "why you'd want it" (draft). */
  blurb: string;
};

// Draft suggestion copy — leads with the feeling (council/Outsider). Naldo
// approves final wording when the suggestions UI is built.
const SUGGESTION_CATALOG: Record<EventAddOnKey, EventSuggestion> = {
  roofline: {
    key: 'roofline',
    label: 'Warm rooflines',
    blurb: 'Warm bulbs outlining the roof so guests feel it the moment they arrive.',
  },
  curtain: {
    key: 'curtain',
    label: 'Curtain lights',
    blurb: 'A glowing curtain of light draping down the front of the house.',
  },
  spritzers: {
    key: 'spritzers',
    label: 'Spritzers',
    blurb: 'Bursts of light in the beds and along the walkway — an easy, high-impact add.',
  },
  bushWraps: {
    key: 'bushWraps',
    label: 'Wrapped bushes & trees',
    blurb: 'Soft-wrapped greenery framing the entrance and the aisle.',
  },
  bistro: {
    key: 'bistro',
    label: 'Bistro lights',
    blurb: 'Café string lights strung overhead for the reception.',
  },
};

/** At most this many suggestions surface ("a couple"). */
export const MAX_EVENT_SUGGESTIONS = 3;

function hasRoofline(lines: LineItem[]): boolean {
  return lines.some((l) => l.id === 'roofline-santas' || l.id === 'roofline-gingerbread');
}
function hasCurtain(lines: LineItem[]): boolean {
  return lines.some((l) => /curtain/i.test(l.label));
}
function hasSpritzers(lines: LineItem[]): boolean {
  return lines.some((l) => /spritzer/i.test(l.label));
}
function hasBushWraps(lines: LineItem[]): boolean {
  return lines.some((l) => /\b(bush|tree)\b/i.test(l.label));
}
function hasBistro(lines: LineItem[]): boolean {
  return lines.some((l) => /bistro/i.test(l.label));
}

function isPresent(key: EventAddOnKey, lines: LineItem[]): boolean {
  switch (key) {
    case 'roofline':
      return hasRoofline(lines);
    case 'curtain':
      return hasCurtain(lines);
    case 'spritzers':
      return hasSpritzers(lines);
    case 'bushWraps':
      return hasBushWraps(lines);
    case 'bistro':
      return hasBistro(lines);
  }
}

/**
 * A short, context-aware list of popular event add-ons NOT already on the quote.
 * A backyard bistro with no front roofline leads with the roofline (the arrival
 * "wow"); otherwise the easy adds in order. Capped at a few. Pure + deterministic.
 */
export function eventSuggestions(result: Pick<QuoteResult, 'lineItems'>): EventSuggestion[] {
  const lines = result.lineItems;
  const order: EventAddOnKey[] = [];
  if (hasBistro(lines) && !hasRoofline(lines)) order.push('roofline');
  for (const key of ['curtain', 'spritzers', 'bushWraps', 'roofline', 'bistro'] as EventAddOnKey[]) {
    if (!order.includes(key)) order.push(key);
  }
  return order
    .filter((key) => !isPresent(key, lines))
    .slice(0, MAX_EVENT_SUGGESTIONS)
    .map((key) => SUGGESTION_CATALOG[key]);
}
