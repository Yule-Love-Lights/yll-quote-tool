// #8 Stage A: convert a staff-FINAL design scene back into the few-shot
// example shapes the analyzer teaches from (the inverse of seedFromAnalysis).
//
// A captured training example stores the final scene verbatim; at analyze
// time this converter projects it into the analyzer's vocabulary — roofline
// polylines + per-unit detection boxes, all normalized 0–1 of the street
// photo — so the model imitates what staff actually shipped, not what the
// AI originally guessed.
//
// Pure + photo-dims-driven, mirroring seedFromAnalysis's conventions:
//   tagged C9 strands (santas-roofline / gingerbread) → LineSegment polylines
//   mini strands + Scattershot areas (bush/tree/column/railing) → MiniLightDetection
//   wreaths / spritzers → centered boxes sized from the scene's yardstick
//   garland runs → bounding-box detections
// Railings ARE taught (the analyzer detects them now); a railing GROUP emits one
// detection boxing its member strands. CURTAINS are still skipped — kept editable
// for the future but out of the analyzer's detection vocabulary (#52).

import type { Scene, SceneItem } from './sceneTypes';
import { isStrand, isMiniArea, isMiniGroup, isWreath, isSpritzer, isGarland } from './sceneTypes';
import type {
  LineSegment,
  MiniLightDetection,
  WreathDetection,
  SpritzerDetection,
  GarlandDetection,
} from '@/lib/photoAnalysis';
import { firstYardstickPpf } from './yardstickPpf';

export type SceneFewShotPieces = {
  santasLines: LineSegment[];
  gingerbreadLines: LineSegment[];
  miniLightDetections: MiniLightDetection[];
  wreathDetections: WreathDetection[];
  spritzerDetections: SpritzerDetection[];
  garlandDetections: GarlandDetection[];
};

const EMPTY: SceneFewShotPieces = {
  santasLines: [],
  gingerbreadLines: [],
  miniLightDetections: [],
  wreathDetections: [],
  spritzerDetections: [],
  garlandDetections: [],
};

// When the scene has no yardstick (no scale), centered items fall back to a
// box this fraction of the photo's width — roughly what a wreath/spritzer
// occupies in a typical street shot.
const FALLBACK_BOX_FRACTION = 0.08;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// Flat photo-pixel points [x0,y0,x1,y1,…] → normalized [[x,y],…]. Exported for
// sceneAuxiliaryC9Lines below (#109) — same photo-pixel → 0-1 conversion, just
// applied to the two C9 surfaces sceneToFewShotPieces intentionally skips.
export function normalizePoints(points: number[], w: number, h: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    out.push([round4(clamp01(points[i] / w)), round4(clamp01(points[i + 1] / h))]);
  }
  return out;
}

// A straight horizontal/vertical run (a normal way to draw a mini-wrap line or
// a railing garland) collapses to a zero-height/width bounding box. Pad any
// degenerate dimension to this fraction of the photo so the detection still
// carries usable extent instead of being dropped downstream.
const MIN_BOX_FRACTION = 0.02;

// Bounding box of flat photo-pixel points → normalized [x, y, w, h]. Degenerate
// (zero-extent) dimensions are padded so straight-drawn runs still convert.
function pointsBoundingBox(
  points: number[],
  w: number,
  h: number,
): [number, number, number, number] | null {
  if (points.length < 2) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    minX = Math.min(minX, points[i]);
    maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]);
    maxY = Math.max(maxY, points[i + 1]);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  let x0 = clamp01(minX / w);
  let y0 = clamp01(minY / h);
  let x1 = clamp01(maxX / w);
  let y1 = clamp01(maxY / h);
  // Pad a collapsed dimension around its center, then re-clamp.
  if (x1 - x0 < MIN_BOX_FRACTION) {
    const c = (x0 + x1) / 2;
    x0 = clamp01(c - MIN_BOX_FRACTION / 2);
    x1 = clamp01(c + MIN_BOX_FRACTION / 2);
  }
  if (y1 - y0 < MIN_BOX_FRACTION) {
    const c = (y0 + y1) / 2;
    y0 = clamp01(c - MIN_BOX_FRACTION / 2);
    y1 = clamp01(c + MIN_BOX_FRACTION / 2);
  }
  return [round4(x0), round4(y0), round4(Math.max(0, x1 - x0)), round4(Math.max(0, y1 - y0))];
}

// #240: a mini-light group's members can be strands AND/OR scattershots
// (miniArea) — raw PHOTO-PIXEL points for either kind, so a railing group's
// member-box loop below can merge both into one pointsBoundingBox call. A
// box-shape miniArea has no `.points`; its two corners stand in for it (the
// group's real box only needs the extent, not the exact fill shape).
function memberPixelPoints(item: SceneItem): number[] {
  if (isStrand(item)) return item.points;
  if (isMiniArea(item)) {
    if (item.shape === 'polygon' && Array.isArray(item.points)) return item.points;
    if (typeof item.x === 'number' && typeof item.y === 'number' && typeof item.width === 'number' && typeof item.height === 'number') {
      return [item.x, item.y, item.x + item.width, item.y + item.height];
    }
  }
  return [];
}

