import { describe, it, expect, vi } from "vitest";

// yardstick.ts imports Konva at module top for the render helpers; Konva's
// node build needs the native `canvas` package (not installed in this test
// env). pxPerFoot is pure math and never touches Konva, so stub the module.
vi.mock("konva", () => ({ default: {} }));

import { pxPerFoot } from "./yardstick";
import type { Yardstick } from "@/lib/design/sceneTypes";

// Audit fix (#107): pxPerFoot must scale off the LONGER axis so a vertical
// calibration (a tall yardstick box drawn against a downspout / garage-door
// height) isn't read as width << real length, which inflated every derived
// measurement. Horizontal (wide) calibration — the common case — is unchanged.

const base: Yardstick = { id: "y1", realFeet: 10, x: 0, y: 0, width: 0, height: 0 };

describe("pxPerFoot", () => {
  it("uses width for a wide box (unchanged common case)", () => {
    const ys: Yardstick = { ...base, width: 500, height: 20 };
    expect(pxPerFoot(ys)).toBe(50); // 500px / 10ft
  });

  it("uses height for a tall box (vertical reference)", () => {
    const ys: Yardstick = { ...base, width: 20, height: 500 };
    expect(pxPerFoot(ys)).toBe(50); // longer axis (500px) / 10ft, not 20/10
  });

  it("falls back to 50 for null / zero feet", () => {
    expect(pxPerFoot(null)).toBe(50);
    expect(pxPerFoot({ ...base, realFeet: 0, width: 500, height: 500 })).toBe(50);
  });
});
