import { DEFAULT_COLORS } from '@/components/design/editor-core/colors';

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
// The BUILT-IN default scheme list. #101 makes the live list data-driven from
// app_settings (Settings → Customer Portal); this is the factory default the
// stored list is seeded from + falls back to. Resolvers below take an optional
// `schemes` list so the portal/#92 can resolve against the operator's configured
// swatches instead of these defaults.
export const DEFAULT_COLOR_SCHEMES: ColorScheme[] = [
  // ── Solids ──
  // "Staff's pick" = the as-designed render (no override): the look our team
  // composed for this house. The single-solid Red / Green / Purple / Blue presets
  // were removed as customer options (they read garish as a whole-house wash) —
  // those colors still appear within Staff's pick and remain buildable in "Build
  // your own". Their ids stay reserved so any older quote saved as one falls back here.
  { id: 'as-designed', label: "Staff's pick", colorIds: null },
  { id: 'warm-white',  label: 'Warm White',  colorIds: ['warm-white'] },
  { id: 'cool-white',  label: 'Pure White',  colorIds: ['cool-white'] },
  { id: 'cool-white-faceted', label: 'Cool White', colorIds: ['cool-white-faceted'] },
  // ── Patterns (bulbs cycle the listed ids in order) ──
  { id: 'multicolor',  label: 'Multicolor',  colorIds: ['red', 'green', 'blue', 'yellow', 'pink'] },
  { id: 'champagne',   label: 'Champagne',   colorIds: ['warm-white', 'cool-white'] },
  { id: 'candy-cane',  label: 'Candy Cane',  colorIds: ['cool-white', 'red', 'red'] },
  { id: 'christmas',   label: 'Christmas',   colorIds: ['green', 'green', 'red', 'red'] },
  { id: 'blue-white',  label: 'Frozen',      colorIds: ['blue', 'blue', 'cool-white', 'cool-white'] }, // #92 — renamed from "Blue & White"; id kept so saved quotes don't break
];

// NOTE: the PERMANENT scene set + its picker validation moved to
// `permanentScenes.ts` (#88 P6b-3) — permanent scenes gained animation `effect`s
// and are a vertical-specific concept, not part of this holiday/shared module.

// Resolve a scheme id to its full record within a given scheme list (defaults to
// the built-ins). Unknown / missing ids fall back to the default ("as designed")
// so a stale id from an old quote never breaks rendering; a list missing
// as-designed falls back to its first entry.
export function getColorScheme(
  id: string | null | undefined,
  schemes: ColorScheme[] = DEFAULT_COLOR_SCHEMES,
): ColorScheme {
  const map = new Map<string, ColorScheme>(schemes.map((s) => [s.id, s]));
  return (
    (id ? map.get(id) : undefined) ??
    map.get(DEFAULT_COLOR_SCHEME_ID) ??
    schemes[0] ??
    DEFAULT_COLOR_SCHEMES[0]
  );
}

// The color-id override the read-only renderer applies, or null for "as designed"
// (no override). Unknown ids → null (render as drawn) via the default fallback.
export function resolveSchemeColorIds(
  id: string | null | undefined,
  schemes: ColorScheme[] = DEFAULT_COLOR_SCHEMES,
): string[] | null {
  return getColorScheme(id, schemes).colorIds;
}

// ─── Build-your-own custom pattern (#49) ────────────────────────────────────
// Beyond the presets above, the customer can compose their own pattern: an
// ordered list of palette color ids the bulbs cycle through. Stored alongside
// the scheme; when the scheme id is CUSTOM_SCHEME_ID the renderer uses this list
// instead of a preset's colorIds.

export const CUSTOM_SCHEME_ID = 'custom';

// Max colors in a customer-built pattern (keeps it sane + the swatch row short).
export const MAX_CUSTOM_PATTERN = 8;

// The BUILT-IN default build-your-own palette: every built-in bulb color EXCEPT
// black (an off bulb). #101 makes the live palette data-driven (operators can
// curate which of these colors are offered). Ids only — the picker resolves
// hex/label via colorOf.
export const DEFAULT_BUILDABLE_COLOR_IDS: string[] = DEFAULT_COLORS.filter(
  (c) => c.id !== 'black',
).map((c) => c.id);

// Sanitize a customer-built pattern from any source (client body / stored
// snapshot): keep only ids in the offered buildable list (defaults to the
// built-ins), in order, capped at MAX_CUSTOM_PATTERN. Returns [] for anything
// invalid. The scan itself is bounded (slice up front) so an attacker-controlled
// megabyte array can't drive unbounded work — a real client never sends more than
// MAX_CUSTOM_PATTERN ids anyway.
export function sanitizeCustomPattern(
  input: unknown,
  buildable: string[] = DEFAULT_BUILDABLE_COLOR_IDS,
): string[] {
  if (!Array.isArray(input)) return [];
  const set = new Set(buildable);
  const out: string[] = [];
  for (const v of input.slice(0, MAX_CUSTOM_PATTERN * 4)) {
    if (out.length >= MAX_CUSTOM_PATTERN) break;
    if (typeof v === 'string' && set.has(v)) out.push(v);
  }
  return out;
}

// Whether a scheme id is one the customer could legitimately have chosen: a
// scheme in the given list (defaults to the built-ins) or 'custom'. The approve
// route validates an incoming colorSchemeId against the LIVE list before freezing
// it into the snapshot, so a junk id can't be persisted as "what the customer
// approved" (rendering already falls back safely, but the record should be real).
export function isKnownColorSchemeId(
  id: unknown,
  schemes: ColorScheme[] = DEFAULT_COLOR_SCHEMES,
): id is string {
  if (typeof id !== 'string') return false;
  if (id === CUSTOM_SCHEME_ID) return true;
  return schemes.some((s) => s.id === id);
}
