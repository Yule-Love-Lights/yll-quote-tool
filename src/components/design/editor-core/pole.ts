import Konva from "konva";
import type { PoleItem } from "@/lib/design/sceneTypes";

// Real-world dimensions for the base shapes at the bottom of the pole. These
// are roughly the size of the wooden planters / wine barrels Jason uses in
// real installs (~16–20" wide, ~14–18" tall).
const BASE_WIDTH_IN = 18;
const BASE_HEIGHT_IN = 14;

// Pole shaft drawn this many pixels thick. Bumped per Jason's feedback —
// the thin 2.5px reads as a wire, not a pole. 4–5px reads as a real metal
// pole at typical zoom levels.
const POLE_STROKE_PX = 4.5;

// Renders a pole as a Konva.Group anchored at the BASE (item.x, item.y =
// ground contact point). The shaft extends upward by heightIn × pxPerFoot.
// Optional planter/barrel base sits at the bottom, suggesting the real-world
// portable weight that holds the pole up.
export function createPole(item: PoleItem, pxPerFoot: number): Konva.Group {
  const heightFt = item.heightIn / 12;
  const heightPx = Math.max(20, heightFt * pxPerFoot);
  const baseWidthPx = (BASE_WIDTH_IN / 12) * pxPerFoot;
  const baseHeightPx = (BASE_HEIGHT_IN / 12) * pxPerFoot;

  const group = new Konva.Group({
    id: item.id,
    x: item.x,
    y: item.y,
    name: "pole",
    listening: true,
    draggable: true,
  });

  // The pole shaft. Drawn FIRST so the base (added below) sits on top of
  // it and visually hides the lower portion — the pole appears to enter
  // the base box, matching real-world weighted planters.
  const shaft = new Konva.Line({
    points: [0, 0, 0, -heightPx],
    stroke: "#1f1f23",
    strokeWidth: POLE_STROKE_PX,
    lineCap: "round",
    listening: false,
  });
  group.add(shaft);

  // Small cap / attachment point at the top of the pole — visual cue for
  // where bistro spans hook on. Kept small so it doesn't dominate the
  // visual at modest zoom levels.
  const capRadius = Math.max(1.4, POLE_STROKE_PX * 0.45);
  const cap = new Konva.Circle({
    x: 0,
    y: -heightPx,
    radius: capRadius,
    fill: "#0d0d10",
    stroke: "#2a2a30",
    strokeWidth: 0.8,
    listening: false,
  });
  group.add(cap);

  // Optional base, drawn AFTER the shaft so it occludes the bottom portion
  // of the pole — the pole appears to be standing inside the planter/barrel.
  if (item.baseType === "cube") {
    // Wooden plank box — rectangular profile, warm-brown fill, darker stroke.
    const w = baseWidthPx;
    const h = baseHeightPx;
    const base = new Konva.Rect({
      x: -w / 2,
      y: -h,
      width: w,
      height: h,
      fill: "#6e4a2a",
      stroke: "#3a2614",
      strokeWidth: 1.5,
      cornerRadius: 2,
      listening: false,
    });
    group.add(base);
    // A couple of horizontal lines to suggest plank seams.
    for (let i = 1; i <= 2; i++) {
      const lineY = -h + (h * i) / 3;
      const seam = new Konva.Line({
        points: [-w / 2, lineY, w / 2, lineY],
        stroke: "#3a2614",
        strokeWidth: 0.8,
        opacity: 0.6,
        listening: false,
      });
      group.add(seam);
    }
  } else if (item.baseType === "barrel") {
    // Wine-barrel base — slightly bulgier ellipse profile with horizontal
    // stave hoops. Wider in the middle than at the top/bottom (real barrels).
    const w = baseWidthPx;
    const h = baseHeightPx;
    const body = new Konva.Ellipse({
      x: 0,
      y: -h / 2,
      radiusX: w / 2,
      radiusY: h / 2,
      fill: "#8a5a2c",
      stroke: "#3a2614",
      strokeWidth: 1.5,
      listening: false,
    });
    group.add(body);
    // Dark hoops near top and bottom.
    for (const yOff of [-h * 0.78, -h * 0.22]) {
      const hoop = new Konva.Line({
        points: [-w * 0.48, yOff, w * 0.48, yOff],
        stroke: "#1c1108",
        strokeWidth: 1.5,
        listening: false,
      });
      group.add(hoop);
    }
  }

  // Invisible click target covering the full footprint (shaft + base) so the
  // pole is easy to grab even at small zoom. Width is base width if there's a
  // base, otherwise a generous hit zone around the shaft.
  const hitWidth = Math.max(baseWidthPx, POLE_STROKE_PX * 6, 14);
  const hit = new Konva.Rect({
    x: -hitWidth / 2,
    y: -heightPx - capRadius * 2,
    width: hitWidth,
    height: heightPx + capRadius * 2 + (item.baseType === "none" ? 0 : baseHeightPx),
    fill: "rgba(0,0,0,0.001)",
    listening: true,
    name: "pole-hit",
  });
  group.add(hit);

  return group;
}
