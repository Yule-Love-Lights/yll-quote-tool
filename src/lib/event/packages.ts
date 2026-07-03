// Event Lighting — portal package derivation (service_type = 'event').
//
// Events don't use the holiday A/B/C/D tier ladder. Naldo's model: ONE
// "what's included" set (every line on the quote, toggleable on the portal)
// plus a couple soft SUGGESTIONS — popular event add-ons NOT already on the
// quote that the customer can ask us to add. This is the light, always-a-
// suggestion-never-auto-add version of the deferred recommendation engine.
//
// Isolated Phase-A module: pure fn of the event line items. Consumed by the
// event portal (Phase B). Suggestion COPY is placeholder/draft — Naldo approves
// the customer-facing wording before the portal ships.

import type { LineItem, QuoteResult } from '@/lib/pricing/pricingEngine';

export type EventAddOnKey = 'roofline' | 'curtain' | 'spritzers' | 'bushWraps' | 'bistro';

export type EventSuggestion = {
  key: EventAddOnKey;
  /** Short customer-facing name (draft — leads with the feeling, not the trade term). */
  label: string;
  /** One-line "why you'd want it" (draft). */
  blurb: string;
};

export type EventPackage = {
  /** The single package — every line on the quote, included by default and
   *  toggleable on the portal (customers pick the specific pieces they want). */
  includedItems: LineItem[];
  /** A few "add if you'd like" prompts for popular add-ons not already present. */
  suggestions: EventSuggestion[];
};

// Draft suggestion copy — leads with the feeling (Outsider/council note: a bride
// doesn't know "C9"/"spritzer"). Naldo approves final wording in Phase B.
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
  return lines.some(l => l.id === 'roofline-santas' || l.id === 'roofline-gingerbread');
}
function hasCurtain(lines: LineItem[]): boolean {
  return lines.some(l => /curtain/i.test(l.label));
}
function hasSpritzers(lines: LineItem[]): boolean {
  return lines.some(l => /spritzer/i.test(l.label));
}
// "Wrapped greenery" = bush/tree mini wraps (columns/railings are structural, not
// what this suggestion is about; curtain is its own category via 'Curtain Lights').
function hasBushWraps(lines: LineItem[]): boolean {
  return lines.some(l => /\b(bush|tree)\b/i.test(l.label));
}
function hasBistro(lines: LineItem[]): boolean {
  return lines.some(l => /bistro/i.test(l.label));
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
 * Derive the event portal package: the single included set + a short, ordered
 * list of suggested add-ons that aren't already on the quote. Pure + deterministic.
 */
export function derivePackagesEvent(result: Pick<QuoteResult, 'lineItems'>): EventPackage {
  const lines = result.lineItems;

  // Suggestion priority: a backyard bistro with no front roofline leads with the
  // roofline (the arrival "wow" Naldo described); otherwise the easy, popular adds
  // in order. Only categories NOT already on the quote are offered, capped at a few.
  const order: EventAddOnKey[] = [];
  if (hasBistro(lines) && !hasRoofline(lines)) order.push('roofline');
  for (const key of ['curtain', 'spritzers', 'bushWraps', 'roofline', 'bistro'] as EventAddOnKey[]) {
    if (!order.includes(key)) order.push(key);
  }

  const suggestions = order
    .filter(key => !isPresent(key, lines))
    .slice(0, MAX_EVENT_SUGGESTIONS)
    .map(key => SUGGESTION_CATALOG[key]);

  return { includedItems: lines, suggestions };
}
