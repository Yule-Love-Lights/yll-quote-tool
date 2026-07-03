// Permanent Lighting vertical (ledger #88) — shared input types.
//
// Pure type module with NO imports so both the pricing engine (which adds
// `permanent?: PermanentQuoteFields` to QuoteInputs) and the permanent modules
// import it without a cycle.
//
// Domain (locked with Naldo 2026-07-02 — see the approved plan): Omni/Ascend RGB
// puck-on-track roofline systems. Roofline only — front + left + right + back;
// gutter lines + peaks; no ridge, no accessories.

/** Track mounting style: soffit → single track, fascia → parapet track. */
export type TrackStyle = 'single' | 'parapet';

/** Stock powder-coat color codes: white / black / cream / dark brown. */
export type TrackColor = '9003' | '9004' | '9012' | '8019';

/**
 * A jump between runs (the supplier estimator's extension rows): controller →
 * first run and run → run gaps. BOM-only — retail pricing ignores gaps.
 * FRONT gaps are auto-detected from the design geometry and pre-fill these rows;
 * every row is operator-editable, and the detected-vs-final delta is captured as
 * a training signal (see the plan's Deferred section).
 */
export type PermanentGap = {
  /** The value used for the BOM (the operator's final number). */
  lengthFt: number;
  /** The line branches two directions here → needs a data splitter. */
  splitter?: boolean;
  /** What the design auto-detected (front only); undefined for manual rows. */
  detectedFt?: number;
  /** Training signal: 'edited' = operator corrected the auto value. */
  source?: 'auto' | 'edited' | 'manual';
};

/**
 * The permanent block on QuoteInputs (present only when the quote's service_type
 * is 'permanent'). Footage/corners are per side — left + right stay SEPARATE
 * (measured separately off satellite) and sum into the "Sides" line/package.
 */
export type PermanentQuoteFields = {
  /** Auto-filled from the design (the only designable side); manual override allowed. */
  frontFootage: number;
  /** Satellite-measured or manual. */
  leftFootage: number;
  rightFootage: number;
  backFootage: number;
  /** Jumps between runs — BOM-only (extensions / boosters / splitters). */
  gaps: PermanentGap[];
  /** Controller → first light distance; >10 ft needs a signal booster (BOM-only). */
  controllerToFirstLightFt: number;
  /**
   * Ends/corners/transitions per side — each consumes 3 SINGLE lights (Omni
   * rule; a gable peak counts 3: both base transitions + the apex). Front is
   * auto-counted from the design's polyline vertices and stays adjustable.
   */
  frontCorners: number;
  leftCorners: number;
  rightCorners: number;
  backCorners: number;
  trackStyle: TrackStyle;
  /** Default '9003' (white). */
  trackColor: TrackColor;
  /** Puck housing: false = standard, true = the -BLK SKUs (same price). */
  blackHousing: boolean;
  /** Optional maintenance add-on line; hidden while rates.maintenancePrice is 0. */
  maintenanceAddOn: boolean;
  /** Per-quote $/ft overrides (#102 pattern): a positive finite number wins, else the rate table. */
  frontCustomRate?: number;
  /** Applies to left + right combined. */
  sidesCustomRate?: number;
  backCustomRate?: number;
};

/**
 * The adjustable permanent rate table (app_settings-backed in P3; defaults
 * below). FROZEN into QuoteResult.permanentRatesSnapshot at calc time so
 * approve/amend re-prices can never drift when Settings change.
 */
export type PermanentRates = {
  /** $/ft for the front. Default 40. */
  frontPerFt: number;
  /** $/ft for left + right. Default 35. */
  sidesPerFt: number;
  /** $/ft for the back. Default 35. */
  backPerFt: number;
  /** Portal APPROVAL GATE (not a price floor). Default 2500. */
  minimumJobAmount: number;
  /** Annual maintenance add-on price; 0 = the add-on is hidden. Default 0. */
  maintenancePrice: number;
};

/** Canonical default rates (Naldo 2026-07-02). Overridden by app_settings in P3. */
export const DEFAULT_PERMANENT_RATES: PermanentRates = {
  frontPerFt: 40,
  sidesPerFt: 35,
  backPerFt: 35,
  minimumJobAmount: 2500,
  maintenancePrice: 0,
};

/**
 * A blank permanent block for a fresh/hydrating quote form. A FACTORY (not a
 * shared const) so each form gets its own `gaps` array — no cross-form mutation.
 */
export function makeDefaultPermanentFields(): PermanentQuoteFields {
  return {
    frontFootage: 0,
    leftFootage: 0,
    rightFootage: 0,
    backFootage: 0,
    gaps: [],
    controllerToFirstLightFt: 0,
    frontCorners: 0,
    leftCorners: 0,
    rightCorners: 0,
    backCorners: 0,
    trackStyle: 'single',
    trackColor: '9003',
    blackHousing: false,
    maintenanceAddOn: false,
  };
}
