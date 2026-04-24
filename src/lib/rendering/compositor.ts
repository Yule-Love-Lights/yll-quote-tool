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

import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import type { CompositeResult, RenderStyle, RenderVisionInput } from './types';
import type { LineSegment } from '@/lib/photoAnalysis';

// Transparent sprite assets live in public/sprites/. We cache file reads per
// process so repeat renders in the same server run skip disk I/O.
const SPRITES_DIR = path.join(process.cwd(), 'public', 'sprites');
const SPRITE_CACHE = new Map<string, Promise<Buffer>>();
function loadSprite(name: string): Promise<Buffer> {
  let p = SPRITE_CACHE.get(name);
  if (!p) {
    p = fs.readFile(path.join(SPRITES_DIR, name));
    SPRITE_CACHE.set(name, p);
  }
  return p;
}

// Bulb spacing in pixels on a 1000px-wide source. We scale this linearly
// with source width so spacing stays visually consistent across photo sizes.
const BULB_SPACING_AT_1000PX = 18;
// Reduced from 8 to 5 (v4→v5): Gemini was reading composite bulb size
// as a strong scale anchor and rendering oversized C9 bulbs on the roofline.
// Smaller composite dots + tighter prompt size language = refined residential
// look instead of commercial-carnival look. Mask stroke stays at 10 so the
// polyline detection is unaffected.
const BULB_DIAMETER_AT_1000PX = 5;
const MASK_STROKE_WIDTH_AT_1000PX = 10;

