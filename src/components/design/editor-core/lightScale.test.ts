import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  LIGHT_SCALE_DEFAULT,
  LIGHT_SCALE_MAX,
  LIGHT_SCALE_MIN,
  bulbDims,
  normalizeLightScale,
  spritzerLightDims,
} from "./lightScale";

// Unit coverage for the per-design light-size multiplier (Naldo, 2026-08-22).
//
// Imports ./lightScale DIRECTLY, never through bulb.ts / strand.ts / editor.ts
// — those import Konva, whose Node entrypoint needs the optional `canvas`
// package (not installed here), so they cannot be loaded in this headless test
// environment at all. That constraint is exactly why the sizing math lives in
// its own Konva-free module, mirroring yardstick-scale.ts and drawContext.ts.

describe("normalizeLightScale", () => {
  it("falls back to 1 for anything that isn't a real number", () => {
    // An old design has no field; a hand-edited scene JSON could carry
    // anything. None of these may render lights at 0x (invisible).
    for (const bad of [undefined, null, "2", "", {}, [], true, NaN, Infinity, -Infinity]) {
      expect(normalizeLightScale(bad)).toBe(LIGHT_SCALE_DEFAULT);
    }
  });

  it("clamps into range instead of trusting the stored value", () => {
    expect(normalizeLightScale(0)).toBe(LIGHT_SCALE_MIN);
    expect(normalizeLightScale(-5)).toBe(LIGHT_SCALE_MIN);
    expect(normalizeLightScale(99)).toBe(LIGHT_SCALE_MAX);
  });

  it("passes an in-range value through untouched", () => {
    expect(normalizeLightScale(2.5)).toBe(2.5);
    expect(normalizeLightScale(LIGHT_SCALE_MIN)).toBe(LIGHT_SCALE_MIN);
    expect(normalizeLightScale(LIGHT_SCALE_MAX)).toBe(LIGHT_SCALE_MAX);
  });
});

describe("bulbDims with no scale argument", () => {
  // Pins today's exact numbers so a later edit to the size table is a
  // deliberate, visible change rather than a silent one.
  it("renders a c9 at its 3px floor on a whole-house photo", () => {
    // 20 px/ft is a typical whole-house shot. 0.065 * 20 = 1.3, so the floor
    // is what's actually in force here. This is the case the whole feature
    // exists for.
    expect(bulbDims("c9", 20).radius).toBe(3);
  });

  it("renders a c9 at its real-world size once the photo is close enough", () => {
    // 0.065 * 100 = 6.5, above the 3px floor, so physical size wins.
    expect(bulbDims("c9", 100).radius).toBeCloseTo(6.5, 10);
  });

  it("is identical to passing an explicit 1", () => {
    for (const type of ["c9", "permanent", "mini", "bistro"] as const) {
      for (const ppf of [8, 20, 46, 100]) {
        expect(bulbDims(type, ppf, 1)).toEqual(bulbDims(type, ppf));
      }
    }
  });
});

describe("bulbDims scaling", () => {
  it("multiplies AFTER the floor, so it works on the photos it exists for", () => {
    // The bug this feature fixes: at 20 px/ft every c9 pins to 3px and the
    // yardstick cannot move it. Scaling before the floor would be swallowed
    // whole (max(3, 0.065 * 20 * 3) is still 3.9, barely a change) and the
    // slider would appear broken on exactly the photos staff complained about.
    expect(bulbDims("c9", 20, 3).radius).toBe(9);
    expect(bulbDims("c9", 20, 0.5).radius).toBe(1.5);
  });

  it("also scales a bulb whose physical size already beat the floor", () => {
    expect(bulbDims("c9", 100, 2).radius).toBeCloseTo(13, 10);
  });

  it("grows the halo with the core so the bulb keeps its proportions", () => {
    for (const scale of [0.5, 1, 2, 4]) {
      const d = bulbDims("c9", 20, scale);
      expect(d.glowRadius).toBeCloseTo(d.radius * 2.6, 10); // c9 haloMul
    }
  });

  it("scales every bulb type and preserves their size ordering", () => {
    const types = ["mini", "permanent", "c9", "bistro"] as const;
    for (const scale of [1, 2.5, 4]) {
      const radii = types.map((t) => bulbDims(t, 20, scale).radius);
      // mini < permanent < c9 < bistro at every setting: the multiplier
      // changes how big the lights read, never which type looks chunkier.
      expect(radii).toEqual([...radii].sort((a, b) => a - b));
      expect(new Set(radii).size).toBe(types.length);
    }
  });

  it("clamps a bad scale handed straight to it, rather than applying it raw", () => {
    // Defence in depth: callers normalize, but a renderer must never be able
    // to paint the whole photo white or draw nothing at all.
    expect(bulbDims("c9", 20, 0).radius).toBe(bulbDims("c9", 20, LIGHT_SCALE_MIN).radius);
    expect(bulbDims("c9", 20, 500).radius).toBe(bulbDims("c9", 20, LIGHT_SCALE_MAX).radius);
    expect(bulbDims("c9", 20, NaN).radius).toBe(bulbDims("c9", 20, 1).radius);
  });

  it("leaves coreSoftness alone — it is a gradient stop, not a size", () => {
    expect(bulbDims("c9", 20, 4).coreSoftness).toBe(bulbDims("c9", 20, 1).coreSoftness);
  });
});

