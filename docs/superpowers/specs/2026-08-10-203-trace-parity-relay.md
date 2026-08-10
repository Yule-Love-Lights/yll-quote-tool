# #203 trace-draw parity — DESIGN-TOOL RELAY hunks

> Durable capture of the `editor-core/` changes that must be mirrored
> byte-identical into the standalone design tool
> (`C:\Users\Jason\Desktop\YuleLoveLights\Claude`, `client/src/pages/`), per the
> standing relay convention in `task_ledger.md` (#71/#73/Cool White/Stake/#82
> Slice 2b/#63 precedents).
>
> Generated from the REAL diff (`git diff origin/master...HEAD -- editor-core`),
> not transcribed by hand — a PR review flagged that the hunks previously
> lived only in an agent report, which is exactly the drift #203 itself
> exists to close (trace never got #63's fix because that change did not
> propagate uniformly).

## Provenance

- Branch: `jason/203-trace-draw-parity`
- Base: `11ce167f142bf8ea5be4c261614259271d23d8f1`
- Head: `b84a672075878fe68bb6e09e63325a2dcc6638c8`
- Prior related relay: #63's fix (`3df31b37`) was relayed at design-tool `28230bf`.

## Files

- NEW `editor-core/drawContext.ts` → design tool `client/src/pages/drawContext.ts`
  (place it beside their `keymap.ts`, matching the existing sibling-module convention).
- MODIFIED `editor-core/editor.ts` → design tool `client/src/pages/editor.ts`.

⚠️ The inline literal union types in `drawContext.ts` mirror `editor.ts`-local
types that are not exported. Confirm the design tool's own literals match
before pasting — a reviewer verified tsc DOES catch drift here in this repo
(the object-literal argument is structurally checked), so a mismatch will
surface as a type error rather than silently diverging.

## Verbatim diff

```diff
diff --git a/src/components/design/editor-core/drawContext.ts b/src/components/design/editor-core/drawContext.ts
new file mode 100644
index 00000000..0a5fc341
--- /dev/null
+++ b/src/components/design/editor-core/drawContext.ts
@@ -0,0 +1,36 @@
+// SHARED EDITOR CORE — keep byte-identical with the standalone design tool (relay).
+//
+// #203: shared gate for "line drawing" contexts — true when the active tool
+// is set up to click/drag/trace-draw lines of the given style (strand or
+// trace) in draw mode: lights (non-bistro) or garland, not scattershot.
+// editor.ts's isStrandDrawContext() (#63) and isTraceDrawContext() (#203)
+// both delegate to this ONE function (passing their own style) so the two
+// styles' gates can never drift apart again — trace silently missing the
+// #63 fix because it lived only in a strand-shaped closure inside editor.ts
+// is the exact bug #203 exists to close.
+//
+// Lives in its own module (mirrors the keymap.ts precedent) rather than
+// inside editor.ts because editor.ts imports Konva, which pulls in its
+// Node entrypoint's optional `canvas` dependency outside a browser — that
+// makes editor.ts itself unimportable in this repo's headless (Node,
+// non-jsdom) test environment. Keeping this predicate Konva-free is what
+// makes it unit-testable at all.
+export function isLineDrawContext(
+  state: {
+    toolMode: "draw" | "select";
+    drawingStyle: "strand" | "trace" | "single";
+    scattershot: boolean;
+    category: "lights" | "decor" | "text" | "custom" | "poles";
+    bulbType: "c9" | "mini" | "permanent" | "bistro";
+    decorType: "wreath" | "bow" | "garland" | "spritzer";
+  },
+  style: "strand" | "trace",
+): boolean {
+  return (
+    state.toolMode === "draw" &&
+    state.drawingStyle === style &&
+    !state.scattershot &&
+    ((state.category === "lights" && state.bulbType !== "bistro") ||
+      (state.category === "decor" && state.decorType === "garland"))
+  );
+}
diff --git a/src/components/design/editor-core/editor.test.ts b/src/components/design/editor-core/editor.test.ts
new file mode 100644
index 00000000..625d12b3
--- /dev/null
+++ b/src/components/design/editor-core/editor.test.ts
@@ -0,0 +1,108 @@
+import { describe, it, expect } from "vitest";
+import { isLineDrawContext } from "./drawContext";
+
+// #203: unit coverage for the shared "line drawing" context gate that both
+// editor.ts's isStrandDrawContext() (#63) and isTraceDrawContext() (#203)
+// delegate to. This is the exact decision the mousedown handler's per-item
+// guards read to decide whether a press that lands on an existing
+// strand/garland/miniArea falls through into the draw pipeline or gets
+// swallowed into a select. editor.ts itself imports Konva, whose Node
+// entrypoint needs the optional `canvas` package (not installed here), so
+// it can't be imported at all in this headless test environment — that's
+// why this predicate lives in its own Konva-free module (drawContext.ts,
+// mirroring the keymap.ts precedent) and why this file imports it directly
+// rather than through editor.ts. The mousedown/mouseup wiring around the
+// predicate is traced by reading, not executed here — see editor.ts's #203
+// comments at isTraceDrawContext() and the mousedown handler's per-item
+// guards.
+
+// Baseline: draw mode, non-bistro lights, strand style — a valid
+// strand-draw context (the pre-existing #63 case).
+const base = {
+  toolMode: "draw" as const,
+  drawingStyle: "strand" as const,
+  scattershot: false,
+  category: "lights" as const,
+  bulbType: "c9" as const, // any non-bistro bulb type
+  decorType: "wreath" as const, // irrelevant unless category is "decor"
+};
+
+describe("isLineDrawContext", () => {
+  // --- Leg 1: strand-over-strand (the original #63 fix — must not regress) ---
+  it("strand-over-strand: strand style in draw mode on non-bistro lights is a strand-draw context", () => {
+    expect(isLineDrawContext(base, "strand")).toBe(true);
+  });
+
+  // --- Legs 2 & 3: trace-over-strand / trace-over-trace (the #203 fix) ---
+  // Committed trace segments are themselves kind:"strand" items rendered
+  // with the same ".strand" class (see commitTraceSegments in editor.ts) —
+  // so "trace-over-strand" and "trace-over-trace" hit the exact same
+  // mousedown guard and are covered identically by this one predicate.
+  it('trace-over-strand / trace-over-trace: trace style in draw mode on non-bistro lights is a trace-draw context', () => {
+    expect(isLineDrawContext({ ...base, drawingStyle: "trace" }, "trace")).toBe(true);
+  });
+
+  it("the strand and trace gates are independent — one style's context never satisfies the other", () => {
+    expect(isLineDrawContext({ ...base, drawingStyle: "trace" }, "strand")).toBe(false);
+    expect(isLineDrawContext(base, "trace")).toBe(false); // base is drawingStyle: "strand"
+  });
+
+  it("garland drawing (Decor > Garland) is covered the same way as lights, for both styles", () => {
+    const garlandTrace = {
+      ...base,
+      category: "decor" as const,
+      decorType: "garland" as const,
+      drawingStyle: "trace" as const,
+    };
+    expect(isLineDrawContext(garlandTrace, "trace")).toBe(true);
+    expect(isLineDrawContext({ ...garlandTrace, drawingStyle: "strand" as const }, "strand")).toBe(true);
+  });
+
+  // --- Leg 4: selecting an existing item when NOT drawing must still work ---
+  // (the obvious over-correction this fix must not introduce)
+  it("select-tool mode is never a draw context, for either style — plain click-to-select must keep working", () => {
+    expect(isLineDrawContext({ ...base, toolMode: "select" }, "strand")).toBe(false);
+    expect(isLineDrawContext({ ...base, toolMode: "select", drawingStyle: "trace" }, "trace")).toBe(false);
+  });
+
+  it('"single" style drawing is never a strand or trace draw context', () => {
+    expect(isLineDrawContext({ ...base, drawingStyle: "single" }, "strand")).toBe(false);
+    expect(isLineDrawContext({ ...base, drawingStyle: "single" }, "trace")).toBe(false);
+  });
+
+  it("scattershot suppresses the context even when drawingStyle still reads strand/trace", () => {
+    expect(isLineDrawContext({ ...base, scattershot: true }, "strand")).toBe(false);
+    expect(isLineDrawContext({ ...base, scattershot: true, drawingStyle: "trace" }, "trace")).toBe(false);
+  });
+
+  it("bistro bulb type is excluded (bistro uses its own pole-to-pole span logic, not draw-over)", () => {
+    expect(isLineDrawContext({ ...base, bulbType: "bistro" }, "strand")).toBe(false);
+    expect(isLineDrawContext({ ...base, bulbType: "bistro", drawingStyle: "trace" }, "trace")).toBe(false);
+  });
+
+  it("non-garland decor (wreath/bow/spritzer) is never a line-draw context", () => {
+    const wreathTrace = {
+      ...base,
+      category: "decor" as const,
+      decorType: "wreath" as const,
+      drawingStyle: "trace" as const,
+    };
+    const bowTrace = { ...wreathTrace, decorType: "bow" as const };
+    const spritzerTrace = { ...wreathTrace, decorType: "spritzer" as const };
+    expect(isLineDrawContext(wreathTrace, "trace")).toBe(false);
+    expect(isLineDrawContext(bowTrace, "trace")).toBe(false);
+    expect(isLineDrawContext(spritzerTrace, "trace")).toBe(false);
+  });
+
+  it("text/custom/poles categories are never a line-draw context", () => {
+    expect(isLineDrawContext({ ...base, category: "text" as const, drawingStyle: "trace" as const }, "trace")).toBe(
+      false,
+    );
+    expect(
+      isLineDrawContext({ ...base, category: "custom" as const, drawingStyle: "trace" as const }, "trace"),
+    ).toBe(false);
+    expect(
+      isLineDrawContext({ ...base, category: "poles" as const, drawingStyle: "trace" as const }, "trace"),
+    ).toBe(false);
+  });
+});
diff --git a/src/components/design/editor-core/editor.ts b/src/components/design/editor-core/editor.ts
index 14699824..f0fa2b93 100644
--- a/src/components/design/editor-core/editor.ts
+++ b/src/components/design/editor-core/editor.ts
@@ -19,6 +19,7 @@ import { renderMiniArea } from "./miniArea";
 import { preloadAssets } from "./assets";
 import { renderYardstick, pxPerFoot, yardstickLabel } from "./yardstick";
 import { DEFAULT_KEYMAP, resolveAction, type KeyMap } from "./keymap";
+import { isLineDrawContext } from "./drawContext";
 
 // Default real-world width for newly-placed custom uploads — about 3 feet,
 // big enough to spot on the photo, small enough to resize down with the
@@ -4612,11 +4613,47 @@ export async function renderEditor(
   // select-guards are bypassed. Read live; the tool-change handlers redrawScene()
   // so the draggable flag this gates stays fresh across tool switches.
   function isStrandDrawContext(): boolean {
-    return (
-      toolMode === "draw" &&
-      tool.drawingStyle === "strand" &&
-      !tool.scattershot &&
-      ((tool.category === "lights" && tool.bulbType !== "bistro") || drawingGarland())
+    return isLineDrawContext(
+      {
+        toolMode,
+        drawingStyle: tool.drawingStyle,
+        scattershot: tool.scattershot,
+        category: tool.category,
+        bulbType: tool.bulbType,
+        decorType: tool.decorType,
+      },
+      "strand",
+    );
+  }
+
+  // #203: mirrors isStrandDrawContext() (#63) for the "trace" style, via the
+  // same isLineDrawContext() gate (see drawContext.ts for why the two
+  // deliberately share one function instead of two copies that could drift
+  // apart again). Used ONLY at the mousedown per-item-guard site below, to
+  // let the very FIRST click of a fresh trace fall through into the
+  // trace-start pipeline when it lands on an existing strand/garland/
+  // miniArea — trace's own pre-existing `!tracePts` exception already
+  // covers every click AFTER the first (continuing an in-progress trace);
+  // this closes the gap for the first one, where tracePts is still null.
+  // Deliberately NOT wired into isStrandDrawContext()'s other call sites
+  // (draggable(false), the item click-handler bypass, the drawOverItemId /
+  // mouseup drag-distance decision) — those implement strand's click-vs-
+  // drag disambiguation, which doesn't fit trace's multi-click accumulation
+  // model (traced through: routing trace over drawOverItemId would fire
+  // selectDrawOverItem() and an unconditional redrawScene() on mouseup,
+  // destroying the live trace preview node and mis-selecting the traced-
+  // over item mid-gesture).
+  function isTraceDrawContext(): boolean {
+    return isLineDrawContext(
+      {
+        toolMode,
+        drawingStyle: tool.drawingStyle,
+        scattershot: tool.scattershot,
+        category: tool.category,
+        bulbType: tool.bulbType,
+        decorType: tool.decorType,
+      },
+      "trace",
     );
   }
 
@@ -4718,8 +4755,13 @@ export async function renderEditor(
       // fall through to the draw pipeline below (skip the per-item return-guards).
     } else {
       // Click on a strand group — selection handler runs; suppress draw. EXCEPT
-      // when a trace polyline is in progress: that click must continue the trace.
-      if (e.target.findAncestor(".strand", true) && !tracePts) return;
+      // when a trace polyline is in progress: that click must continue the
+      // trace. #203: OR when a fresh trace is about to START on top of it —
+      // mirrors the same exception for the very first click, which used to be
+      // swallowed here because tracePts is still null at that instant (the
+      // pre-existing !tracePts exception only ever covered clicks AFTER the
+      // first one).
+      if (e.target.findAncestor(".strand", true) && !tracePts && !isTraceDrawContext()) return;
 
       // Click on an existing wreath — let its click handler select it; don't draw.
       if (e.target.findAncestor(".wreath", true)) return;
@@ -4728,8 +4770,9 @@ export async function renderEditor(
       if (e.target.findAncestor(".bow", true)) return;
 
       // Click on an existing garland — let its click handler select it; don't draw.
-      // (Exception while a trace is in progress, same as for strands.)
-      if (e.target.findAncestor(".garland", true) && !tracePts) return;
+      // (Exception while a trace is in progress, or about to start — #203 — same
+      // as for strands.)
+      if (e.target.findAncestor(".garland", true) && !tracePts && !isTraceDrawContext()) return;
 
       // Click on an existing spritzer — same deal as wreath/bow.
       if (e.target.findAncestor(".spritzer", true)) return;
@@ -4737,8 +4780,9 @@ export async function renderEditor(
       // Click on an existing mini-light area — let its click handler select it;
       // don't fall through to the place/draw pipeline (which would drop a
       // duplicate box and destroy the pressed group mid-gesture). Same trace
-      // exception as strands/garlands: mid-trace clicks continue the polyline.
-      if (e.target.findAncestor(".miniArea", true) && !tracePts) return;
+      // exception as strands/garlands (continuing OR about to start — #203):
+      // mid-trace clicks continue the polyline.
+      if (e.target.findAncestor(".miniArea", true) && !tracePts && !isTraceDrawContext()) return;
 
       // Click on an existing text item — same.
       if (e.target.findAncestor(".text", true)) return;
```