// A box centered on (cx, cy) photo-pixels, sidePx wide/tall, clamped into the
// photo → normalized [x, y, w, h].
function centeredBox(
  cx: number,
  cy: number,
  sidePx: number,
  w: number,
  h: number,
): [number, number, number, number] {
  const half = sidePx / 2;
  const x0 = clamp01((cx - half) / w);
  const y0 = clamp01((cy - half) / h);
  const x1 = clamp01((cx + half) / w);
  const y1 = clamp01((cy + half) / h);
  return [round4(x0), round4(y0), round4(Math.max(0, x1 - x0)), round4(Math.max(0, y1 - y0))];
}

export function sceneToFewShotPieces(
  scene: Scene,
  photoW: number,
  photoH: number,
): SceneFewShotPieces {
  if (!Number.isFinite(photoW) || !Number.isFinite(photoH) || photoW <= 0 || photoH <= 0) {
    return { ...EMPTY };
  }
  const items: SceneItem[] = Array.isArray(scene?.items) ? scene.items : [];
  const ppf = firstYardstickPpf(scene);
  const fallbackSidePx = photoW * FALLBACK_BOX_FRACTION;
  // Visual sizeIn is inches; sizeIn/12 ft × ppf ≈ the item's on-photo pixels.
  const sidePxFor = (sizeIn: number) =>
    ppf != null && Number.isFinite(sizeIn) && sizeIn > 0 ? (sizeIn / 12) * ppf : fallbackSidePx;

  const out: SceneFewShotPieces = {
    santasLines: [],
    gingerbreadLines: [],
    miniLightDetections: [],
    wreathDetections: [],
    spritzerDetections: [],
    garlandDetections: [],
  };

  for (const item of items) {
    if (isStrand(item)) {
      // Tagged C9 roofline strands → the corrected roofline polylines.
      if (item.bulbType === 'c9') {
        if (item.surface === 'santas-roofline') {
          const pts = normalizePoints(item.points, photoW, photoH);
          if (pts.length >= 2) out.santasLines.push({ points: pts, label: 'front roofline (staff-confirmed)' });
        } else if (item.surface === 'gingerbread') {
          const pts = normalizePoints(item.points, photoW, photoH);
          if (pts.length >= 2) out.gingerbreadLines.push({ points: pts, label: 'ridge + sides (staff-confirmed)' });
        }
        // winter-wonderland + stake-lighting C9 runs have no slot in the example
        // shape — skip (both are manual-only categories, not AI-trained).
        continue;
      }
      // Mini strands wrapped on a surface → detections. Grouped members (railing
      // members) carry groupId and are emitted via their GROUP below, not here.
      if (item.bulbType === 'mini' && !item.groupId) {
        const surface = item.surface;
        if (surface === 'bush' || surface === 'tree' || surface === 'column' || surface === 'railing') {
          const box = pointsBoundingBox(item.points, photoW, photoH);
          if (box) {
            const stringCount = Math.max(1, Math.round(item.stringCount ?? 1));
            out.miniLightDetections.push({
              type: surface,
              wrapStyle: item.wrapStyle ?? 'canopy',
              stringCount,
              box,
              label: `${surface} — ${stringCount} string${stringCount === 1 ? '' : 's'}`,
            });
          }
        }
      }
      continue;
    }

    if (isMiniGroup(item)) {
      // A grouped railing (e.g. a deck rail drawn as several segments): the group
      // holds the billed count. Emit ONE detection boxing all members (strands
      // AND/OR scattershots, #240 — a group can mix both).
      // Curtains stay OUT (editable but not analyzer-taught, #52).
      if (item.surface === 'railing') {
        // Primary lookup: strands/scattershots whose groupId points back at this group.
        const memberPoints: number[] = [];
        for (const other of items) {
          if ((isStrand(other) || isMiniArea(other)) && other.groupId === item.id) memberPoints.push(...memberPixelPoints(other));
        }
        // Fallback (#110 W5-006): groupId/memberIds can diverge (members
        // deleted but the group kept, or a corrupt scene) — a billed railing
        // must not silently vanish from the training example. Re-resolve by
        // the group's own memberIds id list, which the group already carries.
        if (memberPoints.length === 0 && item.memberIds?.length) {
          const memberIdSet = new Set(item.memberIds);
          for (const other of items) {
            if ((isStrand(other) || isMiniArea(other)) && memberIdSet.has(other.id)) memberPoints.push(...memberPixelPoints(other));
          }
        }
        const box = pointsBoundingBox(memberPoints, photoW, photoH);
        if (box) {
          const stringCount = Math.max(1, Math.round(item.stringCount ?? 1));
          out.miniLightDetections.push({
            type: 'railing',
            wrapStyle: item.wrapStyle ?? 'canopy',
            stringCount,
            box,
            label: `railing — ${stringCount} string${stringCount === 1 ? '' : 's'}`,
          });
        }
      }
      continue;
    }

    if (isMiniArea(item)) {
      // #240 fix: a GROUPED scattershot is emitted via its group's ONE
      // detection above (memberPixelPoints), not its own — mirrors the
      // isStrand branch's `bulbType === 'mini' && !item.groupId` skip.
      // Without this, a grouped scattershot leaked into the training data
      // TWICE: once correctly (folded into the group's box) and once more
      // here with its own stale per-member stringCount, poisoning the label.
      if (item.groupId) continue;
      const surface = item.surface;
      if (surface !== 'bush' && surface !== 'tree' && surface !== 'column') continue;
      // Box-shape areas carry x/y/width/height; traced polygons carry points.
      // Either way the analyzer's vocabulary is a bounding box.
      let box: [number, number, number, number] | null = null;
      if (
        item.shape === 'box' &&
        typeof item.x === 'number' &&
        typeof item.y === 'number' &&
        typeof item.width === 'number' &&
        typeof item.height === 'number'
      ) {
        const x0 = clamp01(item.x / photoW);
        const y0 = clamp01(item.y / photoH);
        const x1 = clamp01((item.x + item.width) / photoW);
        const y1 = clamp01((item.y + item.height) / photoH);
        box = [round4(x0), round4(y0), round4(Math.max(0, x1 - x0)), round4(Math.max(0, y1 - y0))];
      } else if (Array.isArray(item.points)) {
        box = pointsBoundingBox(item.points, photoW, photoH);
      }
      if (!box || box[2] <= 0 || box[3] <= 0) continue;
      const stringCount = Math.max(1, Math.round(item.stringCount ?? 1));
      out.miniLightDetections.push({
        type: surface,
        wrapStyle: item.wrapStyle ?? 'canopy',
        stringCount,
        box,
        label: `${surface} — ${stringCount} string${stringCount === 1 ? '' : 's'}`,
      });
      continue;
    }

    if (isWreath(item)) {
      const quoteSize = item.quoteSize ?? '36noble';
      out.wreathDetections.push({
        size: quoteSize,
        tier: item.tier ?? 'bow',
        box: centeredBox(item.x, item.y, sidePxFor(item.sizeIn), photoW, photoH),
        label: `wreath ${quoteSize}`,
      });
      continue;
    }

    if (isSpritzer(item)) {
      const quoteSize = item.quoteSize ?? '24';
      out.spritzerDetections.push({
        size: quoteSize,
        box: centeredBox(item.x, item.y, sidePxFor(item.sizeIn), photoW, photoH),
        label: `spritzer ${quoteSize}in`,
      });
      continue;
    }

    if (isGarland(item)) {
      const box = pointsBoundingBox(item.points, photoW, photoH);
      if (!box) continue;
      const quoteLength = item.quoteLength ?? '9ft';
      const sections = Math.max(1, Math.round(item.quoteSections ?? 1));
      out.garlandDetections.push({
        length: quoteLength,
        tier: item.tier ?? 'fullDecor',
        box,
        label: `garland ${quoteLength}${sections > 1 ? ` × ${sections}` : ''}`,
      });
      continue;
    }

    // Bows, text, custom graphics, poles, mini groups: no analyzer vocabulary — skip.
  }

  return out;
}