export type CompositeOptions = {
  style: RenderStyle;
  targetWidth?: number;   // downsize the source to this for Gemini (saves tokens + latency)
  // When true, compositor omits bush/tree/column mini-light dots from the
  // composite + mask (so Gemini doesn't paint them) and emits a separate
  // `bushMask` buffer. Downstream, an inpainting model repaints ONLY inside
  // the bushMask region with mini-lights. Turn on when REPLICATE_API_TOKEN is
  // configured; leave off for single-shot Gemini renders.
  inpaintBushes?: boolean;
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

  // Walk each polyline at bulbSpacing intervals and emit ROOFLINE C9 bulb
  // positions. These are rendered at full bulbDiameter — the large warm C9s.
  const bulbPositions: { x: number; y: number }[] = [];
  for (const line of polylines) {
    const positions = samplePolyline(line, bulbSpacing);
    bulbPositions.push(...positions);
  }

  // Mini-light positions live in a SEPARATE list so the mask can draw them
  // at ~40% the diameter of C9s. Same-size dots lead Gemini to render the
  // bush minis at C9 scale (giant floating orbs). Smaller mask dots signal
  // "tiny mini-light bulb, not a C9."
  //
  // We also collect the bush boxes so we can pre-darken them on the composite
  // — bulbs against dim foliage read as "already lit" to Gemini, so Gemini's
  // job is photographic integration not re-interpretation.
  const miniLightPositions: { x: number; y: number }[] = [];
  const miniLightBoxes: { x: number; y: number; w: number; h: number; style: 'canopy' | 'trunk' }[] = [];
  for (const m of vision.miniLights) {
    const [bx, by, bw, bh] = m.box;
    const x = bx * width;
    const y = by * height;
    const w = bw * width;
    const h = bh * height;
    const wrapPoints = sampleWrap(x, y, w, h, m.wrapStyle, bulbSpacing);
    miniLightPositions.push(...wrapPoints);
    miniLightBoxes.push({ x, y, w, h, style: m.wrapStyle });
  }
  const miniDiameter = Math.max(3, bulbDiameter * 0.4);

  // Wreath SUGGESTIONS — one box per wreath spot. The transparent sprite IS
  // the light — it already shows bulbs around the rim. Do NOT add a bulb ring
  // to the mask, or Gemini renders phantom dots outside the wreath.
  const spriteOverlays: sharp.OverlayOptions[] = [];
  for (const wr of vision.wreaths) {
    const [bx, by, bw, bh] = wr.box;
    const x = bx * width;
    const y = by * height;
    const w = bw * width;
    const h = bh * height;
    const side = Math.max(12, Math.round(Math.min(w, h)));
    const spriteFile = wr.tier === 'fullDecor' ? 'wreath-decor.png' : 'wreath-bow.png';
    try {
      const spriteBuf = await loadSprite(spriteFile);
      const resized = await sharp(spriteBuf).resize(side, side, { fit: 'inside' }).png().toBuffer();
      spriteOverlays.push({
        input: resized,
        left: Math.round(x + w / 2 - side / 2),
        top: Math.round(y + h / 2 - side / 2),
      });
    } catch (err) {
      console.warn(`[compositor] wreath sprite ${spriteFile} missing`, err);
    }
  }

  // Spritzer SUGGESTIONS — one box per stake. The sprite IS the light (warm-
  // white starburst on wires). No mask dot — the sprite carries its own bulbs,
  // and any extra dot near the sprite triggers phantom lights in the render.
  //
  // Sizing: a real spritzer stake is ~2ft tall. On a typical house photo the
  // stake should read as ~6-8% of image width. We floor at 9% of width (v5
  // bump from 7%) so even tiny per-stake boxes still produce a visibly-
  // legible starburst that Gemini can anchor to — sprites smaller than
  // ~40px get lost as noise.
  //
  // Visibility (v5): the raw sprite is a pale cream starburst on transparent,
  // which vanishes against the dusk-darkened base. Two compensations:
  //   1. Warm radial-gradient halo drawn UNDER the sprite (makes an obvious
  //      bright spot in the composite so Gemini's training prior registers
  //      "there is a light fixture here").
  //   2. Sprite is brightened + saturation-boosted before compositing so the
  //      warm-white strands actually read as bright against dusk.
  try {
    const spritzerSpriteBuf = await loadSprite('spritzer.png');
    // v8 (2026-04-23): pulled min sprite size back from 9% to 7.5% of width.
    // v6→v7 halo + brightness tuning made spritzers visible, but at 9% they
    // render noticeably larger than a real ~2ft starburst stake should look
    // relative to the house. 7.5% puts them closer to a realistic residential
    // footprint while still clearing the visibility threshold.
    const spritzerMinSide = Math.round(width * 0.075);
    for (const sp of vision.spritzers) {
      const [bx, by, bw, bh] = sp.box;
      const x = bx * width;
      const y = by * height;
      const w = bw * width;
      const h = bh * height;
      const boxSide = Math.round(Math.max(w, h));
      const side = Math.max(spritzerMinSide, boxSide);

      // Warm glow halo — radial gradient, slightly larger than the sprite,
      // drawn FIRST so the sprite sits on top of an obvious bright spot.
      // Without this, Gemini reads the pale sprite as "sky noise" and drops it.
      // v6.1: dialed halo opacity down (0.85→0.45, 0.45→0.20) after first
      // pass pooled too much warm light on surrounding grass.
      const haloSide = Math.round(side * 1.3);
      const haloSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${haloSide}" height="${haloSide}" viewBox="0 0 ${haloSide} ${haloSide}">
        <defs>
          <radialGradient id="g" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="rgb(255,220,140)" stop-opacity="0.45"/>
            <stop offset="40%" stop-color="rgb(255,200,100)" stop-opacity="0.20"/>
            <stop offset="100%" stop-color="rgb(255,180,80)" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <circle cx="${haloSide / 2}" cy="${haloSide / 2}" r="${haloSide / 2}" fill="url(#g)"/>
      </svg>`;
      const haloBuf = await sharp(Buffer.from(haloSvg)).png().toBuffer();

      // Brightened/saturated sprite — pop against dusk. v6.1: pulled back
      // from 1.8/1.5 to 1.4/1.3 once the halo was taking care of "visible
      // from space" duty. Sprite now just needs to read as warm-white.
      const resized = await sharp(spritzerSpriteBuf)
        .resize(side, side, { fit: 'inside' })
        .modulate({ brightness: 1.4, saturation: 1.3 })
        .png()
        .toBuffer();
      const resizedMeta = await sharp(resized).metadata();
      const rw = resizedMeta.width ?? side;
      const rh = resizedMeta.height ?? side;

      const centerX = Math.round(x + w / 2);
      const centerY = Math.round(y + h / 2);

      // Layer order: halo first (underneath), then sprite on top.
      spriteOverlays.push({
        input: haloBuf,
        left: centerX - Math.round(haloSide / 2),
        top: centerY - Math.round(haloSide / 2),
      });
      spriteOverlays.push({
        input: resized,
        left: centerX - Math.round(rw / 2),
        top: centerY - Math.round(rh / 2),
      });
    }
  } catch (err) {
    console.warn('[compositor] spritzer sprite missing — spritzer boxes will not render', err);
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
  // for the mask (pure white on black). When inpaintBushes is on, the
  // bush mini-light dots are OMITTED from both — an inpainting model paints
  // them downstream. Roofline C9s, wreath sprites, spritzer sprites remain
  // unchanged so Gemini still renders those.
  const bulbColor = styleToColor(opts.style);
  const inpaint = Boolean(opts.inpaintBushes);

  const compositeBulbGroups: BulbGroup[] = inpaint
    ? [{ points: bulbPositions, diameter: bulbDiameter }]
    : [
        { points: bulbPositions, diameter: bulbDiameter },
        { points: miniLightPositions, diameter: miniDiameter },
      ];
  const maskBulbGroups = compositeBulbGroups;

  const darkenOverlay = buildDarkenSvg(width, height, miniLightBoxes);
  const compositeOverlay = buildBulbSvg(width, height, compositeBulbGroups, bulbColor);
  const maskSvg = buildMaskSvg(width, height, polylines, maskBulbGroups, maskStroke);

  // Layer order matters:
  // 1. darkened base photo
  // 2. bush-region darkening ellipses — pre-dims foliage so bulbs read as lit
  // 3. wreath + spritzer sprites (the literal pixels we want Gemini to anchor)
  // 4. bulb dot overlay (SVG with glow) — drawn on top so stray bulb dots
  //    that landed on a sprite region still read as glow
  const composite = await sharp(base)
    .composite([
      { input: Buffer.from(darkenOverlay), top: 0, left: 0 },
      ...spriteOverlays,
      { input: Buffer.from(compositeOverlay), top: 0, left: 0 },
    ])
    .png()
    .toBuffer();

  const mask = await sharp(Buffer.from(maskSvg))
    .png()
    .toBuffer();

  // Bush mask — emitted only when we're handing off to an inpainter. White
  // inside bush boxes, black everywhere else. The inpainter uses this to
  // restrict repainting to the foliage regions, leaving everything Gemini
  // rendered (roofline, wreaths, spritzers, architecture) untouched.
  let bushMask: Buffer | undefined;
  if (opts.inpaintBushes && miniLightBoxes.length > 0) {
    const bushMaskSvg = buildBushMaskSvg(width, height, miniLightBoxes);
    bushMask = await sharp(Buffer.from(bushMaskSvg)).png().toBuffer();
  }

  return {
    composite,
    mask,
    bushMask,
    width,
    height,
    placedBulbs: bulbPositions.length + miniLightPositions.length,
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

// Sample points inside a mini-light detection box. Goal: scatter of discrete
// warm-white pinpoints that Gemini interprets as hand-wrapped mini-light
// strings — NOT as a rectangular net-light blanket.
//
// Net-light pitfall: Gemini's prior maps "warm-white dots on a perfect grid"
// to the net-light product. To avoid that we (a) keep density low — tighter
// than an installer's 6" spacing on a single string would produce, but loose
// enough to read as discrete — and (b) deterministic-jitter each point so no
// two rows align.
//
// 'canopy' = rounded top + square bottom (bushes, tree canopies)
// 'trunk'  = rectangular column (columns, tree trunks)
function sampleWrap(
  x: number,
  y: number,
  w: number,
  h: number,
  style: 'canopy' | 'trunk',
  spacing: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const step = spacing * 1.5;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  for (let py = y; py <= y + h; py += step) {
    for (let px = x; px <= x + w; px += step) {
      // Deterministic jitter — same box → same pattern (keeps cache stable)
      // but no two points land on the same row/col. Amplitude ~40% of step
      // is enough to break the grid perception without clumping.
      const jx = Math.sin(px * 0.137 + py * 0.091) * step * 0.4;
      const jy = Math.cos(px * 0.213 + py * 0.079) * step * 0.4;
      const ppx = px + jx;
      const ppy = py + jy;
      if (style === 'canopy') {
        const nx = (ppx - cx) / rx;
        const ny = (ppy - cy) / ry;
        if (nx * nx + ny * ny > 1.1) continue;
      } else {
        // trunk style: keep points inside the rectangle after jitter
        if (ppx < x || ppx > x + w || ppy < y || ppy > y + h) continue;
      }
      out.push({ x: ppx, y: ppy });
    }
  }
  return out;
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
type BulbGroup = { points: { x: number; y: number }[]; diameter: number };

// Bulb rendering for the composite. Each bulb is three stacked circles:
//   - outer soft halo (wide, low alpha) — gives the photographic bloom
//   - mid halo (medium, medium alpha) — fills the gradient to a hot core
//   - inner bright core (small, high alpha white) — the filament point
// This gives Gemini a composite that already *looks* like a lit photograph
// rather than a flat mask-hint, so it does photographic integration not
// creative re-interpretation.
function buildBulbSvg(
  w: number,
  h: number,
  groups: BulbGroup[],
  color: string,
): string {
  const layers = groups
    .flatMap(g =>
      g.points.flatMap(p => {
        const cx = p.x.toFixed(1);
        const cy = p.y.toFixed(1);
        const rOuter = (g.diameter * 1.8).toFixed(1);
        const rMid = (g.diameter * 0.9).toFixed(1);
        const rCore = (g.diameter * 0.35).toFixed(1);
        return [
          `<circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="${color}" opacity="0.18"/>`,
          `<circle cx="${cx}" cy="${cy}" r="${rMid}" fill="${color}" opacity="0.55"/>`,
          `<circle cx="${cx}" cy="${cy}" r="${rCore}" fill="#fff8e0" opacity="0.95"/>`,
        ];
      }),
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${layers}</svg>`;
}

// Darkening overlay for bush regions on the composite. Black semi-transparent
// ellipse per canopy (or rect per trunk) — dims foliage behind the pre-stamped
// mini-light bulbs so the composite reads as "already lit" rather than "lights
// about to be added." Low alpha (~0.35) keeps plant texture visible.
function buildDarkenSvg(
  w: number,
  h: number,
  boxes: { x: number; y: number; w: number; h: number; style: 'canopy' | 'trunk' }[],
): string {
  if (boxes.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"></svg>`;
  }
  const shapes = boxes
    .map(b => {
      if (b.style === 'canopy') {
        const cx = (b.x + b.w / 2).toFixed(1);
        const cy = (b.y + b.h / 2).toFixed(1);
        const rx = (b.w / 2).toFixed(1);
        const ry = (b.h / 2).toFixed(1);
        return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="black" opacity="0.35"/>`;
      }
      return `<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" fill="black" opacity="0.35"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${shapes}</svg>`;
}

// Mask SVG — pure black bg with white strokes along every polyline and
// white filled dots at every bulb position. This is what Gemini uses as
// the "lights go HERE" reference.
function buildMaskSvg(
  w: number,
  h: number,
  polylines: [number, number][][],
  groups: BulbGroup[],
  strokeWidth: number,
): string {
  const paths = polylines
    .map(line => {
      const d = line.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
      return `<path d="${d}" stroke="white" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
    })
    .join('');
  const dots = groups
    .flatMap(g =>
      g.points.map(
        p =>
          `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(g.diameter / 2).toFixed(1)}" fill="white"/>`,
      ),
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="black"/>
    ${paths}
    ${dots}
  </svg>`;
}

// Bush mask SVG — pure black background with solid-white bush/tree/column
// regions. Canopy boxes are filled ellipses (matches the foliage silhouette
// better than a rectangle); trunk boxes are filled rectangles. This is the
// inpaint region passed to the inpainting model — only pixels inside these
// shapes are repainted.
function buildBushMaskSvg(
  w: number,
  h: number,
  boxes: { x: number; y: number; w: number; h: number; style: 'canopy' | 'trunk' }[],
): string {
  const shapes = boxes
    .map(b => {
      if (b.style === 'canopy') {
        const cx = (b.x + b.w / 2).toFixed(1);
        const cy = (b.y + b.h / 2).toFixed(1);
        const rx = (b.w / 2).toFixed(1);
        const ry = (b.h / 2).toFixed(1);
        return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="white"/>`;
      }
      return `<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" fill="white"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="black"/>
    ${shapes}
  </svg>`;
}
