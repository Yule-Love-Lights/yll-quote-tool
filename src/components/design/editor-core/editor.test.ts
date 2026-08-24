import { describe, it, expect } from "vitest";
import { isLineDrawContext } from "./drawContext";
import { sumMiniStringCount, seedGroupStringCount } from "./miniGroupBilling";
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
// stringCount via seedGroupStringCount(members, fallback) — sumMiniStringCount
// (this module) is the underlying "sum the members' own counts" building
// block, used only when seedGroupStringCount's own trigger fires. See that
// describe block below for the actual per-call-site rule.
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

// #334 (conditional-seed revision): seedGroupStringCount is the function every
// groupSelectedMini call site actually calls. A prod sweep found 84% of
// grouped members (275/~327) sit at stringCount=1, the untouched default —
// staff routinely trace N segments, group them, then type the true count on
// the GROUP itself afterward (Julia Lee's group: 23 traced segments, staff
// typed 8). Unconditionally summing would seed 23 there, replacing a silent
// under-count with a silent OVER-count. So: sum only when at least one member
// carries an explicit count ABOVE 1 (the only usable signal — stringCount:1
// serializes identically whether staff set it or never touched it); otherwise
// return the caller's own historical fallback unchanged.
describe("seedGroupStringCount", () => {
  it("sums when a member carries an explicit count above 1 — the original row-334 bug (4-string scattershot + 1-string strand billed 1)", () => {
    const members = [miniArea(4), strand(1)];
    // Mirrors the "Group as one quote unit" buttons' own fallback shape
    // (members[0].stringCount ?? 1) — irrelevant here since the sum wins.
    expect(seedGroupStringCount(members, members[0].stringCount ?? 1)).toBe(5);
  });

  // THE OVER-BILL REGRESSION GUARD: many members, all still at the untouched
  // default — must seed the caller's OLD fallback (1, matching the "Group as
  // one quote unit" buttons' members[0].stringCount ?? 1 shape), NOT the
  // member count (25) and NOT the sum (25). Seeding 25 here is exactly the
  // silent over-bill the dev rejected the unconditional-sum version for.
  it("many members all at the default (no explicit count) seeds the caller's OLD fallback, NOT the member count", () => {
    const members = Array.from({ length: 25 }, () => strand(1)); // real prod shape: stringCount:1 serialized explicitly, same as untouched
    expect(seedGroupStringCount(members, members[0].stringCount ?? 1)).toBe(1); // NOT 25
  });

  // #334 FIX 2: the railing/curtain auto-group path (editor.ts's #sel-surface
  // change handler) falls back to sel.length, not members[0].stringCount —
  // confirm the sum still wins over THAT fallback when a real explicit count
  // is present (2 strands, staff-edited stringCount:3 each = 6 billed
  // strings; the old code seeded sel.length = 2, a 67% under-count).
  it("sums over the railing/curtain dropdown's sel.length fallback when strands carry explicit counts", () => {
    const members = [strand(3), strand(3)];
    expect(seedGroupStringCount(members, members.length)).toBe(6); // NOT sel.length (2)
  });

  // Same dropdown shape, but no member was ever touched — sel.length (3)
  // happens to equal the sum of three untouched defaults (1+1+1), so this
  // case can't distinguish "fallback preserved" from "summed anyway"; it just
  // confirms the ordinary un-edited path still seeds the expected number.
  it("the railing/curtain dropdown's ordinary un-edited case still seeds sel.length", () => {
    const members = [strand(1), strand(1), strand(1)];
    expect(seedGroupStringCount(members, members.length)).toBe(3);
  });

  it("an explicit count of exactly 1 does NOT trigger the sum — only strictly above 1 counts as staff-set", () => {
    const members = [strand(1), strand(undefined)];
    expect(seedGroupStringCount(members, members[0].stringCount ?? 1)).toBe(1); // fallback, not sum(2)
  });

  // KNOWN RESIDUAL (reported, not fixed — see the build report): the trigger
  // is "ANY member above 1", not "most members" or "all members". A single
  // stray explicit count amid a large otherwise-untouched group still flips
  // the WHOLE group to sum mode. Documented here as current, accepted
  // behavior — not asserted as correct, just pinned so a future change to the
  // trigger doesn't silently alter this case without a test noticing.
  it("a single outlier explicit count among many defaults still sums the whole group (documented residual)", () => {
    const members = [...Array.from({ length: 22 }, () => strand(1)), strand(2)];
    expect(seedGroupStringCount(members, members[0].stringCount ?? 1)).toBe(24); // 22*1 + 2, not the fallback (1)
  });
});
