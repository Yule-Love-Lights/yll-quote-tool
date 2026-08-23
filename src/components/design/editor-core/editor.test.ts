import { describe, it, expect } from "vitest";
import { isLineDrawContext } from "./drawContext";
import { sumMiniStringCount } from "./miniGroupBilling";
import type { StrandItem, MiniAreaItem } from "@/lib/design/sceneTypes";

// #203: unit coverage for the shared "line drawing" context gate that both
// editor.ts's isStrandDrawContext() (#63) and isTraceDrawContext() (#203)
// delegate to. This is the exact decision the mousedown handler's per-item
// guards read to decide whether a press that lands on an existing
// strand/garland/miniArea falls through into the draw pipeline or gets
// swallowed into a select. editor.ts itself imports Konva, whose Node
// entrypoint needs the optional `canvas` package (not installed here), so
// it can't be imported at all in this headless test environment — that's
// why this predicate lives in its own Konva-free module (drawContext.ts,
// mirroring the keymap.ts precedent) and why this file imports it directly
// rather than through editor.ts. The mousedown/mouseup wiring around the
// predicate is traced by reading, not executed here — see editor.ts's #203
// comments at isTraceDrawContext() and the mousedown handler's per-item
// guards.

// Baseline: draw mode, non-bistro lights, strand style — a valid
// strand-draw context (the pre-existing #63 case).
const base = {
  toolMode: "draw" as const,
  drawingStyle: "strand" as const,
  scattershot: false,
  category: "lights" as const,
  bulbType: "c9" as const, // any non-bistro bulb type
  decorType: "wreath" as const, // irrelevant unless category is "decor"
};

describe("isLineDrawContext", () => {
  // --- Leg 1: strand-over-strand (the original #63 fix — must not regress) ---
  it("strand-over-strand: strand style in draw mode on non-bistro lights is a strand-draw context", () => {
    expect(isLineDrawContext(base, "strand")).toBe(true);
  });

  // --- Legs 2 & 3: trace-over-strand / trace-over-trace (the #203 fix) ---
  // Committed trace segments are themselves kind:"strand" items rendered
  // with the same ".strand" class (see commitTraceSegments in editor.ts) —
  // so "trace-over-strand" and "trace-over-trace" hit the exact same
  // mousedown guard and are covered identically by this one predicate.
  it('trace-over-strand / trace-over-trace: trace style in draw mode on non-bistro lights is a trace-draw context', () => {
    expect(isLineDrawContext({ ...base, drawingStyle: "trace" }, "trace")).toBe(true);
  });

  it("the strand and trace gates are independent — one style's context never satisfies the other", () => {
    expect(isLineDrawContext({ ...base, drawingStyle: "trace" }, "strand")).toBe(false);
    expect(isLineDrawContext(base, "trace")).toBe(false); // base is drawingStyle: "strand"
  });

  it("garland drawing (Decor > Garland) is covered the same way as lights, for both styles", () => {
    const garlandTrace = {
      ...base,
      category: "decor" as const,
      decorType: "garland" as const,
      drawingStyle: "trace" as const,
    };
    expect(isLineDrawContext(garlandTrace, "trace")).toBe(true);
    expect(isLineDrawContext({ ...garlandTrace, drawingStyle: "strand" as const }, "strand")).toBe(true);
  });

  // --- Leg 4: selecting an existing item when NOT drawing must still work ---
  // (the obvious over-correction this fix must not introduce)
  it("select-tool mode is never a draw context, for either style — plain click-to-select must keep working", () => {
    expect(isLineDrawContext({ ...base, toolMode: "select" }, "strand")).toBe(false);
    expect(isLineDrawContext({ ...base, toolMode: "select", drawingStyle: "trace" }, "trace")).toBe(false);
  });

  it('"single" style drawing is never a strand or trace draw context', () => {
    expect(isLineDrawContext({ ...base, drawingStyle: "single" }, "strand")).toBe(false);
    expect(isLineDrawContext({ ...base, drawingStyle: "single" }, "trace")).toBe(false);
  });

  it("scattershot suppresses the context even when drawingStyle still reads strand/trace", () => {
    expect(isLineDrawContext({ ...base, scattershot: true }, "strand")).toBe(false);
    expect(isLineDrawContext({ ...base, scattershot: true, drawingStyle: "trace" }, "trace")).toBe(false);
  });

  it("bistro bulb type is excluded (bistro uses its own pole-to-pole span logic, not draw-over)", () => {
    expect(isLineDrawContext({ ...base, bulbType: "bistro" }, "strand")).toBe(false);
    expect(isLineDrawContext({ ...base, bulbType: "bistro", drawingStyle: "trace" }, "trace")).toBe(false);
  });

  it("non-garland decor (wreath/bow/spritzer) is never a line-draw context", () => {
    const wreathTrace = {
      ...base,
      category: "decor" as const,
      decorType: "wreath" as const,
      drawingStyle: "trace" as const,
    };
    const bowTrace = { ...wreathTrace, decorType: "bow" as const };
    const spritzerTrace = { ...wreathTrace, decorType: "spritzer" as const };
    expect(isLineDrawContext(wreathTrace, "trace")).toBe(false);
    expect(isLineDrawContext(bowTrace, "trace")).toBe(false);
    expect(isLineDrawContext(spritzerTrace, "trace")).toBe(false);
  });

  it("text/custom/poles categories are never a line-draw context", () => {
    expect(isLineDrawContext({ ...base, category: "text" as const, drawingStyle: "trace" as const }, "trace")).toBe(
      false,
    );
    expect(
      isLineDrawContext({ ...base, category: "custom" as const, drawingStyle: "trace" as const }, "trace"),
    ).toBe(false);
    expect(
      isLineDrawContext({ ...base, category: "poles" as const, drawingStyle: "trace" as const }, "trace"),
    ).toBe(false);
  });
});

