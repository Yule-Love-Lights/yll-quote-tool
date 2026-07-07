import Konva from "konva";
import { colorOf } from "./colors";

// Defaults tuned to match real perm-light installs and Jason's preferred look.
export const PERM_DEFAULTS = {
  beamLengthFt: 4,
  beamWidthFt: 1.7,
  distanceToSurfaceFt: 0,
  opacity: 1,
  showCoverage: false,
  showBeam: true,
} as const;

export function createPermanentLight(
  colorId: string,
  pxPerFoot: number,
  beamLengthFt: number,
  beamWidthFt: number,
  distanceToSurfaceFt: number,
  opacity: number,
  showCoverage: boolean,
  showBeam: boolean,
): Konva.Group {
  const color = colorOf(colorId);
  const beamLength = Math.max(8, beamLengthFt * pxPerFoot);
  const beamWidth = Math.max(4, beamWidthFt * pxPerFoot);
  const distanceToSurface = Math.max(0, distanceToSurfaceFt * pxPerFoot);
  const fixtureRadius = Math.max(1.5, 0.04 * pxPerFoot);

  const group = new Konva.Group({ listening: false, opacity });

  // Geometry: cone hangs DOWN from the fixture (always +Y in image space).
  // Narrow at the top, wider at the bottom, like a spotlight beam.
  const coneStartY = distanceToSurface;
  const coneEndY = coneStartY + beamLength;
  const topHalf = (beamWidth * 0.28) / 2;
  const botHalf = beamWidth / 2;

  // --- The beam — a single trapezoidal cone with a smooth vertical fade.
  //     No double-cone outline; just one shape with a single gradient.
  //     #88: skippable per strand (showBeam=false = just the puck dots). ---
  if (showBeam) {
  const beam = new Konva.Shape({
    sceneFunc: (ctx, shape) => {
      ctx.beginPath();
      ctx.moveTo(-topHalf, coneStartY);
      ctx.lineTo(-botHalf, coneEndY);
      ctx.lineTo(botHalf, coneEndY);
      ctx.lineTo(topHalf, coneStartY);
      ctx.closePath();
      ctx.fillStrokeShape(shape);
    },
    fillLinearGradientStartPoint: { x: 0, y: coneStartY },
    fillLinearGradientEndPoint: { x: 0, y: coneEndY },
    fillLinearGradientColorStops: [
      0, hexA(color.glow, 0.75),
      0.2, hexA(color.hex, 0.5),
      0.6, hexA(color.hex, 0.18),
      1, hexA(color.hex, 0),
    ],
    globalCompositeOperation: "lighten",
    listening: false,
  });
  group.add(beam);
  }

  // --- 3. Floor wash — soft horizontal smear where the beam lands.
  //        Optional — user can hide this if they want a "spotlight only" look.
  if (showCoverage) {
    const floor = new Konva.Ellipse({
      x: 0,
      y: coneEndY,
      radiusX: botHalf * 1.2,
      radiusY: botHalf * 0.18,
      fillRadialGradientStartPoint: { x: 0, y: 0 },
      fillRadialGradientStartRadius: 0,
      fillRadialGradientEndPoint: { x: 0, y: 0 },
      fillRadialGradientEndRadius: botHalf * 1.2,
      fillRadialGradientColorStops: [
        0, hexA(color.glow, 0.55),
        0.5, hexA(color.hex, 0.22),
        1, hexA(color.hex, 0),
      ],
      globalCompositeOperation: "lighten",
      listening: false,
    });
    group.add(floor);
  }

  // --- 4. Fixture body — small bright LED puck at the top of the cone. ---
  const fixture = new Konva.Circle({
    radius: fixtureRadius,
    fillRadialGradientStartPoint: { x: 0, y: 0 },
    fillRadialGradientStartRadius: 0,
    fillRadialGradientEndPoint: { x: 0, y: 0 },
    fillRadialGradientEndRadius: fixtureRadius,
    fillRadialGradientColorStops: [
      0, "#ffffff",
      0.45, color.glow,
      1, color.hex,
    ],
    listening: false,
  });
  group.add(fixture);

  return group;
}

function hexA(hex: string, alpha: number) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