// #109 Phase 1: winter-wonderland + stake-lighting C9 runs are intentionally
// skipped by sceneToFewShotPieces above (they're manual-only categories, not
// AI-trained — see the comment on the `c9` branch). But the /training/new
// "pre-fill from quote" affordance still wants them: the operator drew this
// geometry by hand on the approved design, and it's real information to
// reconcile against the completed-install photo, same as the roofline lines.
// Kept as a SEPARATE export (not folded into sceneToFewShotPieces) so the
// analyzer's few-shot vocabulary is untouched by this training-capture-only
// addition.
export function sceneAuxiliaryC9Lines(
  scene: Scene,
  photoW: number,
  photoH: number,
): { c9Lines: LineSegment[]; stakeLines: LineSegment[] } {
  const out = { c9Lines: [] as LineSegment[], stakeLines: [] as LineSegment[] };
  if (!Number.isFinite(photoW) || !Number.isFinite(photoH) || photoW <= 0 || photoH <= 0) {
    return out;
  }
  const items: SceneItem[] = Array.isArray(scene?.items) ? scene.items : [];
  for (const item of items) {
    if (!isStrand(item) || item.bulbType !== 'c9') continue;
    if (item.surface === 'winter-wonderland') {
      const pts = normalizePoints(item.points, photoW, photoH);
      if (pts.length >= 2) out.c9Lines.push({ points: pts, label: 'C9 run (staff-confirmed)' });
    } else if (item.surface === 'stake-lighting') {
      const pts = normalizePoints(item.points, photoW, photoH);
      if (pts.length >= 2) out.stakeLines.push({ points: pts, label: 'stake lighting run (staff-confirmed)' });
    }
  }
  return out;
}