describe("spritzerLightDims", () => {
  // A 24" spritzer at 20 px/ft renders at radiusPx 20: (24/12 * 20) / 2.
  const R = 20;

  it("has both tips and rays pinned to their floors at 1x on a house photo", () => {
    // 20 * 0.028 = 0.56 and 20 * 0.008 = 0.16, so both floors are what is
    // actually in force. This is the reported bug, pinned as a number.
    const d = spritzerLightDims(R);
    expect(d.tipRadius).toBe(1.5);
    expect(d.rayStroke).toBe(0.6);
  });

  it("is identical to passing an explicit 1", () => {
    for (const r of [2, 20, 60, 200]) {
      expect(spritzerLightDims(r, 1)).toEqual(spritzerLightDims(r));
    }
  });

  it("multiplies AFTER the floors, so the slider actually moves them", () => {
    const d = spritzerLightDims(R, 3);
    expect(d.tipRadius).toBe(4.5);
    expect(d.rayStroke).toBeCloseTo(1.8, 10);
  });

  it("also scales a big spritzer whose real size already beat the floors", () => {
    // radiusPx 200: 200 * 0.028 = 5.6 and 200 * 0.008 = 1.6, both above floor.
    const d = spritzerLightDims(200, 2);
    expect(d.tipRadius).toBeCloseTo(11.2, 10);
    expect(d.rayStroke).toBeCloseTo(3.2, 10);
  });

  it("grows the tip halo with the tip so a tip keeps its proportions", () => {
    for (const scale of [0.5, 1, 2, 4]) {
      const d = spritzerLightDims(R, scale);
      expect(d.tipHaloRadius).toBeCloseTo(d.tipRadius * 2.6, 10);
    }
  });

  it("clamps a bad scale rather than applying it raw", () => {
    expect(spritzerLightDims(R, 0)).toEqual(spritzerLightDims(R, LIGHT_SCALE_MIN));
    expect(spritzerLightDims(R, 500)).toEqual(spritzerLightDims(R, LIGHT_SCALE_MAX));
    expect(spritzerLightDims(R, NaN)).toEqual(spritzerLightDims(R, 1));
  });

  it("does not touch the spritzer's own radius, which staff already control", () => {
    // Guards the split this helper exists to keep: it returns light parts
    // only. If a future edit starts returning a scaled spray radius, the
    // Small/Medium/Large size buttons and the resize handles would start
    // fighting the slider.
    expect(Object.keys(spritzerLightDims(R, 4)).sort()).toEqual([
      "rayStroke",
      "tipHaloRadius",
      "tipRadius",
    ]);
  });
});

// Row 348: undo()/redo() in editor.ts reassign `scene` and call
// redrawScene(), which correctly resizes bulbs (redrawCanvas() reads
// activeLightScale() fresh off the reverted scene) — but neither used to
// resync the light-size slider's thumb/readout, which kept showing the
// pre-undo value. editor.ts imports Konva, which needs the optional `canvas`
// package this headless test environment doesn't have (see the file header
// above), so this pins the fix as source text instead of executing it.
describe("editor.ts undo()/redo() light-scale resync", () => {
  it("calls showLightScale(activeLightScale()) in both undo() and redo()", () => {
    const editor = readFileSync(
      new URL("./editor.ts", import.meta.url),
      "utf8",
    );
    const [undoBody] = editor.match(/function undo\(\) \{[\s\S]*?\n  \}/) ?? [""];
    const [redoBody] = editor.match(/function redo\(\) \{[\s\S]*?\n  \}/) ?? [""];

    for (const body of [undoBody, redoBody]) {
      expect(body).toContain("redrawScene();");
      expect(body).toContain("showLightScale(activeLightScale());");
    }
  });
});
