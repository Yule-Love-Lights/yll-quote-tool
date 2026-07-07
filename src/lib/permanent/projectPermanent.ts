// Project a design Scene → permanent-quote footage / corners / front-gap
// candidates (ledger #88, plan P4b). PURE geometry — the builder auto-fills the
// PermanentSection form from this (front footage + corners + the front gaps that
// drive extensions), and the operator can override every value.
//
// - Footage per side: the drawn permanent strands' polyline length ÷ their
//   yardstick px/ft (mirrors materialsProjection.strandFeet), grouped by the
//   #103 sideOfHouse tag. Only the FRONT is designable; left/right/back come
//   from satellite measuring, but if a strand IS tagged to a side its footage
//   lands in that bucket. Untagged strands → the `unassigned` bucket (surfaced
//   in the UI, never silently dropped).
// - Corners per side: every polyline vertex INCLUDING endpoints — Naldo's rule
//   (a gable peak traced start→apex→end = 3, both base transitions + the apex).
//   Each corner consumes 3 single lights in the BOM. Operator-editable.
// - Front gap candidates: the distance from one drawn front strand's END to the
//   next strand's START (in draw order), in feet — the design KNOWS where the
//   lights break, so these pre-fill (editable) gap rows that drive extensions/
//   boosters. A gap under GAP_MIN_FT is ignored (touching runs aren't a break).

import type { Scene, StrandItem, SideOfHouse } from '@/lib/design/sceneTypes';
import { isStrand } from '@/lib/design/sceneTypes';
import { pxPerFoot } from '@/components/design/editor-core/yardstick-scale';
import type { PermanentQuoteFields, PermanentGap } from './types';

/** Below this the two runs are touching, not a real gap needing an extension. */
const GAP_MIN_FT = 0.5;

export type PermanentSideKey = 'front' | 'left' | 'right' | 'back' | 'unassigned';

export type PermanentGapCandidate = {
  lengthFt: number;
  fromStrandId: string;
  toStrandId: string;
};

export type PermanentDesignProjection = {
  feetBySide: Record<PermanentSideKey, number>;
  cornersBySide: Record<PermanentSideKey, number>;
  frontGapCandidates: PermanentGapCandidate[];
};

function zeroBySide(): Record<PermanentSideKey, number> {
  return { front: 0, left: 0, right: 0, back: 0, unassigned: 0 };
}

/** Polyline length in photo pixels (mirrors materialsProjection.polylineLengthPx). */
function polylineLengthPx(points: number[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 2; i += 2) {
    total += Math.hypot(points[i + 2] - points[i], points[i + 3] - points[i + 1]);
  }
  return total;
}

/** Number of vertices in a flat [x0,y0,x1,y1,…] point array. */
function vertexCount(points: number[]): number {
  return Math.floor((points?.length ?? 0) / 2);
}

function ppfFor(strand: StrandItem, scene: Scene): number {
  const ys = (scene.yardsticks ?? []).find((y) => y.id === strand.yardstickId) ?? null;
  return pxPerFoot(ys);
}

function sideKey(s: SideOfHouse | null | undefined): PermanentSideKey {
  return s === 'front' || s === 'left' || s === 'right' || s === 'back' ? s : 'unassigned';
}

export function projectPermanentDesign(scene: Scene): PermanentDesignProjection {
  const feetBySide = zeroBySide();
  const cornersBySide = zeroBySide();
  const frontStrands: StrandItem[] = [];

  const strands = (scene?.items ?? [])
    .filter(isStrand)
    .filter((s) => s.bulbType === 'permanent');

  for (const s of strands) {
    const key = sideKey(s.sideOfHouse);
    const points = Array.isArray(s.points) ? s.points : [];
    const ppf = ppfFor(s, scene);
    const lengthPx = polylineLengthPx(points);
    if (ppf > 0 && lengthPx > 0) feetBySide[key] += lengthPx / ppf;
    // Corners = every vertex incl. endpoints (Naldo: peak = 3). A degenerate
    // run with fewer than 2 vertices contributes nothing.
    const verts = vertexCount(points);
    if (verts >= 2) cornersBySide[key] += verts;
    if (key === 'front') frontStrands.push(s);
  }

  // Footage is quoted per whole foot — round each bucket once at the end.
  for (const k of Object.keys(feetBySide) as PermanentSideKey[]) {
    feetBySide[k] = Math.round(feetBySide[k]);
  }

  // Front gap candidates: end-of-N → start-of-(N+1), in scene (draw) order.
  const frontGapCandidates: PermanentGapCandidate[] = [];
  for (let i = 0; i < frontStrands.length - 1; i++) {
    const a = frontStrands[i];
    const b = frontStrands[i + 1];
    if (vertexCount(a.points) < 1 || vertexCount(b.points) < 1) continue;
    const ax = a.points[a.points.length - 2];
    const ay = a.points[a.points.length - 1];
    const bx = b.points[0];
    const by = b.points[1];
    const distPx = Math.hypot(bx - ax, by - ay);
    const ppf = ppfFor(a, scene);
    const gapFt = ppf > 0 ? distPx / ppf : 0;
    if (gapFt >= GAP_MIN_FT) {
      frontGapCandidates.push({
        lengthFt: Math.round(gapFt),
        fromStrandId: a.id,
        toStrandId: b.id,
      });
    }
  }

  return { feetBySide, cornersBySide, frontGapCandidates };
}

/**
 * Merge a design projection into the permanent quote fields — the design now
 * drives ALL FOUR sides (#88: front/left/right/back), not front alone.
 *
 * The design is the source of truth for any side it actually covers; a side the
 * design has NO footage for keeps the operator's existing manual entry, so a
 * Refresh never wipes a satellite-measured side that wasn't drawn. Front gap
 * candidates are regenerated fresh from geometry; operator-added 'manual' gap
 * rows survive, while stale 'auto'/'edited' rows are replaced by the new detection.
 */
export function applyPermanentProjection(
  fields: PermanentQuoteFields,
  proj: PermanentDesignProjection,
): PermanentQuoteFields {
  // Apply a side only when the design covers it (footage > 0); else keep manual.
  const merge = (
    ft: number,
    corners: number,
    curFt: number,
    curCorners: number,
  ): [number, number] => (ft > 0 ? [ft, corners] : [curFt, curCorners]);

  const [frontFootage, frontCorners] = merge(proj.feetBySide.front, proj.cornersBySide.front, fields.frontFootage, fields.frontCorners);
  const [leftFootage, leftCorners] = merge(proj.feetBySide.left, proj.cornersBySide.left, fields.leftFootage, fields.leftCorners);
  const [rightFootage, rightCorners] = merge(proj.feetBySide.right, proj.cornersBySide.right, fields.rightFootage, fields.rightCorners);
  const [backFootage, backCorners] = merge(proj.feetBySide.back, proj.cornersBySide.back, fields.backFootage, fields.backCorners);

  const autoRows: PermanentGap[] = proj.frontGapCandidates.map((c) => ({
    lengthFt: c.lengthFt,
    detectedFt: c.lengthFt,
    source: 'auto' as const,
  }));
  const gaps: PermanentGap[] = [...autoRows, ...fields.gaps.filter((g) => g.source === 'manual')];

  return {
    ...fields,
    frontFootage,
    frontCorners,
    leftFootage,
    leftCorners,
    rightFootage,
    rightCorners,
    backFootage,
    backCorners,
    gaps,
  };
}
