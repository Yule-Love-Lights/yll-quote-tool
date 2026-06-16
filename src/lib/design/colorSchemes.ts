// Customer-facing light color/pattern schemes (#10).
//
// A "scheme" is the whole-house light color the customer sees on the portal.
// The operator sets a default in the builder; the customer can switch it on the
// portal and the live design RECOLORS in real time (the read-only renderer
// overrides each light item's `colorPattern` with the scheme's color ids).
//
// A scheme is just a list of palette color ids (the same ids a scene item's
// `colorPattern` uses — see editor-core/colors.ts), cycled per bulb. The special
// "as designed" scheme has `colorIds: null` = NO override, so the operator's
// per-item authored colors render exactly as drawn (also the back-compat default
// for quotes saved before this feature).
//
// ─────────────────────────────────────────────────────────────────────────────
// TO ADD / REMOVE a color or pattern: edit COLOR_SCHEMES below. Each non-null
// `colorIds` entry must reference a BUILT-IN palette id from editor-core/colors.ts
// (warm-white · cool-white · black · red · green · blue · orange · yellow · pink ·
// purple · teal). Order = the bulb cycle order. A unit test asserts every id is
// valid, so a typo fails the gates rather than silently rendering warm-white.
// ─────────────────────────────────────────────────────────────────────────────

export type ColorScheme = {
  /** Stable id stored on the quote + sent to the portal. Don't rename live ones. */
  id: string;
  /** Customer-facing label shown on the swatch. */
  label: string;
  /**
   * Palette color ids the light bulbs cycle through (like a scene item's
   * colorPattern). `null` = "as designed": no override, render the operator's
   * authored per-item colors.
   */
  colorIds: string[] | null;
};

// The default when a quote has no stored scheme (old rows + brand-new quotes):
// "as designed" — render exactly what the operator drew, no recolor surprise.
export const DEFAULT_COLOR_SCHEME_ID = 'as-designed';

// NOTE: 'cool-white' is the palette id; the customer-facing label is "Pure
// White" (the real product name). The id stays 'cool-white' so it keeps matching
// the editor palette + any saved patterns — only the label is customer-facing.
export const COLOR_SCHEMES: ColorScheme[] = [
  // ── Solids ──
  { id: 'as-designed', label: 'As designed', colorIds: null },
  { id: 'warm-white',  label: 'Warm White',  colorIds: ['warm-white'] },
  { id: 'cool-white',  label: 'Pure White',  colorIds: ['cool-white'] },
  { id: 'red',         label: 'Red',         colorIds: ['red'] },
  { id: 'green',       label: 'Green',       colorIds: ['green'] },
  { id: 'blue',        label: 'Blue',        colorIds: ['blue'] },
  { id: 'purple',      label: 'Purple',      colorIds: ['purple'] },
  // ── Patterns (bulbs cycle the listed ids in order) ──
  { id: 'multicolor',  label: 'Multicolor',  colorIds: ['red', 'green', 'blue', 'yellow', 'pink'] },
  { id: 'champagne',   label: 'Champagne',   colorIds: ['warm-white', 'cool-white'] },
  { id: 'candy-cane',  label: 'Candy Cane',  colorIds: ['cool-white', 'red', 'red'] },
  { id: 'christmas',   label: 'Christmas',   colorIds: ['green', 'green', 'red', 'red'] },
  { id: 'blue-white',  label: 'Blue & White', colorIds: ['blue', 'blue', 'cool-white', 'cool-white'] },
];

const SCHEME_MAP = new Map<string, ColorScheme>(COLOR_SCHEMES.map((s) => [s.id, s]));

// Resolve a scheme id to its full record. Unknown / missing ids fall back to the
// default ("as designed") so a stale id from an old quote never breaks rendering.
export function getColorScheme(id: string | null | undefined): ColorScheme {
  return (id ? SCHEME_MAP.get(id) : undefined) ?? SCHEME_MAP.get(DEFAULT_COLOR_SCHEME_ID) ?? COLOR_SCHEMES[0];
}

// The color-id override the read-only renderer applies, or null for "as designed"
// (no override). Unknown ids → null (render as drawn) via the default fallback.
export function resolveSchemeColorIds(id: string | null | undefined): string[] | null {
  return getColorScheme(id).colorIds;
}
