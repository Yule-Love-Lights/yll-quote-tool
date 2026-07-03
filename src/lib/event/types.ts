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
 * Default event rates (Naldo, S22). Real numbers — still Settings-adjustable
 * (app_settings.eventRates overrides this default; see EventRatesSettings).
 * Roofline is cheaper than the seasonal holiday rate (temporary install); minis
 * match Christmas; spritzers are event-specific; bistro is the temporary rate
 * (the long-term permanent-bistro rate is a separate future section, #112).
 */
export const DEFAULT_EVENT_RATES: EventRates = {
  roofline: { easy: 7, medium: 8, hard: 9 }, // Naldo (holiday: 8/10/12)
  mini: { canopy: 35, trunk: 45 }, // same as Christmas (Naldo)
  spritzer: { '16': 65, '24': 75, '32': 85 }, // Naldo (holiday: 85/95/105)
  bistroPerFt: 12, // Naldo: $12/ft temporary bistro
  barrelBoxPrice: 150, // Naldo: $150 per support (may change)
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

function positiveOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Coerce an unknown (a stored app_settings value) into a COMPLETE, valid
 * EventRates — every field that isn't a positive finite number falls back to
 * DEFAULT_EVENT_RATES. Always returns a full object (never partial), so a
 * Settings-sourced rate table can never trip the engine's $0 guardrail. Used by
 * appSettings (read-merge + write-sanitize) so staff can adjust event rates
 * without a deploy (the #101 pattern).
 */
export function sanitizeEventRates(v: unknown): EventRates {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const roofline = (o.roofline && typeof o.roofline === 'object' ? o.roofline : {}) as Record<string, unknown>;
  const mini = (o.mini && typeof o.mini === 'object' ? o.mini : {}) as Record<string, unknown>;
  const spritzer = (o.spritzer && typeof o.spritzer === 'object' ? o.spritzer : {}) as Record<string, unknown>;
  const D = DEFAULT_EVENT_RATES;
  return {
    roofline: {
      easy: positiveOr(roofline.easy, D.roofline.easy),
      medium: positiveOr(roofline.medium, D.roofline.medium),
      hard: positiveOr(roofline.hard, D.roofline.hard),
    },
    mini: {
      canopy: positiveOr(mini.canopy, D.mini.canopy),
      trunk: positiveOr(mini.trunk, D.mini.trunk),
    },
    spritzer: {
      '16': positiveOr(spritzer['16'], D.spritzer['16']),
      '24': positiveOr(spritzer['24'], D.spritzer['24']),
      '32': positiveOr(spritzer['32'], D.spritzer['32']),
    },
    bistroPerFt: positiveOr(o.bistroPerFt, D.bistroPerFt),
    barrelBoxPrice: positiveOr(o.barrelBoxPrice, D.barrelBoxPrice),
  };
}
