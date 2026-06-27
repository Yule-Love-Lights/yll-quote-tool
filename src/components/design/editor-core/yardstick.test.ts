import { describe, it, expect } from "vitest";
import { pxPerFoot, yardstickMeasuredPx } from "./yardstick-scale";
import type { Yardstick } from "@/lib/design/sceneTypes";

// Helper: build a yardstick with sensible defaults; override per case.
function ys(over: Partial<Yardstick> = {}): Yardstick {
  return {
    id: "y1",
    realFeet: 3,
    x: 0,
    y: 0,
    width: 150,
    height: 70,
    ...over,
  };
}

describe("yardstickMeasuredPx", () => {
  it("defaults to width when axis is absent (legacy / design-tool data)", () => {
    // Byte-identical with pre-axis behavior: a horizontal door drawn 150px
    // wide × 70px tall still measures the 150px width.
    expect(yardstickMeasuredPx(ys({ axis: undefined }))).toBe(150);
  });

  it('uses width when axis === "width"', () => {
    expect(yardstickMeasuredPx(ys({ axis: "width", width: 120, height: 400 }))).toBe(120);
  });

  it('uses height when axis === "height" (vertical reference)', () => {
    // A downspout drawn 40px wide × 300px tall: the entered feet describe the
    // 300px vertical extent, so that's what we must measure.
    expect(yardstickMeasuredPx(ys({ axis: "height", width: 40, height: 300 }))).toBe(300);
  });
});

describe("pxPerFoot", () => {
  it("returns the fallback for null", () => {
    expect(pxPerFoot(null)).toBe(50);
  });

  it("returns the fallback when realFeet is 0 (avoids divide-by-zero)", () => {
    expect(pxPerFoot(ys({ realFeet: 0 }))).toBe(50);
  });

  it("divides WIDTH by feet for a horizontal reference (the common case)", () => {
    // 150px wide door entered as 3 ft → 50 px/ft.
    expect(pxPerFoot(ys({ axis: "width", width: 150, height: 70, realFeet: 3 }))).toBe(50);
  });

  it("legacy yardstick (no axis) keeps measuring width — unchanged scale", () => {
    expect(pxPerFoot(ys({ axis: undefined, width: 150, realFeet: 3 }))).toBe(50);
  });

  it("divides HEIGHT by feet for a vertical reference — fixes the inflated scale", () => {
    // Downspout drawn 40px wide × 300px tall, entered as 6 ft tall.
    // Buggy width-only: 40/6 ≈ 6.67 px/ft (wildly wrong).
    // Correct: 300/6 = 50 px/ft.
    expect(pxPerFoot(ys({ axis: "height", width: 40, height: 300, realFeet: 6 }))).toBe(50);
  });

  it('does NOT use max(): a "3 ft wide" door drawn 3w×7h keeps the 3-ft width', () => {
    // The previous WRONG fix used Math.max(width,height), which would pick the
    // 7-ft-tall height (490px) as if it were the 3 ft → broken scale. With an
    // explicit width axis the entered 3 ft stays mapped to the 210px width.
    // 210px / 3ft = 70 px/ft (matches the operator's intent). max() would give
    // 490/3 ≈ 163 px/ft.
    expect(pxPerFoot(ys({ axis: "width", width: 210, height: 490, realFeet: 3 }))).toBe(70);
  });
});
