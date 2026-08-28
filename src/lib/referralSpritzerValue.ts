// Referral program: the friend's free-spritzer reward, translated into a
// dollar amount a homeowner can weigh at a glance. "2 free 16 inch
// spritzers" is trade jargon (a spritzer is a staked ground spotlight) with
// no context on its own, a review found it stated with no explanation
// anywhere on the friend-facing referral page. This derives the value from
// the SAME per-size rate the quote builder itself charges for a spritzer
// (BUSINESS_RULES.spritzerRates, src/lib/pricing/pricingEngine.ts), never a
// separate hardcoded number that could drift from the real price.
//
// Its own tiny module, not folded into src/lib/referrals.ts: referrals.ts
// already imports FROM src/lib/integrations/quoteMessages.ts (for the
// referral-earned notification copy), and quoteMessages.ts's own referral
// email needs this same value, so putting it in referrals.ts would create a
// circular import. This module only ever imports pricingEngine.ts, one
// direction, no cycle.

import { BUSINESS_RULES } from './pricing/pricingEngine';

/** `count` free spritzers at `sizeInches`, priced at the quote builder's own
 *  rate for that size. Returns 0 for a size with no rate on file (fail-open:
 *  a caller showing $0 is a smaller problem than a caller crashing). */
export function spritzerRetailValueUsd(count: number, sizeInches: number): number {
  const key = String(sizeInches) as keyof typeof BUSINESS_RULES.spritzerRates;
  const rate = BUSINESS_RULES.spritzerRates[key];
  return typeof rate === 'number' ? rate * count : 0;
}
