// SHARED EDITOR CORE — keep byte-identical with the standalone design tool (relay).
//
// Pure geometry for the "click points, close the outline" polygon-drawing
// path of the Scattershot tool (a MiniAreaItem with shape:"polygon" — see
// sceneTypes.ts). Box scattershot stays a drag-a-rect gesture; this module
// only covers the new click-to-place-points alternative.
//
// Lives in its own Konva-free module (mirrors the drawContext.ts precedent)
// because editor.ts imports Konva, which pulls in its Node entrypoint's
// optional `canvas` dependency outside a browser — that makes editor.ts
// itself unimportable in this repo's headless (Node, non-jsdom) test
// environment. Keeping this predicate Konva-free is what makes it unit-
// testable at all.

// Minimum distance (in image px) between two clicks for them to count as
// distinct points. Mirrors editor.ts's existing 4px zero-length-segment
// guard on trace-drawn strand/garland segments (commitTraceSegments /
// commitGarlandTraceSegments) — same idea, same threshold, applied to a
// polygon's vertices instead of a polyline's segments.
export const SCATTERSHOT_MIN_POINT_DIST = 4;

// Minimum number of distinct vertices for a valid area (a polygon needs at
// least 3 to enclose any space). Below this the draw is cancelled, not
// committed — mirrors commitStrand's "need at least 2 distinct points"
// guard, one point higher because a polygon (not a line) is being closed.
export const SCATTERSHOT_MIN_POINTS = 3;

// Turn a raw click stream (flat [x0,y0,x1,y1,...], one pair per committed
// click, cursor-tracking pair already stripped by the caller) into a valid,
// auto-closed polygon point list, or null when the draw should be cancelled
// instead of committed.
//
// - Collapses consecutive near-duplicate clicks (an accidental double-click
//   at the same spot) into one point.
// - Drops a trailing point that landed near the first vertex — the "click
//   near the first point to close" gesture re-clicks close to vertex 0,
//   which would otherwise leave a near-duplicate closing vertex right next
//   to the real one. `points` is stored open (no repeated closing vertex);
//   the renderer auto-closes it (see sceneTypes.ts's MiniAreaItem.points
//   comment and miniArea.ts's resolveShape/outline).
// - Self-intersecting outlines (a "bowtie") are ALLOWED, deliberately not
//   rejected: a staff member tracing an irregular bush by eye can easily
//   nick back across an earlier edge on a real photo, the renderer's
//   even-odd point-in-polygon fill (miniArea.ts's pointInPolygon) and
//   shoelace area (polygonAreaPx) both already handle a self-crossing
//   outline without erroring, and a simple-polygon check would need an
//   O(n^2) segment-intersection pass on every commit for a benefit staff
//   would rarely hit on purpose. Rejecting would only add friction.
// - Fewer than SCATTERSHOT_MIN_POINTS distinct points after dedup returns
//   null (cancelled, not committed) — same spirit as a box scattershot's
//   drag being too small to count as a real box.
export function finalizeScattershotPolygon(rawPoints: number[]): number[] | null {
  const pts: number[] = [];
  for (let i = 0; i + 1 < rawPoints.length; i += 2) {
    const x = rawPoints[i];
    const y = rawPoints[i + 1];
    if (pts.length >= 2) {
      const dx = x - pts[pts.length - 2];
      const dy = y - pts[pts.length - 1];
      if (Math.hypot(dx, dy) < SCATTERSHOT_MIN_POINT_DIST) continue; // accidental rapid click at (near) the same spot — see the triple-click-to-finish helper below
    }
    pts.push(x, y);
  }
  // Drop a final point that's a near-duplicate of the first vertex (a
  // closing click that landed just outside the "snap to close" radius).
  if (pts.length >= 4) {
    const dx = pts[pts.length - 2] - pts[0];
    const dy = pts[pts.length - 1] - pts[1];
    if (Math.hypot(dx, dy) < SCATTERSHOT_MIN_POINT_DIST) {
      pts.pop();
      pts.pop();
    }
  }
  if (pts.length / 2 < SCATTERSHOT_MIN_POINTS) return null;
  return pts;
}

// Rapid-click window, in ms, for the "triple-click to finish" gesture that
// replaces double-click (double-click already means DELETE elsewhere in
// this editor — see the item click handlers — so double-click-to-finish
// collided with that muscle memory). Matches Konva's own dblClickWindow
// default (node_modules/konva/lib/Global.js) so the gesture feels the same
// speed as every other rapid-click gesture in the editor.
export const SCATTERSHOT_FINISH_CLICK_WINDOW_MS = 400;

// How many rapid, same-spot clicks finish an in-progress polygon outline.
export const SCATTERSHOT_FINISH_CLICK_COUNT = 3;

export interface ScattershotClickStreak {
  count: number;
  at: number;
  x: number;
  y: number;
}

// Given the previous click in a same-spot rapid-click streak (or null when
// there isn't one yet) and the current click's time and position, returns
// the streak state AFTER this click. A click starts a fresh streak (count
// 1) whenever it lands outside the time window OR more than
// SCATTERSHOT_MIN_POINT_DIST away from the previous click — reusing that
// same "same spot" threshold keeps streak detection in agreement with
// finalizeScattershotPolygon's vertex dedup above about what counts as "the
// same spot", so a genuine multi-click streak is exactly the run of clicks
// that dedup would collapse to one vertex anyway.
export function trackScattershotClick(
  prev: ScattershotClickStreak | null,
  now: number,
  x: number,
  y: number,
  windowMs: number = SCATTERSHOT_FINISH_CLICK_WINDOW_MS,
): ScattershotClickStreak {
  const continuesStreak =
    prev !== null &&
    now - prev.at <= windowMs &&
    Math.hypot(x - prev.x, y - prev.y) <= SCATTERSHOT_MIN_POINT_DIST;
  return { count: continuesStreak ? prev!.count + 1 : 1, at: now, x, y };
}
