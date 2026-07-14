// Permanent Bistro Lighting — pricing input/rate types (service_type =
// 'permanent_bistro', PENDING — not yet added to the ServiceType union).
//
// Permanent bistro is a LONG-TERM install: café string lights strung on
// permanent poles/supports (patios, courtyards) that stay up year-round,
// priced per linear foot of run plus a flat per-pole charge. This is NOT the
// event vertical's temporary bistro (src/lib/event/types.ts BistroLine /
// bistroPerFt) — that's a short-term wedding/party rental rate. Permanent
// bistro reuses the SAME BistroLine shape (one design projection produces one
// line shape for both verticals) so the projection + portal adapter stay
// uniform; do NOT duplicate the type.
//
// Isolated Phase-A module: imports only the shared BistroLine type — it
// touches NO shared dispatch seam. Wiring (adding 'permanent_bistro' to the
// ServiceType union, the /api/quote branch, the builder, the portal) is a
// later PR.

import type { BistroLine } from '@/lib/event/types';

/**
 * Permanent bistro rate table. Parameterized so the engine is rate-agnostic —
 * real numbers will live in Settings later (the #101 pattern);
 * DEFAULT_PERMANENT_BISTRO_RATES below are the starting values. `perFt` and
 * `perPole` must be positive finite numbers (the engine asserts this — the
 * $0 guardrail: a priced item can never silently bill $0 from a missing/zero
 * rate). `minimum` is DIFFERENT: it mirrors permanent's `minimumJobAmount` —
 * a portal approval GATE, not a price floor — so 0 (gate off) is a VALID value.
 */
export type PermanentBistroRates = {
  /** $/linear ft of strung permanent bistro run. */
  perFt: number;
  /** $ per permanent pole/support. */
  perPole: number;
  /** Portal approval gate (mirrors permanent.minimumJobAmount); 0 = gate OFF. */
  minimum: number;
  /** Annual maintenance add-on price (mirrors permanent.maintenancePrice); 0 = the add-on is hidden. Default 0. */
  maintenancePrice: number;
};

/** Default permanent bistro rates (Naldo, placeholder — real numbers TBD). */
export const DEFAULT_PERMANENT_BISTRO_RATES: PermanentBistroRates = {
  perFt: 30,
  perPole: 100,
  minimum: 0,
  maintenancePrice: 0,
};

/**
 * Permanent-bistro-only inputs — carried on `QuoteInputs.permanentBistro`
 * (present ONLY when the quote's service_type is 'permanent_bistro'),
 * mirroring `QuoteInputs.event`.
 */
export type PermanentBistroInputFields = {
  /** Permanent bistro runs (café string lights), priced per linear ft. */
  bistro?: BistroLine[];
  /** Count of permanent poles/supports ($perPole each). */
  poles?: number;
};

function positiveOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

// `minimum` allows 0 (the gate-off value) — only a negative/non-finite/missing
// value falls back to the default.
function nonNegativeOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * Coerce an unknown (a stored app_settings value) into a COMPLETE, valid
 * PermanentBistroRates — every field that fails its check falls back to
 * DEFAULT_PERMANENT_BISTRO_RATES. Always returns a full object (never
 * partial), mirroring sanitizeEventRates. `perFt`/`perPole` are
 * positive-or-default (they price real items and can never be 0); `minimum`
 * and `maintenancePrice` are non-negative-or-default (0 is a valid, preserved
 * value — the gate-off / hidden-add-on case), never silently promoted to a
 * positive default.
 */
export function sanitizePermanentBistroRates(v: unknown): PermanentBistroRates {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const D = DEFAULT_PERMANENT_BISTRO_RATES;
  return {
    perFt: positiveOr(o.perFt, D.perFt),
    perPole: positiveOr(o.perPole, D.perPole),
    minimum: nonNegativeOr(o.minimum, D.minimum),
    maintenancePrice: nonNegativeOr(o.maintenancePrice, D.maintenancePrice),
  };
}
