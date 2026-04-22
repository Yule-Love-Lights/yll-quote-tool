// Sharp-based composite builder. Takes the daytime source photo + vision
// polylines/boxes and produces TWO PNG buffers:
//
//   1. composite — source photo, slightly darkened toward dusk, with bulb
//      sprites placed at evenly-spaced intervals along every polyline and
//      around every wreath / bush / column detection. This is what Gemini
//      sees as "reference image 2" during the refinement pass.
//
//   2. mask — a pure black PNG of identical dimensions, with WHITE pixels
//      wherever lights should appear in the final image. Passed to Gemini
//      as "reference image 3" with a prompt that says: "lights must appear
//      exactly where white strokes are in the mask." This is what gives
//      pixel-precise placement — text coordinates alone drift.
//
// Sprites are SVG strings rendered to PNG at runtime so we don't need to
// ship asset files for Phase 1. Once the AI-generated C9 sprites land in
// src/lib/rendering/sprites/, swap these for file reads.

import sharp from 'sharp';
import type { CompositeResult, RenderStyle, RenderVisionInput } from './types';
import type { LineSegment } from '@/lib/photoAnalysis';

// Bulb spacing in pixels on a 1000px-wide source. We scale this linearly
// with source width so spacing stays visually consistent across photo sizes.
const BULB_SPACING_AT_1000PX = 18;
const BULB_DIAMETER_AT_1000PX = 8;
const MASK_STROKE_WIDTH_AT_1000PX = 10;

export type CompositeOptions = {
  style: RenderStyle;
  targetWidth?: number;   // downsize the source to this for Gemini (saves tokens + latency)
};

// Entry point. The main render route calls this.
export async function buildComposite(
  photoBase64: string,
  photoMediaType: string,
  vision: RenderVisionInput,
  opts: CompositeOptions,
): Promise<CompositeResult> {
  const srcBuf = Buffer.from(photoBase64, 'base64');
  const meta = await sharp(srcBuf).metadata();
  if (!meta.width || !meta.height) {
    throw new Error('Source photo has no dimensions — bad upload?');
  }

  // Downscale so Gemini input stays ≤1536px long edge. Aspect preserved.
  const maxDim = opts.targetWidth ?? 1280;
  const scale = Math.min(1, maxDim / Math.max(meta.width, meta.height));
  const width = Math.round(meta.width * scale);
  const height = Math.round(meta.height * scale);

  // Prep the darkened source as the composite base. Dusk tone cue helps
  // Gemini lock onto the time-of-day we want in the final pass.
  const base = await sharp(srcBuf)
    .resize(width, height)
    .modulate({ brightness: 0.55, saturation: 0.8 })       // darken toward dusk
    .tint({ r: 40, g: 50, b: 80 })                         // cool blue shift
    .png()
    .toBuffer();

  // Derive scale factor for bulb sizing/spacing. Everything scales off
  // 1000px-wide reference so a 2000px photo gets 2x spacing and bulb size.
  const pxScale = width / 1000;
  const bulbSpacing = Math.max(10, BULB_SPACING_AT_1000PX * pxScale);
  const bulbDiameter = Math.max(5, BULB_DIAMETER_AT_1000PX * pxScale);
  const maskStroke = Math.max(6, MASK_STROKE_WIDTH_AT_1000PX * pxScale);

  // Denormalize all polylines to absolute pixel coordinates.
  const polylines: [number, number][][] = [];
  const pushLines = (lines: LineSegment[] | undefined) => {
    if (!lines) return;
    for (const seg of lines) {
      if (!seg.points || seg.points.length < 2) continue;
      polylines.push(seg.points.map(([x, y]) => [x * width, y * height]));
    }
  };
  pushLines(vision.santasLines);
  pushLines(vision.gingerbreadLines);
  pushLines(vision.c9Lines);

  // Walk each polyline at bulbSpacing intervals and emit bulb positions.
  const bulbPositions: { x: number; y: number }[] = [];
  for (const line of polylines) {
    const positions = samplePolyline(line, bulbSpacing);
    bulbPositions.push(...positions);
  }

  // Mini-light bounding boxes — bushes/trees/columns. Ring bulbs around
  // the bottom half of the box (canopy drape) or full perimeter (trunk wrap).
  for (const m of vision.miniLights) {
    const [bx, by, bw, bh] = m.box;
    const x = bx * width;
    const y = by * height;
    const w = bw * width;
    const h = bh * height;
    const wrapPoints = sampleWrap(x, y, w, h, m.wrapStyle, bulbSpacing);
    bulbPositions.push(...wrapPoints);
  }

  // Wreath detections — circular bulb rings around the wreath box.
  for (const wr of vision.wreaths) {
    const [bx, by, bw, bh] = wr.box;
    const cx = (bx + bw / 2) * width;
    const cy = (by + bh / 2) * height;
    const r = Math.max(bw * width, bh * height) / 2;
    bulbPositions.push(...sampleCircle(cx, cy, r, bulbSpacing));
  }

  // Garland — linear run across the top edge of its box.
  for (const g of vision.garland) {
    const [bx, by, bw] = g.box;
    const x0 = bx * width;
    const y0 = by * height;
    const x1 = (bx + bw) * width;
    const positions = samplePolyline([[x0, y0], [x1, y0]], bulbSpacing);
    bulbPositions.push(...positions);
  }

  // Render SVG overlays — one for the composite (colored bulb dots), one
  // for the mask (pure white on black).
  const bulbColor = styleToColor(opts.style);
  const compositeOverlay = buildBulbSvg(width, height, bulbPositions, bulbDiameter, bulbColor);
  const maskSvg = buildMaskSvg(width, height, polylines, bulbPositions, maskStroke, bulbDiameter);

  const composite = await sharp(base)
    .composite([{ input: Buffer.from(compositeOverlay), top: 0, left: 0 }])
    .png()
    .toBuffer();

  const mask = await sharp(Buffer.from(maskSvg))
    .png()
    .toBuffer();

  return {
    composite,
    mask,
    width,
    height,
    placedBulbs: bulbPositions.length,
  };
}

