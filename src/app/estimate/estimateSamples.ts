// Customer self-serve estimate — swatch config (ledger self-serve, S48).
//
// The landing gallery features REAL completed-job designs (fetched from
// /api/estimate/samples, rendered via DesignCanvas). This module now only holds the
// color-swatch config that lets the customer recolor a featured design live.

export type SchemeKey = 'warm' | 'cool' | 'multi' | 'redwhite';

/** Swatch preview dots (hex, for the chip UI only). */
export const SCHEMES: Record<SchemeKey, string[]> = {
  warm: ['#F5CC7A'],
  cool: ['#E8F1FA'],
  multi: ['#E0524D', '#58B368', '#F5CC7A', '#5B8DD9'],
  redwhite: ['#E0524D', '#F4ECD8'],
};

/**
 * Map each swatch to real palette color ids (DesignCanvas colorOverride), so the
 * customer previews the actual products we'd install. Ids come from DEFAULT_COLORS.
 */
export const SCHEME_COLOR_IDS: Record<SchemeKey, string[]> = {
  warm: ['warm-white'],
  cool: ['cool-white'],
  multi: ['red', 'green', 'warm-white', 'blue'],
  redwhite: ['red', 'warm-white'],
};
