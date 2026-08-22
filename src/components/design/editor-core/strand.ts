import Konva from "konva";
import type { Strand } from "@/lib/design/sceneTypes";
import { createBulb } from "./bulb";
import { LIGHT_SCALE_DEFAULT } from "./lightScale";
import { createPermanentLight, PERM_DEFAULTS } from "./permanent";

// Default catenary sag for bistro strands when sagFactor is not set on the
// item. Expressed as a fraction of the horizontal span — 0.10 ≈ a typical
// real-world droop. Vertical spans (dx → 0) naturally produce ~0 sag since
// sag = sagFactor * |dx|, which matches reality (taut vertical cables).
export const DEFAULT_BISTRO_SAG = 0.10;

export function renderStrand(
  strand: Strand,
  pxPerFoot: number,
  lightScale: number = LIGHT_SCALE_DEFAULT,
): Konva.Group {
  const group = new Konva.Group({
    id: strand.id,
    listening: true,
    name: "strand",
  });
  group.setAttr("strandData", strand);

  if (strand.points.length < 2) return group;

  const isBistro = strand.bulbType === "bistro";
  const sagFactor = strand.sagFactor ?? DEFAULT_BISTRO_SAG;

  // Invisible thick line for selection / hit-testing. For bistro the bulbs
  // and cord follow the sagging catenary, so the hit line must follow that
  // same curve — otherwise clicks land on the straight chord (above the sag)
  // and only register near the taut ends. For non-bistro the chord IS the path.
  const hitPoints =
    isBistro && strand.points.length >= 4
      ? bistroCurvePoints(strand.points, sagFactor)
      : strand.points;
  const hit = new Konva.Line({
    points: hitPoints,
    stroke: "rgba(0,0,0,0.001)",
    strokeWidth: 1,
    hitStrokeWidth: 28,
    lineCap: "round",
    lineJoin: "round",
    listening: true,
  });
  group.add(hit);

  if (strand.drawingStyle === "single") {
    placeBulb(group, strand, strand.points[0], strand.points[1], pxPerFoot, 0, lightScale);
    return group;
  }

  // For bistro, draw the faint dark cord along the catenary curve first so
  // it sits behind the bulbs. Sampled in ~24 segments per chord for smooth
  // curve appearance.
  if (isBistro) {
    drawBistroCord(group, strand.points, sagFactor);
  }

  // Walk the polyline, dropping bulbs at intervals of `spacingIn`. For
  // non-bistro the path is a straight chord; for bistro it's a parabolic
  // catenary that sags by `sagFactor * |dx|` at the chord midpoint.
  const spacingFt = strand.spacingIn / 12;
  const spacingPx = spacingFt * pxPerFoot;

  let distRemaining = 0;
  let bulbIndex = 0;

  for (let i = 0; i < strand.points.length - 2; i += 2) {
    const x1 = strand.points[i];
    const y1 = strand.points[i + 1];
    const x2 = strand.points[i + 2];
    const y2 = strand.points[i + 3];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const segLen = Math.hypot(dx, dy);
    if (segLen === 0) continue;
    // Sag is in screen-down (+y) direction, peaking at t=0.5. Proportional
    // to the horizontal span so vertical strands stay taut.
    const sagPx = isBistro ? Math.abs(dx) * sagFactor : 0;

    let traveled = -distRemaining;
    while (traveled <= segLen) {
      if (traveled >= 0) {
        const t = traveled / segLen;
        const chordX = x1 + dx * t;
        const chordY = y1 + dy * t;
        const yOffset = isBistro ? sagPx * 4 * t * (1 - t) : 0;
        placeBulb(group, strand, chordX, chordY + yOffset, pxPerFoot, bulbIndex++, lightScale);
      }
      traveled += spacingPx;
    }
    distRemaining = traveled - segLen;
  }

  return group;
}

// Samples the catenary curve across every chord segment of the polyline into
// a single flat [x,y,x,y,...] array. Used for both the visible cord and the
// invisible hit line so clicking the sagging rope (not just its straight
// chord) selects the strand.
export function bistroCurvePoints(points: number[], sagFactor: number): number[] {
  const SAMPLES = 24; // per segment; Konva interpolates linearly between samples
  const out: number[] = [];
  for (let i = 0; i < points.length - 2; i += 2) {
    const x1 = points[i];
    const y1 = points[i + 1];
    const x2 = points[i + 2];
    const y2 = points[i + 3];
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (Math.hypot(dx, dy) === 0) continue;
    const sagPx = Math.abs(dx) * sagFactor;
    // Skip the first sample on later segments to avoid duplicating the shared vertex.
    const startS = out.length === 0 ? 0 : 1;
    for (let s = startS; s <= SAMPLES; s++) {
      const t = s / SAMPLES;
      out.push(x1 + dx * t, y1 + dy * t + sagPx * 4 * t * (1 - t));
    }
  }
  return out;
}

// Draws the faint dark cord along the catenary. Added BEFORE the bulbs so they
// sit on top.
function drawBistroCord(group: Konva.Group, points: number[], sagFactor: number) {
  if (points.length < 4) return;
  const cord = new Konva.Line({
    points: bistroCurvePoints(points, sagFactor),
    stroke: "rgba(20, 20, 20, 0.6)",
    strokeWidth: 1.2,
    lineCap: "round",
    lineJoin: "round",
    listening: false,
  });
  group.add(cord);
}

function placeBulb(
  parent: Konva.Group,
  strand: Strand,
  x: number,
  y: number,
  pxPerFoot: number,
  index: number,
  lightScale: number = LIGHT_SCALE_DEFAULT,
) {
  const palette =
    strand.colorPattern.length > 0 ? strand.colorPattern : ["warm-white"];
  const colorId = palette[index % palette.length];
  const node =
    strand.bulbType === "permanent"
      ? createPermanentLight(
          colorId,
          pxPerFoot,
          strand.beamLengthFt ?? PERM_DEFAULTS.beamLengthFt,
          strand.beamWidthFt ?? PERM_DEFAULTS.beamWidthFt,
          strand.distanceToSurfaceFt ?? PERM_DEFAULTS.distanceToSurfaceFt,
          strand.opacity ?? PERM_DEFAULTS.opacity,
          strand.showCoverage ?? PERM_DEFAULTS.showCoverage,
          strand.showBeam ?? PERM_DEFAULTS.showBeam,
          lightScale,
        )
      : createBulb(strand.bulbType, colorId, pxPerFoot, lightScale);
  node.position({ x, y });
  parent.add(node);
}

export function strandLengthPx(strand: Strand): number {
  let total = 0;
  for (let i = 0; i < strand.points.length - 2; i += 2) {
    total += Math.hypot(
      strand.points[i + 2] - strand.points[i],
      strand.points[i + 3] - strand.points[i + 1],
    );
  }
  return total;
}
