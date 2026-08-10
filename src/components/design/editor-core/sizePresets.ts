// Small / Medium / Large size presets for decor items + poles (#202).
//
// `sizeIn` (wreath/bow/garland/spritzer) and `heightIn` (pole) are VISUAL ONLY
// — see sceneTypes.ts. The inch/foot-labeled presets these buttons used to show
// (e.g. 24"/36"/48"/60") misled staff into thinking they set the billed size;
// the real billed spec lives in the separate staff-set `quoteSize`/
// `quoteLength` fields the projection actually reads (projectScene.ts). Poles
// have no quote binding at all but get the same relabel — their sizes are
// equally aesthetic-only (Jason, #202).
//
// Each array below keeps exactly 3 of the type's ORIGINAL preset values — the
// smallest, the pre-existing tool default (now "Medium"), and the largest —
// so a newly-placed item's default stays visually identical to before this
// relabel. Odd/in-between sizes (an old design's dropped preset, or anything
// reached via the anchor-resize handles) are real numbers that stay exactly as
// stored; this module never snaps/coerces them — `sizePresetLabel` returns
// null for a value that isn't one of `options` rather than guessing the
// nearest tier, so the caller renders "no button active" for it (same as
// today's behavior for any off-preset value).
//
// Split out from `editor.ts` (same reason as yardstick-scale.ts: a small pure
// module the Konva-orchestrating file can import, and this repo can actually
// unit-test without loading Konva).
//
// #202 F1 (fix round after the four-lens review): trimming to 3 presets also
// removed the LAST place an off-preset item's real number was visible in the
// UI — an old design's dropped tier, or anything reached via the anchor-
// resize handles, rendered as three unlit buttons with no way to confirm
// what the item actually was. `formatRawSize` + `offPresetSizeSuffix` below
// are the pure, testable pieces of that fix: editor.ts uses them to show the
// real number in the section header, and to add a 4th "you are here" button
// alongside the 3 presets (still never snapping/coercing the stored value).

export const WREATH_SIZES = [24, 36, 60]; // was [24, 36, 48, 60]; 36 = unchanged tool default (Medium)
export const BOW_SIZES = [12, 24, 48]; // was [12, 18, 24, 36, 48]; 24 = unchanged tool default (Medium)
export const GARLAND_SIZES = [6, 12, 24]; // was [6, 9, 12, 18, 24]; 12 = unchanged tool default (Medium)
export const SPRITZER_SIZES = [16, 24, 48]; // was [16, 24, 36, 48]; 24 = unchanged tool default (Medium)
export const POLE_HEIGHTS = [96, 120, 180] as const; // was [96, 120, 144, 180] as const; 120 = unchanged tool default (Medium)

const TIER_LABELS = ["Small", "Medium", "Large"] as const;

// The Small/Medium/Large label for `value` within `options` (position-based:
// options[0] → Small, options[1] → Medium, options[2] → Large). Returns null
// when `value` isn't a member of `options` — see the file header for why an
// off-preset value must not be mapped onto the nearest tier.
export function sizePresetLabel(options: readonly number[], value: number): string | null {
  const i = options.indexOf(value);
  return i === -1 ? null : (TIER_LABELS[i] ?? null);
}

// Rounds to 1 decimal place and drops a trailing ".0" (48 -> 48, 41.38287 ->
// 41.4). Every value this module formats came either from a kept preset
// (already a clean integer) or from a hand-resize drag (`bakeTransformInto*`
// in editor.ts, which scales the stored size by an arbitrary Transformer
// ratio with no rounding) — so an off-preset value is often NOT a round
// number, and printing it unrounded can run to a dozen+ decimal digits.
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Formats a raw stored value for display when it doesn't match a kept preset
// (see sizePresetLabel) -- e.g. "48"" for wreath/bow/garland/spritzer, or
// "10 ft" for poles. Poles are labeled in feet everywhere else in this UI
// (h / 12); this keeps that same convention, just rounded for display (an
// off-preset pole height need not be a multiple of 12).
export function formatRawSize(value: number, unit: "in" | "ft" = "in"): string {
  return unit === "ft" ? `${round1(value / 12)} ft` : `${round1(value)}"`;
}

// Header suffix for a Size/Height section (#202 F1): when `values` is
// exactly one shared value that ISN'T one of the 3 kept presets, returns
// " — 48"" (or " — 10 ft" for poles) so an off-preset item's panel explains
// its real size instead of showing three unlit buttons with no indication
// why. Returns "" when the value IS a kept preset (its button already shows
// the label) or when `values` isn't a single defined value -- 0 items, or a
// multi-select whose items disagree (mixed); callers render their own mixed
// text for that case, same as before this change.
export function offPresetSizeSuffix(options: readonly number[], values: number[], unit: "in" | "ft" = "in"): string {
  if (values.length !== 1) return "";
  const [value] = values;
  return sizePresetLabel(options, value) === null ? ` — ${formatRawSize(value, unit)}` : "";
}
