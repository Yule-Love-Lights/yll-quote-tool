// SHARED EDITOR CORE — keep byte-identical with the standalone design tool (relay).
//
// #203: shared gate for "line drawing" contexts — true when the active tool
// is set up to click/drag/trace-draw lines of the given style (strand or
// trace) in draw mode: lights (non-bistro) or garland, not scattershot.
// editor.ts's isStrandDrawContext() (#63) and isTraceDrawContext() (#203)
// both delegate to this ONE function (passing their own style) so the two
// styles' gates can never drift apart again — trace silently missing the
// #63 fix because it lived only in a strand-shaped closure inside editor.ts
// is the exact bug #203 exists to close.
//
// Lives in its own module (mirrors the keymap.ts precedent) rather than
// inside editor.ts because editor.ts imports Konva, which pulls in its
// Node entrypoint's optional `canvas` dependency outside a browser — that
// makes editor.ts itself unimportable in this repo's headless (Node,
// non-jsdom) test environment. Keeping this predicate Konva-free is what
// makes it unit-testable at all.
export function isLineDrawContext(
  state: {
    toolMode: "draw" | "select";
    drawingStyle: "strand" | "trace" | "single";
    scattershot: boolean;
    category: "lights" | "decor" | "text" | "custom" | "poles";
    bulbType: "c9" | "mini" | "permanent" | "bistro";
    decorType: "wreath" | "bow" | "garland" | "spritzer";
  },
  style: "strand" | "trace",
): boolean {
  return (
    state.toolMode === "draw" &&
    state.drawingStyle === style &&
    !state.scattershot &&
    ((state.category === "lights" && state.bulbType !== "bistro") ||
      (state.category === "decor" && state.decorType === "garland"))
  );
}
