import { describe, it, expect } from "vitest";
import {
  finalizeScattershotPolygon,
  SCATTERSHOT_MIN_POINT_DIST,
  SCATTERSHOT_MIN_POINTS,
  trackScattershotClick,
  SCATTERSHOT_FINISH_CLICK_COUNT,
  SCATTERSHOT_FINISH_CLICK_WINDOW_MS,
} from "./scattershotPolygon";

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

describe("trackScattershotClick", () => {
  it("starts a streak of 1 when there is no previous click", () => {
    const s = trackScattershotClick(null, 1000, 0, 0);
    expect(s).toEqual({ count: 1, at: 1000, x: 0, y: 0 });
  });

  it("extends the streak when the next click is fast and at the same spot", () => {
    const s1 = trackScattershotClick(null, 1000, 100, 100);
    const s2 = trackScattershotClick(s1, 1100, 101, 101);
    const s3 = trackScattershotClick(s2, 1200, 100, 102);
    expect(s2.count).toBe(2);
    expect(s3.count).toBe(3);
  });

  it("resets to a streak of 1 when the gap exceeds the click window", () => {
    const s1 = trackScattershotClick(null, 1000, 100, 100);
    const s2 = trackScattershotClick(s1, 1000 + SCATTERSHOT_FINISH_CLICK_WINDOW_MS + 1, 100, 100);
    expect(s2.count).toBe(1);
  });

  it("resets to a streak of 1 when the click lands far from the previous one, even if fast", () => {
    const s1 = trackScattershotClick(null, 1000, 0, 0);
    // Just outside the "same spot" dedup radius.
    const s2 = trackScattershotClick(s1, 1010, SCATTERSHOT_MIN_POINT_DIST + 1, 0);
    expect(s2.count).toBe(1);
  });

  it("stays within the click window at the exact boundary (inclusive)", () => {
    const s1 = trackScattershotClick(null, 1000, 0, 0);
    const s2 = trackScattershotClick(s1, 1000 + SCATTERSHOT_FINISH_CLICK_WINDOW_MS, 0, 0);
    expect(s2.count).toBe(2);
  });

  it("three normal-pace clicks placing separate vertices never reach the finish count", () => {
    // Simulates a staff member placing 3 distinct vertices around a real
    // outline at a deliberate (non-rapid) pace — must not accidentally
    // finish the shape early.
    let streak = trackScattershotClick(null, 0, 0, 0);
    streak = trackScattershotClick(streak, 800, 50, 0);
    streak = trackScattershotClick(streak, 1600, 50, 50);
    expect(streak.count).toBeLessThan(SCATTERSHOT_FINISH_CLICK_COUNT);
  });

  it("three rapid same-spot clicks reach the finish count", () => {
    let streak = trackScattershotClick(null, 0, 10, 10);
    streak = trackScattershotClick(streak, 50, 10, 10);
    streak = trackScattershotClick(streak, 100, 10, 10);
    expect(streak.count).toBe(SCATTERSHOT_FINISH_CLICK_COUNT);
  });

  it("exposes the finish-click-count and window constants", () => {
    expect(SCATTERSHOT_FINISH_CLICK_COUNT).toBe(3);
    expect(SCATTERSHOT_FINISH_CLICK_WINDOW_MS).toBe(400);
  });

  it("a full triple-click-to-finish sequence commits the outline the user drew, not 3 degenerate vertices at the finish spot", () => {
    // Mirrors what editor.ts's mid-outline mousedown handler actually builds:
    // 3 real vertices placed at a normal pace, then a rapid same-spot triple
    // click to finish. Each of the 3 finishing clicks commits its own
    // near-duplicate vertex (same as double-click used to commit 2), and
    // finishScattershotDraw drops only the trailing cursor-tracking pair —
    // so this is the exact raw point list finalizeScattershotPolygon sees.
    const v1 = { x: 0, y: 0 };
    const v2 = { x: 50, y: 0 };
    const v3 = { x: 50, y: 50 };
    const v4 = { x: 0, y: 50 }; // where the triple-click lands, twice more

    let streak = trackScattershotClick(null, 0, v2.x, v2.y); // click 2 (v1 came from the opening click)
    streak = trackScattershotClick(streak, 800, v3.x, v3.y); // click 3, deliberate pace
    streak = trackScattershotClick(streak, 1600, v4.x, v4.y); // click 4, starts the finishing cluster
    expect(streak.count).toBeLessThan(SCATTERSHOT_FINISH_CLICK_COUNT);
    streak = trackScattershotClick(streak, 1630, v4.x, v4.y); // click 5, rapid + same spot
    expect(streak.count).toBe(2);
    streak = trackScattershotClick(streak, 1660, v4.x, v4.y); // click 6, rapid + same spot
    expect(streak.count).toBe(SCATTERSHOT_FINISH_CLICK_COUNT); // finish fires here

    // Raw stream editor.ts would hand to commitScattershotPolygon at that
    // point: v1, v2, v3, then v4 committed three times (once per finishing
    // click), trailing cursor pair already stripped.
    const raw = [v1.x, v1.y, v2.x, v2.y, v3.x, v3.y, v4.x, v4.y, v4.x, v4.y, v4.x, v4.y];
    expect(finalizeScattershotPolygon(raw)).toEqual([v1.x, v1.y, v2.x, v2.y, v3.x, v3.y, v4.x, v4.y]);
  });
});