// #334: editor.ts's groupSelectedMini seeds a new MiniGroupItem's billed
// stringCount from sumMiniStringCount (this module), the SUM of the grouped
// members' own counts — not just one member's, which silently dropped the
// other members' strings from the bill. Money-neutral by construction:
// grouping never changes the total billed string count.
const strand = (stringCount?: number): StrandItem => ({
  id: `s-${Math.random()}`,
  yardstickId: null,
  kind: "strand",
  bulbType: "mini",
  spacingIn: 6,
  drawingStyle: "strand",
  colorPattern: ["warm-white"],
  points: [0, 0, 10, 10],
  stringCount,
});
const miniArea = (stringCount?: number): MiniAreaItem => ({
  id: `a-${Math.random()}`,
  yardstickId: null,
  kind: "miniArea",
  shape: "box",
  stringCount,
});

describe("sumMiniStringCount", () => {
  it("sums a mixed strand + scattershot selection's own counts — the #334 bug (billed 1 of 5)", () => {
    // A 4-string scattershot grouped with a 1-string strand: the bug seeded
    // from the FIRST member alone (whichever the caller happened to pass
    // first) and silently billed 1, dropping 80% of the strings.
    expect(sumMiniStringCount([miniArea(4), strand(1)])).toBe(5);
    expect(sumMiniStringCount([strand(1), miniArea(4)])).toBe(5);
  });

  it("sums a strand-only selection", () => {
    expect(sumMiniStringCount([strand(2), strand(3), strand(1)])).toBe(6);
  });

  it("defaults an unset member stringCount to 1, same as the billed default elsewhere", () => {
    expect(sumMiniStringCount([strand(undefined), strand(2)])).toBe(3);
  });

  it("a single-member group still sums to that member's own count (no regression on the common case)", () => {
    expect(sumMiniStringCount([strand(3)])).toBe(3);
  });
});
