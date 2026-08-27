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

/** The four house sides a permanent job bills/orders per (#192). */
export type PermanentSide = 'front' | 'left' | 'right' | 'back';

/** Canonical side order every scoped-BOM surface lists in (#192 review fix). */
export const ALL_PERMANENT_SIDES: readonly PermanentSide[] = ['front', 'left', 'right', 'back'];

/** Shared display labels for PermanentSide — every "Booked scope: …" surface uses these (#192 review fix). */
export const PERMANENT_SIDE_LABEL: Record<PermanentSide, string> = {
  front: 'Front',
  left: 'Left side',
  right: 'Right side',
  back: 'Back',
};

/**
 * #192 review fix — order the raw included-sides Set into the canonical
 * front/left/right/back display-label array every scoped-BOM surface
 * renders. Returns null unchanged (unscoped) so callers can gate a note on
 * `!= null` without re-deriving the empty-vs-null distinction themselves.
 */
export function permanentScopedSideLabels(includedSides: ReadonlySet<PermanentSide> | null): string[] | null {
  if (includedSides == null) return null;
  return ALL_PERMANENT_SIDES.filter((s) => includedSides.has(s)).map((s) => PERMANENT_SIDE_LABEL[s]);
}

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
  /**
   * #192 — per-side track style override. Only shown/written for sides with
   * footage > 0. The single global select is retired from the UI; this map is
   * the only thing new saves write. `trackStyle` (the legacy scalar) is kept
   * FOREVER as the fallback for any side absent from this map — a pre-#192
   * stored quote (scalar-only, this map absent/empty) resolves identically to
   * today on every surface. Never read directly; always resolve through
   * `effectiveSideTrackStyle`.
   */
  trackStyleBySide?: Partial<Record<PermanentSide, TrackStyle>>;
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
  /**
   * Staff "advised for this home" flags per side (#131 — the WW/Stake #12
   * pattern: rides the inputs, saves on Calculate). The portal opens with the
   * recommended sides pre-selected instead of the Whole Home default.
   */
  frontRecommended?: boolean;
  leftRecommended?: boolean;
  rightRecommended?: boolean;
  backRecommended?: boolean;
  /**
   * #140 — the Extensions/Splitters card counts (BOM accessories). Once
   * `accessoriesSource` is set these are THE ordered quantities (they override
   * the legacy gaps-derived path in the BOM engine); geometry/AI seed them and
   * an operator-typed value wins. ALL of these stay undefined on a fresh form
   * (makeDefaultPermanentFields) — presence is keyed on `accessoriesSource`,
   * never on the objects existing, so a legacy stored quote with only `gaps`
   * keeps its old BOM path untouched.
   */
  extensions?: { e3: number; e5: number; e10: number; e25: number };
  splittersNeeded?: number;
  /** Extra signal boosters for long jumps (>50 ft), beyond the controller>10ft rule. */
  jumpBoosters?: number;
  /**
   * 'auto' = last written by the geometry/AI derive (a re-derive may refresh);
   * 'manual' = the operator typed a count (derives never overwrite; the card's
   * "Recount" button resets to 'auto'). Absent = the card was never written →
   * legacy gaps path.
   */
  accessoriesSource?: 'auto' | 'manual';
  /**
   * Row 400: per-FIELD provenance for the 8 footage/corners values (footage
   * and corners reconcile independently — see reconcileSideFootage.ts — so a
   * side-level flag would lie the moment one field on a side is overridden
   * and the other isn't). 'auto' = the reconcile derive effect
   * (QuoteBuilder.tsx) actually stamped this field this run; 'manual' = the
   * operator typed it (PermanentSection's setMeasure). Absent = never
   * written by either path (a legacy quote, or a field with no satellite
   * scale yet). Keyed by the SAME 8 strings as
   * reconcileSideFootage.ts's PermanentSideFieldKey (not imported — this
   * file stays import-free by design, see the header comment).
   *
   * This replaces the deleted `sideSource` field (row 380): that one could
   * only ever read 'manual' (its 'auto' writer, applyPermanentAnalysis, was
   * removed in the S22 revert), so surfacing it would have shown a false
   * "manually set" badge on every untouched auto-derived side. This field
   * has a REAL 'auto' writer (the derive effect itself), so the badge it
   * drives can't lie the way the deleted one would have.
   */
  sideMeasureSource?: Partial<Record<
    | 'frontFootage' | 'frontCorners'
    | 'leftFootage' | 'leftCorners'
    | 'rightFootage' | 'rightCorners'
    | 'backFootage' | 'backCorners',
    'auto' | 'manual'
  >>;
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
 * Permanent Lighting "Your Protection" card copy (#88 P6b-2). Settings-editable
 * so staff can reword the guarantees/warranty without a deploy, and VERSIONED so
 * an approved permanent quote can freeze the exact terms + version the customer
 * agreed to (a later edit can never retro-change a booked customer's agreement).
 * `bullets` is a fixed-slot list (each paired with a fixed icon in the portal
 * component by index); a blank slot is hidden. `version` is server-managed —
 * putAppSettings bumps it whenever the displayed copy changes; clients never set it.
 * Lives here (with zero imports) so both the server appSettings and the client
 * settings cache / portal component share ONE source without a server-bundle leak.
 */
export type PermanentWarranty = {
  eyebrow: string;
  heading: string;
  bullets: string[];
  version: number;
};

/**
 * The factory "Your Protection" copy — byte-identical to what RiskReversalPermanent
 * hard-coded before this became Settings-editable, so an unconfigured business sees
 * the exact same card. Bullet order is paired with the fixed icons in that component
 * (Infinity / Smartphone / EyeOff / Home / Palette / ShieldCheck). Starts at version 1.
 */
export const DEFAULT_PERMANENT_WARRANTY: PermanentWarranty = {
  eyebrow: 'Your Protection',
  heading: 'Built to last a lifetime.',
  bullets: [
    'Lifetime materials warranty — we replace any failed puck, track, or controller free, for as long as you own and live in your home. (Service labor billed separately.)',
    'Control it from your phone — millions of colors, scenes, and schedules, year-round, in the app.',
    'Invisible by day — a low-profile track color-matched to your trim. You only see it when it’s on.',
    'Zero roof damage — mounted in aluminum track under the eave, never nailed through your shingles.',
    'Everyday and every holiday — warm white for nightly curb appeal and security, any color for the seasons.',
    '$2M liability insurance — licensed and bonded, installed by our own crew.',
  ],
  version: 1,
};

/**
 * #139 (Jason S24): permanent footage bills in 5-ft steps — any measured or
 * hand-typed per-side footage rounds UP to the next multiple of 5 (37→40,
 * 22→25; exact multiples stay). Applied at the ENTRY points (the satellite
 * derive + the builder inputs on blur), never inside the pricing engine, so
 * the number the operator sees is exactly the number that bills.
 */
export function roundFootageUpTo5(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n / 5) * 5;
}

/**
 * #192 — resolve the track style a given side actually orders: the per-side
 * override if set, else the legacy scalar `trackStyle`. The ONE place either
 * field is read; every consumer (BOM engine bridge, UI) goes through this.
 */
export function effectiveSideTrackStyle(p: PermanentQuoteFields, side: PermanentSide): TrackStyle {
  return p.trackStyleBySide?.[side] ?? p.trackStyle;
}

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
    trackStyleBySide: {},
  };
}
