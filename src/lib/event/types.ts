// Event Lighting — pricing input/rate types (service_type = 'event').
//
// Event lighting is a TEMPORARY install (weddings/parties): C9 rooflines, mini
// wraps, spritzers, curtain lights, and TEMPORARY bistro — NO accessories
// (garland/wreath/bow). It reuses the same per-item shapes the holiday engine
// uses (imported from pricingEngine) so the design projection + portal adapter
// stay uniform, plus two event-only extras (bistro + barrel/box supports).
//
// Isolated Phase-A module: imports only EXPORTED symbols from the pricing engine
// — it touches NO shared dispatch seam. Wiring (service_type branch at /api/quote,
// the builder, the portal) is Phase B, added after the Permanent build converts
// those seams. See ~/.claude/plans/sorry-this-is-plan-crystalline-clarke.md.

import type { QuoteInputs, RooflineDifficulty } from '@/lib/pricing/pricingEngine';

/**
 * Event rate table — INDEPENDENT of the holiday BUSINESS_RULES rates (event
 * installs are short-term, so the price points are lower). Parameterized so the
 * engine is rate-agnostic: the real numbers live in Settings (app_settings,
 * the #101 pattern) and slot in later; DEFAULT_EVENT_RATES below are PLACEHOLDERS
 * until Naldo provides them. Every rate MUST be a positive finite number — the
 * engine asserts this (the "$0 guardrail": a priced item can never silently bill
 * $0 from a missing/zero rate, the failure mode that leaves bistro unpriced today).
 */
export type EventRates = {
  /** C9 roofline $/ft by difficulty (santas / gingerbread / winter-wonderland). */
  roofline: Record<RooflineDifficulty, number>;
  /** Mini-light $/string. `canopy` also prices column/railing/curtain (no wrap style). */
  mini: { canopy: number; trunk: number };
  /** Spritzer $ each, by size. */
  spritzer: Record<'16' | '24' | '32', number>;
  /** Temporary bistro $/linear ft of strung run. */
  bistroPerFt: number;
  /** Barrel/box temporary support — flat $ per unit (holds bistro/poles up). */
  barrelBoxPrice: number;
};

/**
 * PLACEHOLDER event rates — clearly lower than the seasonal holiday rates to
 * reflect a ~1-4 week rental. Naldo supplies the real numbers (they live in
 * Settings; this default is only a fallback so tests + a dev build run).
 */
export const DEFAULT_EVENT_RATES: EventRates = {
  roofline: { easy: 5, medium: 6, hard: 7 }, // placeholder (holiday: 8/10/12)
  mini: { canopy: 25, trunk: 30 }, // placeholder (holiday: 35/45)
  spritzer: { '16': 50, '24': 55, '32': 60 }, // placeholder (holiday: 85/95/105)
  bistroPerFt: 10, // Naldo: ~$10/ft temporary bistro
  barrelBoxPrice: 150, // Naldo: $150 barrel/box support (may change)
};

/**
 * One temporary bistro run — priced per linear foot. Optional stable id + scene
 * links (mirrors the holiday per-unit LineIdentity) so a bistro line can be
 * identified by identity when the design projection wires it up (Phase B).
 */
export type BistroLine = {
  id?: string;
  sceneItemIds?: string[];
  footage: number;
};

/**
 * Event quote inputs = the holiday QuoteInputs shape (events reuse C9 roofline /
 * mini / spritzer / curtain items) PLUS event-only extras. Accessories
 * (wreaths/garland/bows) may be present on the object but are IGNORED by
 * calculateEventQuote (allow-list, not deny-list). rush/takedown/early-install
 * are also ignored (events have no such fees).
 */
export type EventQuoteInputs = QuoteInputs & {
  /** Temporary bistro runs (café string lights). */
  bistro?: BistroLine[];
  /** Count of barrel/box temporary supports ($150 each). */
  barrelBoxes?: number;
};
