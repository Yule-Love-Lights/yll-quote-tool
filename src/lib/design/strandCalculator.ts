// Strand/garland footage calculator — the company's five real estimating
// models, transcribed from Naldo's own estimating spreadsheet (2026-08-27).
// Every formula and constant below (the perspective-free geometry, the 0.45 /
// 0.38 / 0.3 spruce-wrap factors, the 0.8 / 0.6666 / 0.5 bulb-spacing factors,
// the 25ft / 17ft strand coverage, the 9ft garland stick length) came from
// that sheet. None of it is invented or approximated.
//
// This module is PURE MATH ONLY — no I/O, no React, no Supabase. It is NOT
// wired into any UI, the pricing engine, the quote builder, or the analyzer
// in this PR; that is deliberate and left to a later PR. See
// `src/app/training/new/page.tsx`'s local `recalcStrings` (~line 704) for the
// ONE model (round canopy) that today's product actually uses, applied to
// every shape — the bug this module exists to fix.
//
// Degenerate-input convention (matches `yardstickPpf.ts`'s null-on-degenerate
// idiom): every function returns `number | null`, never `NaN` or `Infinity`.
// `null` means "cannot compute" — a non-finite input, a negative dimension
// (physically invalid), a spacing of zero or less (division by zero), an
// unsupported discrete spacing, or a result that overflows to a non-finite
// number. A genuine ZERO dimension (e.g. a 0in-tall bush) is NOT degenerate —
// it produces a real `0` footage, distinct from `null`. Rounding happens
// exactly once, in the caller, at display/quoting time — every function here
// returns the full-precision float.

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/** Finite and >= 0 — a dimension that may legitimately be zero. */
function isNonNegFinite(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

/** Finite and > 0 — a spacing/divisor that must never be zero or negative. */
function isPosFinite(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/** Null unless the computed result itself is finite (guards overflow to Infinity). */
function finiteOrNull(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Model 1 — round bush or tree canopy (mini lights)
// ---------------------------------------------------------------------------

export interface RoundCanopyInput {
  /** Plant height, inches. */
  heightIn: number;
  /** Canopy circumference at its widest point, inches. */
  circumferenceIn: number;
  /** Wrap spacing, inches (company standard is 6in). */
  spacingIn: number;
}

/**
 * `wraps = height / spacing`
 * `footage = (wraps * circumference) / 12`
 */
export function roundCanopyFootage(input: RoundCanopyInput): number | null {
  const { heightIn, circumferenceIn, spacingIn } = input;
  if (!isNonNegFinite(heightIn) || !isNonNegFinite(circumferenceIn) || !isPosFinite(spacingIn)) return null;
  const wraps = heightIn / spacingIn;
  const footage = (wraps * circumferenceIn) / 12;
  return finiteOrNull(footage);
}

// ---------------------------------------------------------------------------
// Model 2 — square hedge canopy (mini lights)
// ---------------------------------------------------------------------------

export interface SquareHedgeInput {
  /** Hedge height, inches. */
  heightIn: number;
  /** Hedge width (the long, street-facing dimension), inches. */
  widthIn: number;
  /** Hedge length (front-to-back depth). Required — cannot be derived from a photo. */
  lengthIn: number;
  /** Wrap spacing, inches. */
  spacingIn: number;
}

/**
 * `footage = (((width + length) * 2) * (height / spacing) + height) / 12`
 */
export function squareHedgeFootage(input: SquareHedgeInput): number | null {
  const { heightIn, widthIn, lengthIn, spacingIn } = input;
  if (
    !isNonNegFinite(heightIn) ||
    !isNonNegFinite(widthIn) ||
    !isNonNegFinite(lengthIn) ||
    !isPosFinite(spacingIn)
  ) {
    return null;
  }
  const perimeterRun = (widthIn + lengthIn) * 2;
  const footage = (perimeterRun * (heightIn / spacingIn) + heightIn) / 12;
  return finiteOrNull(footage);
}

// ---------------------------------------------------------------------------
// Model 3 — round column garland
// ---------------------------------------------------------------------------

export interface RoundColumnGarlandInput {
  /** Column height, inches. */
  heightIn: number;
  /** Column circumference, inches. */
  circumferenceIn: number;
  /** Wrap spacing, inches. */
  spacingIn: number;
}

/**
 * `footage = (circumference * (height / spacing + 1) + height) / 12`
 * The `+ 1` extra wrap and the trailing `+ height` vertical run are
 * deliberate — garland needs both a denser wrap and a straight run up the
 * column that mini-light canopy models (1/2) don't.
 */
export function roundColumnGarlandFootage(input: RoundColumnGarlandInput): number | null {
  const { heightIn, circumferenceIn, spacingIn } = input;
  if (!isNonNegFinite(heightIn) || !isNonNegFinite(circumferenceIn) || !isPosFinite(spacingIn)) return null;
  const footage = (circumferenceIn * (heightIn / spacingIn + 1) + heightIn) / 12;
  return finiteOrNull(footage);
}

// ---------------------------------------------------------------------------
// Model 4 — square column garland
// ---------------------------------------------------------------------------

export interface SquareColumnGarlandInput {
  /** Column height, inches. */
  heightIn: number;
  /** Column length (one face), inches. */
  lengthIn: number;
  /** Column width (adjacent face), inches. */
  widthIn: number;
  /** Wrap spacing, inches. */
  spacingIn: number;
}

/**
 * `footage = (((length + width) * 2) * (height / spacing + 1) + height) / 12`
 */
export function squareColumnGarlandFootage(input: SquareColumnGarlandInput): number | null {
  const { heightIn, lengthIn, widthIn, spacingIn } = input;
  if (
    !isNonNegFinite(heightIn) ||
    !isNonNegFinite(lengthIn) ||
    !isNonNegFinite(widthIn) ||
    !isPosFinite(spacingIn)
  ) {
    return null;
  }
  const perimeterRun = (lengthIn + widthIn) * 2;
  const footage = (perimeterRun * (heightIn / spacingIn + 1) + heightIn) / 12;
  return finiteOrNull(footage);
}

// ---------------------------------------------------------------------------
// Model 5 — spruce tree wrap (C7/C9 bulbs, NOT mini strands)
// ---------------------------------------------------------------------------

export interface SpruceWrapInput {
  /** Tree height, FEET (not inches — this model's own inputs are feet). */
  heightFt: number;
  /** Trunk diameter, FEET. */
  diameterFt: number;
  /**
   * Vertical wrap spacing, inches — how far apart successive wraps sit
   * climbing the tree. NOT the same knob as the bulb-spacing used below to
   * convert footage into a bulb count (see the provenance note on
   * `SPRUCE_BULB_SPACING_FACTORS`).
   */
  wrapSpacingIn: number;
}

/**
 * `heightIn = heightFt * 12`
 * `circumferenceIn = (diameterFt * 3.14159) * 12`
 * `wraps = heightIn / wrapSpacing`
 * `bottomIn = (wraps * 0.45) * circumferenceIn`
 * `topIn = (wraps * 0.38) * (0.3 * circumferenceIn)`
 * `footage = (bottomIn + topIn) / 12`
 */
export function spruceWrapFootage(input: SpruceWrapInput): number | null {
  const { heightFt, diameterFt, wrapSpacingIn } = input;
  if (!isNonNegFinite(heightFt) || !isNonNegFinite(diameterFt) || !isPosFinite(wrapSpacingIn)) return null;
  const heightIn = heightFt * 12;
  const circumferenceIn = diameterFt * 3.14159 * 12;
  const wraps = heightIn / wrapSpacingIn;
  const bottomIn = wraps * 0.45 * circumferenceIn;
  const topIn = wraps * 0.38 * (0.3 * circumferenceIn);
  const footage = (bottomIn + topIn) / 12;
  return finiteOrNull(footage);
}

/** The only bulb spacings the company sheet defines a conversion factor for. */
export type SpruceBulbSpacingIn = 12 | 15 | 18 | 24;

// Straight from the company sheet — a 12in bulb spacing uses the footage
// as-is; wider spacings need proportionally fewer bulbs per foot of wrapped
// footage. Not derived, not rounded by us: 0.6666 is the sheet's own value,
// not 2/3.
const SPRUCE_BULB_SPACING_FACTORS: Record<SpruceBulbSpacingIn, number> = {
  12: 1,
  15: 0.8,
  18: 0.6666,
  24: 0.5,
};

/**
 * Bulb count for a spruce wrap's footage at a given bulb spacing. `null` for
 * negative/non-finite footage or a spacing outside the sheet's four defined
 * values (there is no formula to interpolate the rest).
 */
export function spruceBulbCount(footageFt: number, bulbSpacingIn: SpruceBulbSpacingIn): number | null {
  if (!isNonNegFinite(footageFt)) return null;
  const factor = SPRUCE_BULB_SPACING_FACTORS[bulbSpacingIn];
  if (factor === undefined) return null;
  return finiteOrNull(footageFt * factor);
}

// ---------------------------------------------------------------------------
// Footage → product conversion (mini strands, garland sticks)
// ---------------------------------------------------------------------------

/** The only mini-light bulb spacings the company stocks strands for. */
export type MiniBulbSpacingIn = 6 | 4;

// A 50-count 5MM strand covers 25ft at the company's STANDARD 6in bulb
// spacing, but only 17ft at 4in spacing (more bulbs packed into the same
// strand length). Quoting a 4in job at the 25ft figure under-counts by
// ~1.47x (25/17) — this table exists specifically so nobody does that.
const MINI_STRAND_COVERAGE_FT: Record<MiniBulbSpacingIn, number> = {
  6: 25,
  4: 17,
};

/** Default bulb spacing when a caller doesn't specify one — the company's confirmed standard. */
export const DEFAULT_MINI_BULB_SPACING_IN: MiniBulbSpacingIn = 6;

/**
 * Raw (unrounded) strand count for a run of footage. `null` for
 * negative/non-finite footage or an unsupported bulb spacing.
 */
export function footageToMiniStrands(
  footageFt: number,
  bulbSpacingIn: MiniBulbSpacingIn = DEFAULT_MINI_BULB_SPACING_IN,
): number | null {
  if (!isNonNegFinite(footageFt)) return null;
  const coverage = MINI_STRAND_COVERAGE_FT[bulbSpacingIn];
  if (coverage === undefined) return null;
  return finiteOrNull(footageFt / coverage);
}

const GARLAND_STICK_LENGTH_FT = 9;

/**
 * Raw (unrounded) 9ft-garland-stick count for a run of footage. `null` for
 * negative/non-finite footage.
 */
export function footageToGarlandSticks(footageFt: number): number | null {
  if (!isNonNegFinite(footageFt)) return null;
  return finiteOrNull(footageFt / GARLAND_STICK_LENGTH_FT);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export type StrandCalculatorInput =
  | ({ model: 'roundCanopy' } & RoundCanopyInput)
  | ({ model: 'squareHedge' } & SquareHedgeInput)
  | ({ model: 'roundColumnGarland' } & RoundColumnGarlandInput)
  | ({ model: 'squareColumnGarland' } & SquareColumnGarlandInput)
  | ({ model: 'spruceWrap' } & SpruceWrapInput);

/**
 * Dispatches to the correct model by its discriminant. Kept as a thin switch,
 * not a generic formula — the five models genuinely differ, and collapsing
 * them into one is the exact bug this module replaces.
 */
export function calculateFootage(input: StrandCalculatorInput): number | null {
  switch (input.model) {
    case 'roundCanopy':
      return roundCanopyFootage(input);
    case 'squareHedge':
      return squareHedgeFootage(input);
    case 'roundColumnGarland':
      return roundColumnGarlandFootage(input);
    case 'squareColumnGarland':
      return squareColumnGarlandFootage(input);
    case 'spruceWrap':
      return spruceWrapFootage(input);
    default:
      // Defensive only — TS exhaustiveness covers every real call site, but
      // this guards a malformed runtime value (e.g. JSON from outside the
      // type system) from falling through to an implicit `undefined`.
      return null;
  }
}
