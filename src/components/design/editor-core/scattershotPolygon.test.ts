import { describe, it, expect } from "vitest";
import { finalizeScattershotPolygon, SCATTERSHOT_MIN_POINT_DIST, SCATTERSHOT_MIN_POINTS } from "./scattershotPolygon";

describe("finalizeScattershotPolygon", () => {
  it("commits a clean triangle unchanged", () => {
    const raw = [0, 0, 10, 0, 5, 10];
    expect(finalizeScattershotPolygon(raw)).toEqual([0, 0, 10, 0, 5, 10]);
  });

  it("commits a clean quad unchanged", () => {
    const raw = [0, 0, 10, 0, 10, 10, 0, 10];
    expect(finalizeScattershotPolygon(raw)).toEqual([0, 0, 10, 0, 10, 10, 0, 10]);
  });

  it("cancels (returns null) with fewer than 3 distinct points — 0 points", () => {
    expect(finalizeScattershotPolygon([])).toBeNull();
  });

  it("cancels with 1 point", () => {
    expect(finalizeScattershotPolygon([5, 5])).toBeNull();
  });

  it("cancels with 2 distinct points (a line, not an area)", () => {
    expect(finalizeScattershotPolygon([0, 0, 10, 0])).toBeNull();
  });

  it("collapses consecutive near-duplicate clicks (accidental double-click) before counting", () => {
    // Second and third clicks land within SCATTERSHOT_MIN_POINT_DIST of each
    // other — should collapse to one point, leaving only 2 distinct points,
    // which cancels the draw.
    const raw = [0, 0, 10, 0, 10 + SCATTERSHOT_MIN_POINT_DIST / 2, 0];
    expect(finalizeScattershotPolygon(raw)).toBeNull();
  });

  it("a collapsed duplicate that still leaves 3+ distinct points commits", () => {
    const raw = [0, 0, 10, 0, 10 + SCATTERSHOT_MIN_POINT_DIST / 2, 0, 5, 10];
    expect(finalizeScattershotPolygon(raw)).toEqual([0, 0, 10, 0, 5, 10]);
  });

  it("drops a trailing point that lands near the first vertex (closing click landed just outside the snap radius)", () => {
    const raw = [0, 0, 10, 0, 5, 10, 0 + SCATTERSHOT_MIN_POINT_DIST / 2, 0 + SCATTERSHOT_MIN_POINT_DIST / 2];
    expect(finalizeScattershotPolygon(raw)).toEqual([0, 0, 10, 0, 5, 10]);
  });

  it("does not double-drop when the near-first-vertex point is itself needed to stay above the minimum", () => {
    // Only the closing near-duplicate plus 2 real points — dropping it must
    // still leave exactly 2, which cancels (not silently drop a real vertex
    // instead).
    const raw = [0, 0, 10, 0, 1, 1];
    expect(finalizeScattershotPolygon(raw)).toBeNull();
  });

  it("allows a self-crossing (bowtie) outline — not rejected", () => {
    // A classic bowtie: edges 0-1 and 2-3 cross.
    const raw = [0, 0, 10, 10, 10, 0, 0, 10];
    expect(finalizeScattershotPolygon(raw)).toEqual([0, 0, 10, 10, 10, 0, 0, 10]);
  });

  it("exposes the minimum-points constant used by the guard", () => {
    expect(SCATTERSHOT_MIN_POINTS).toBe(3);
  });
});
