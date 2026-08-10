import { describe, it, expect } from "vitest";
import {
  WREATH_SIZES,
  BOW_SIZES,
  GARLAND_SIZES,
  SPRITZER_SIZES,
  POLE_HEIGHTS,
  sizePresetLabel,
  formatRawSize,
  offPresetSizeSuffix,
} from "./sizePresets";

// The pre-#202 preset supersets (editor.ts's old 4/5-value arrays) + each
// type's pre-existing tool-default value (editor.ts ToolState defaults /
// toolDefaults.ts DEFAULT_TOOL_DEFAULTS — unchanged by this task). Used below
// to lock two invariants: the new arrays only keep values that already
// existed, and the exact default a newly-placed item gets is still offered.
const LEGACY = {
  wreath: { superset: [24, 36, 48, 60], current: WREATH_SIZES, default: 36 },
  bow: { superset: [12, 18, 24, 36, 48], current: BOW_SIZES, default: 24 },
  garland: { superset: [6, 9, 12, 18, 24], current: GARLAND_SIZES, default: 12 },
  spritzer: { superset: [16, 24, 36, 48], current: SPRITZER_SIZES, default: 24 },
  pole: { superset: [96, 120, 144, 180], current: POLE_HEIGHTS, default: 120 },
} as const;

describe("decor/pole size presets — shape", () => {
  for (const [type, { superset, current, default: def }] of Object.entries(LEGACY)) {
    it(`${type}: collapses to exactly 3 strictly ascending values, no duplicate tiers, drawn from the original preset list`, () => {
      expect(current).toHaveLength(3);
      // Strictly ascending (and therefore no duplicates) -- NOT just
      // non-decreasing. A stable sort of e.g. [24, 36, 36] equals itself, so
      // a `toEqual([...current].sort(...))` check would silently PASS a
      // dropped tier (two buttons rendering the same value, one Small/Medium/
      // Large label lost) instead of catching it. (#202 F2)
      for (let i = 1; i < current.length; i++) {
        expect(current[i]).toBeGreaterThan(current[i - 1]);
      }
      for (const v of current) expect(superset).toContain(v);
    });

    it(`${type}: keeps its pre-existing tool default so a newly-placed item's size is unchanged`, () => {
      expect(current).toContain(def);
    });
  }
});

describe("sizePresetLabel", () => {
  it("labels each of the 3 kept values Small / Medium / Large in position order", () => {
    expect(sizePresetLabel(WREATH_SIZES, WREATH_SIZES[0])).toBe("Small");
    expect(sizePresetLabel(WREATH_SIZES, WREATH_SIZES[1])).toBe("Medium");
    expect(sizePresetLabel(WREATH_SIZES, WREATH_SIZES[2])).toBe("Large");
  });

  it("works the same for the const-asserted pole array", () => {
    expect(sizePresetLabel(POLE_HEIGHTS, 96)).toBe("Small");
    expect(sizePresetLabel(POLE_HEIGHTS, 120)).toBe("Medium");
    expect(sizePresetLabel(POLE_HEIGHTS, 180)).toBe("Large");
  });

  // The round-trip guarantee: an off-preset stored sizeIn/heightIn (a dropped
  // legacy preset like wreath's old 48", or an arbitrary value only reachable
  // via the anchor-resize handles) must NOT be coerced onto the nearest tier.
  // It comes back null — the caller shows no button active and leaves the
  // stored number exactly as it was — proving this module performs no
  // snapping/clamping of its own.
  describe("non-preset values are never snapped to a tier", () => {
    it("a dropped legacy preset (wreath's old 48\") reports no tier and is left unmatched", () => {
      const droppedLegacyValue = 48;
      expect(WREATH_SIZES).not.toContain(droppedLegacyValue); // confirms it really was dropped
      expect(sizePresetLabel(WREATH_SIZES, droppedLegacyValue)).toBeNull();
      // The value itself is untouched by the lookup — a pure function can't
      // mutate its argument, but assert the identity explicitly so this test
      // documents the "never coerced" contract rather than just "no crash".
      expect(droppedLegacyValue).toBe(48);
    });

    it("an arbitrary hand-resized value (never any version's preset) reports no tier", () => {
      const handResizedValue = 51.5;
      for (const options of [WREATH_SIZES, BOW_SIZES, GARLAND_SIZES, SPRITZER_SIZES, POLE_HEIGHTS]) {
        expect(sizePresetLabel(options, handResizedValue)).toBeNull();
      }
      expect(handResizedValue).toBe(51.5); // still exactly what was stored
    });

    it("zero and negative inputs (never valid sizes) also report no tier, without throwing", () => {
      expect(() => sizePresetLabel(WREATH_SIZES, 0)).not.toThrow();
      expect(sizePresetLabel(WREATH_SIZES, 0)).toBeNull();
      expect(sizePresetLabel(WREATH_SIZES, -36)).toBeNull();
    });
  });
});

// #202 F1 (fix round): formatRawSize + offPresetSizeSuffix are the pure
// pieces behind "show the real number when it isn't a kept preset" -- editor.ts
// uses them for the section-header suffix and the 4th "you are here" button.
describe("formatRawSize", () => {
  it("formats an inches value with a trailing inch mark, defaulting to the 'in' unit", () => {
    expect(formatRawSize(48)).toBe('48"');
    expect(formatRawSize(48, "in")).toBe('48"');
  });

  it("formats a feet value (pole heightIn / 12) with a trailing ' ft'", () => {
    expect(formatRawSize(144, "ft")).toBe("12 ft"); // a dropped legacy pole tier
  });

  it("rounds to 1 decimal and drops a trailing .0, for both units", () => {
    // A hand-resize drag scales the stored size by an arbitrary Transformer
    // ratio (bakeTransformInto* in editor.ts) -- rarely a round number.
    expect(formatRawSize(41.38287, "in")).toBe('41.4"');
    expect(formatRawSize(100, "ft")).toBe("8.3 ft"); // 100 / 12 = 8.3333...
    expect(formatRawSize(36.001, "in")).toBe('36"'); // rounds away a near-zero remainder, no stray ".0"
  });
});

describe("offPresetSizeSuffix", () => {
  it("returns \"\" when the single shared value IS a kept preset (the active button already shows it)", () => {
    for (const v of WREATH_SIZES) expect(offPresetSizeSuffix(WREATH_SIZES, [v])).toBe("");
    expect(offPresetSizeSuffix(POLE_HEIGHTS, [120], "ft")).toBe("");
  });

  it("returns the em-dash raw-size suffix when the single shared value is off-preset", () => {
    expect(offPresetSizeSuffix(WREATH_SIZES, [48])).toBe(' — 48"'); // dropped legacy tier
    expect(offPresetSizeSuffix(POLE_HEIGHTS, [144], "ft")).toBe(" — 12 ft"); // dropped legacy pole tier
    expect(offPresetSizeSuffix(WREATH_SIZES, [41.5])).toBe(' — 41.5"'); // hand-resized, never any preset
  });

  it("returns \"\" for a mixed multi-select or an empty selection -- no single number to show", () => {
    expect(offPresetSizeSuffix(WREATH_SIZES, [24, 48])).toBe(""); // mixed: caller renders its own "— mixed" text
    expect(offPresetSizeSuffix(WREATH_SIZES, [])).toBe("");
  });
});