// Walk a polyline and emit points every `spacing` pixels of arc length.
// Uses linear interpolation between vertices.
function samplePolyline(line: [number, number][], spacing: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  if (line.length < 2) return out;
  let leftover = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const [x0, y0] = line[i];
    const [x1, y1] = line[i + 1];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const segLen = Math.hypot(dx, dy);
    if (segLen === 0) continue;
    const ux = dx / segLen;
    const uy = dy / segLen;
    let t = spacing - leftover;
    while (t <= segLen) {
      out.push({ x: x0 + ux * t, y: y0 + uy * t });
      t += spacing;
    }
    leftover = segLen - (t - spacing);
  }
  return out;
}

// Sample points around a detection box. 'canopy' = drape across top + sides
// simulating bushes/trees wrapped with mini strings. 'trunk' = vertical
// stripes down the center (column/trunk wraps).
function sampleWrap(
  x: number,
  y: number,
  w: number,
  h: number,
  style: 'canopy' | 'trunk',
  spacing: number,
): { x: number; y: number }[] {
  if (style === 'trunk') {
    // Three vertical columns of bulbs down the center.
    const out: { x: number; y: number }[] = [];
    const cx = x + w / 2;
    const offsets = [-w * 0.15, 0, w * 0.15];
    for (const ox of offsets) {
      for (let ty = y; ty <= y + h; ty += spacing) {
        out.push({ x: cx + ox, y: ty });
      }
    }
    return out;
  }
  // canopy — drape across top + down both sides in gentle arcs
  const topArc: [number, number][] = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = x + t * w;
    // arc droop — parabolic low in the middle
    const py = y + h * 0.15 - Math.sin(t * Math.PI) * h * 0.08;
    topArc.push([px, py]);
  }
  return samplePolyline(topArc, spacing);
}

// Evenly space N points around a circle, where N = ceil(circumference / spacing).
function sampleCircle(cx: number, cy: number, r: number, spacing: number): { x: number; y: number }[] {
  const circumference = 2 * Math.PI * r;
  const n = Math.max(8, Math.ceil(circumference / spacing));
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return out;
}

function styleToColor(style: RenderStyle): string {
  if (style === 'multi') return '#ffcc44'; // placeholder; multi rotates colors in Phase 2
  if (style === 'red-green') return '#ff3322';
  return '#ffd27a'; // warm-white C9 glow tone
}

// SVG with soft-glow bulb circles for the composite overlay.
function buildBulbSvg(
  w: number,
  h: number,
  positions: { x: number; y: number }[],
  diameter: number,
  color: string,
): string {
  const circles = positions
    .map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(diameter / 2).toFixed(1)}" fill="${color}" filter="url(#glow)"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="${(diameter * 0.6).toFixed(1)}" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    ${circles}
  </svg>`;
}

// Mask SVG — pure black bg with white strokes along every polyline and
// white filled dots at every bulb position. This is what Gemini uses as
// the "lights go HERE" reference.
function buildMaskSvg(
  w: number,
  h: number,
  polylines: [number, number][][],
  bulbs: { x: number; y: number }[],
  strokeWidth: number,
  diameter: number,
): string {
  const paths = polylines
    .map(line => {
      const d = line.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
      return `<path d="${d}" stroke="white" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
    })
    .join('');
  const dots = bulbs
    .map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(diameter / 2).toFixed(1)}" fill="white"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="black"/>
    ${paths}
    ${dots}
  </svg>`;
}
