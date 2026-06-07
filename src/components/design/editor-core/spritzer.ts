import Konva from "konva";
import type { SpritzerItem } from "@/lib/design/sceneTypes";
import { colorOf } from "./colors";

// Procedurally renders a spritzer: a radial spray of glowing rays from a
// central point, each ray ending in a tip bulb, all blended onto the photo
// with `lighten` so it looks photoreal like the strand bulbs.
//
// Per-spritzer randomness (ray angles and lengths) is seeded by the item's
// id, so each spritzer renders identically every time even though it has a
// "natural" non-uniform spread.
export function createSpritzer(
  item: SpritzerItem,
  pxPerFoot: number,
): Konva.Group {
  const diameterFt = item.sizeIn / 12;
  const radiusPx = Math.max(20, (diameterFt * pxPerFoot) / 2);

  const group = new Konva.Group({
    id: item.id,
    x: item.x,
    y: item.y,
    name: "spritzer",
    listening: true,
    draggable: true,
  });

  const colors = item.colorPattern.length > 0 ? item.colorPattern : ["warm-white"];
  const isMulti = colors.length > 1;

  // Ray density scales gently with size; deliberately sparser than a
  // firework so individual tip dots read as distinct lights, not a wall.
  // 16" → ~18 rays, 24" → ~22, 36" → ~28, 48" → ~34.
  const numRays = Math.round(10 + item.sizeIn / 2);
  const rng = makeRng(item.id);

  // ----- Soft outer halo -----
  // For single-color: halo matches the color's glow tint.
  // For multi: warm-white-ish so we don't try to blend ten gradient stops.
  const haloHex = isMulti ? "#ffe6c0" : colorOf(colors[0]).glow;
  const halo = new Konva.Circle({
    radius: radiusPx,
    fillRadialGradientStartPoint: { x: 0, y: 0 },
    fillRadialGradientStartRadius: 0,
    fillRadialGradientEndPoint: { x: 0, y: 0 },
    fillRadialGradientEndRadius: radiusPx,
    fillRadialGradientColorStops: [
      0, hexA(haloHex, 0.32),
      0.4, hexA(haloHex, 0.16),
      0.8, hexA(haloHex, 0.04),
      1, hexA(haloHex, 0),
    ],
    globalCompositeOperation: "lighten",
    listening: false,
  });
  group.add(halo);

  // ----- Rays + tip bulbs -----
  const rayStroke = Math.max(0.6, radiusPx * 0.008);
  const tipRadius = Math.max(1.5, radiusPx * 0.028);
  const tipHaloRadius = tipRadius * 2.6;

  for (let i = 0; i < numRays; i++) {
    // Even angular spacing with a small per-ray jitter for organic look.
    const baseAngle = (i / numRays) * Math.PI * 2;
    const angle = baseAngle + (rng() - 0.5) * (Math.PI / numRays) * 0.9;
    // Length varies just 93%–101% of nominal radius so the tips form a
    // near-circular ring with only a hint of natural unevenness.
    const len = radiusPx * (0.93 + rng() * 0.08);
    const tipX = Math.cos(angle) * len;
    const tipY = Math.sin(angle) * len;

    const colorId = colors[i % colors.length];
    const color = colorOf(colorId);

    // Thin ray line, blended via lighten so it adds to the photo's brightness.
    const ray = new Konva.Line({
      points: [0, 0, tipX, tipY],
      stroke: color.hex,
      strokeWidth: rayStroke,
      opacity: 0.85,
      listening: false,
      globalCompositeOperation: "lighten",
    });
    group.add(ray);

    // Tip glow halo (soft, larger).
    const tipHalo = new Konva.Circle({
      x: tipX,
      y: tipY,
      radius: tipHaloRadius,
      fillRadialGradientStartPoint: { x: 0, y: 0 },
      fillRadialGradientStartRadius: 0,
      fillRadialGradientEndPoint: { x: 0, y: 0 },
      fillRadialGradientEndRadius: tipHaloRadius,
      fillRadialGradientColorStops: [
        0, hexA(color.hex, 0.9),
        0.35, hexA(color.hex, 0.4),
        1, hexA(color.hex, 0),
      ],
      globalCompositeOperation: "lighten",
      listening: false,
    });
    group.add(tipHalo);

    // Crisp bright tip dot.
    const tip = new Konva.Circle({
      x: tipX,
      y: tipY,
      radius: tipRadius,
      fillRadialGradientStartPoint: { x: 0, y: 0 },
      fillRadialGradientStartRadius: 0,
      fillRadialGradientEndPoint: { x: 0, y: 0 },
      fillRadialGradientEndRadius: tipRadius,
      fillRadialGradientColorStops: [
        0, color.glow,
        0.6, color.glow,
        1, color.hex,
      ],
      listening: false,
    });
    group.add(tip);
  }

  // ----- Bright central cluster -----
  // The ray bases all overlap at center but adding a small dense glow makes
  // the core read as a single bright source rather than a knot of lines.
  const centerHex = isMulti ? "#fff2d4" : colorOf(colors[0]).glow;
  const centerRadius = Math.max(4, radiusPx * 0.18);
  const center = new Konva.Circle({
    radius: centerRadius,
    fillRadialGradientStartPoint: { x: 0, y: 0 },
    fillRadialGradientStartRadius: 0,
    fillRadialGradientEndPoint: { x: 0, y: 0 },
    fillRadialGradientEndRadius: centerRadius,
    fillRadialGradientColorStops: [
      0, centerHex,
      0.4, hexA(centerHex, 0.7),
      1, hexA(centerHex, 0),
    ],
    globalCompositeOperation: "lighten",
    listening: false,
  });
  group.add(center);

  // Invisible disc covering the spritzer's footprint so clicks anywhere on
  // it register as a hit on this group.
  const hit = new Konva.Circle({
    radius: radiusPx * 1.05,
    fill: "rgba(0,0,0,0.001)",
    listening: true,
    name: "spritzer-hit",
  });
  group.add(hit);

  return group;
}

// Deterministic 0..1 pseudo-random generator. Seeded with the item ID so a
// given spritzer always renders identically across reloads / undo / etc.
// Mulberry32 — small, fast, good enough for visual jitter.
function makeRng(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexA(hex: string, alpha: number) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
