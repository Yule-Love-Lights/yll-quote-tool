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
