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
export const COLOR_SCHEMES: ColorScheme[] = [
  // ── Solids ──
  // "Staff's pick" = the as-designed render (no override): the look our team
  // composed for this house. The single-solid Red / Green / Purple / Blue presets
  // were removed as customer options (they read garish as a whole-house wash) —
  // those colors still appear within Staff's pick and remain buildable in "Build
  // your own". Their ids stay reserved so any older quote saved as one falls back here.
  { id: 'as-designed', label: "Staff's pick", colorIds: null },
  { id: 'warm-white',  label: 'Warm White',  colorIds: ['warm-white'] },
  { id: 'cool-white',  label: 'Pure White',  colorIds: ['cool-white'] },
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

// ─── Build-your-own custom pattern (#49) ────────────────────────────────────
// Beyond the presets above, the customer can compose their own pattern: an
// ordered list of palette color ids the bulbs cycle through. Stored alongside
// the scheme; when the scheme id is CUSTOM_SCHEME_ID the renderer uses this list
// instead of a preset's colorIds.

export const CUSTOM_SCHEME_ID = 'custom';

// Max colors in a customer-built pattern (keeps it sane + the swatch row short).
export const MAX_CUSTOM_PATTERN = 8;

// Colors a customer can build a pattern from: every built-in bulb color EXCEPT
// black (an off bulb). Ids only — the picker resolves hex/label via colorOf.
export const BUILDABLE_COLOR_IDS: string[] = DEFAULT_COLORS.filter((c) => c.id !== 'black').map(
  (c) => c.id,
);

const BUILDABLE_SET = new Set(BUILDABLE_COLOR_IDS);

// Sanitize a customer-built pattern from any source (client body / stored
// snapshot): keep only valid buildable color ids, in order, capped at
// MAX_CUSTOM_PATTERN. Returns [] for anything invalid. The scan itself is bounded
// (slice up front) so an attacker-controlled megabyte array can't drive unbounded
// work — a real client never sends more than MAX_CUSTOM_PATTERN ids anyway.
export function sanitizeCustomPattern(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const v of input.slice(0, MAX_CUSTOM_PATTERN * 4)) {
    if (out.length >= MAX_CUSTOM_PATTERN) break;
    if (typeof v === 'string' && BUILDABLE_SET.has(v)) out.push(v);
  }
  return out;
}

// Known scheme ids = the presets + 'custom'. The approve route validates an
// incoming colorSchemeId against this before freezing it into the snapshot, so a
// junk id can't be persisted as "what the customer approved" (rendering already
// falls back safely, but the authoritative record should be a real id).
const KNOWN_SCHEME_IDS = new Set<string>([...COLOR_SCHEMES.map((s) => s.id), CUSTOM_SCHEME_ID]);
export function isKnownColorSchemeId(id: unknown): id is string {
  return typeof id === 'string' && KNOWN_SCHEME_IDS.has(id);
}
