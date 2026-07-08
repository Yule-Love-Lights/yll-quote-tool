// Permanent Lighting #140 (P1b) — pure derivation of the Extensions/Splitters
// card counts from DRAWN geometry. No AI required: every interior direction
// change of a drawn run is a physical track CUT (corner, gable up-cut, apex,
// down-cut — Jason S24: "every track cut needs an extension… except the track
// ends"), and separated runs connect via measured JUMPS sized generously.
//
// Sources and ownership (the anti-double-count rule):
//   • SATELLITE lines own PLAN-view corners on all four sides (the same
//     vertices deriveSideMeasure already counts for corner singles) + the
//     within-side / side-to-side junctions and jumps (the satellite has the
//     ft-per-px scale).
//   • STREET permanent strands contribute ONLY elevation cuts (gable rakes +
//     apexes) — a vertex whose both neighbors are flat is a plan corner the
//     satellite already owns, so it is skipped here. A gable therefore counts
//     3 cuts (up-transition, apex, down-transition) exactly per Jason's rule.
//
// Splitters can't be derived from geometry (they mark LEVEL branches — an AI/
// operator judgment); they enter via `extras` (P3 seeds them) or the card.
// Materials never touch the customer price — this feeds the BOM only.

import { bucketExtensionLength, type ExtSize } from './bom';

export type ExtensionCounts = { e3: number; e5: number; e10: number; e25: number };
export type TrackAccessories = ExtensionCounts & { splitters: number; jumpBoosters: number };

export type SatLine = { points: [number, number][] };
export type SatLinesBySide = Record<'front' | 'left' | 'right' | 'back', SatLine[]>;

// Mirrors QuoteBuilder.SAT_PX / satelliteMeasure.ts — the 640×640 satellite.
const SAT_PX = 640;
/** Every track cut takes one 5' extension (Jason S24). */
export const CUT_EXTENSION_FT: ExtSize = 5;
/** Endpoints ≤ this far apart are ONE physical cut (a corner), not a jump. */
export const JUNCTION_EPSILON_FT = 2;
/** A jump longer than this also needs a signal booster (Jason S24: stays >50). */
export const JUMP_BOOSTER_FT = 50;
// Street-segment steepness: |dy| > 0.3·|dx| reads as a rake/diagonal. Below it
// the segment is "flat" (gutter-level) — a flat∧flat vertex is a plan corner.
const STEEP_RATIO = 0.3;

const zero = (): TrackAccessories => ({ e3: 0, e5: 0, e10: 0, e25: 0, splitters: 0, jumpBoosters: 0 });

const KEY_BY_SIZE: Record<ExtSize, keyof ExtensionCounts> = { 3: 'e3', 5: 'e5', 10: 'e10', 25: 'e25' };

/**
 * Size one measured jump into ordered pieces — the locked Jason S24 ladder
 * ("order generously so the install is clean"):
 *   d ≤ 3  → one 5'         (a 3' would reach)
 *   d ≤ 5  → one 10'        (a 5' would reach)
 *   d ≤ 10 → 10' + 5'       ("if a 10 reaches order 10+5 — 25 is a large jump")
 *   d ≤ 25 → 25' + 5'
 *   d > 25 → the exact chain (bucketExtensionLength) + one 5' of slack
 */
export function sizeJumpExtensions(distFt: number): ExtSize[] {
  if (!Number.isFinite(distFt) || distFt <= 0) return [];
  if (distFt <= 3) return [5];
  if (distFt <= 5) return [10];
  if (distFt <= 10) return [5, 10];
  if (distFt <= 25) return [5, 25];
  const chained: ExtSize[] = [...bucketExtensionLength(distFt), 5];
  return chained.sort((a, b) => a - b);
}

type Pt = [number, number];

// Aspect-corrected distance between two normalized satellite points, in feet.
function satDistanceFt(a: Pt, b: Pt, feetPerPixel: number, aspect: number): number {
  const yScale = aspect > 0 ? 1 / aspect : 1;
  const dx = b[0] - a[0];
  const dy = (b[1] - a[1]) * yScale;
  return Math.sqrt(dx * dx + dy * dy) * SAT_PX * feetPerPixel;
}

function endpoints(line: SatLine): Pt[] {
  const pts = line?.points ?? [];
  return pts.length >= 2 ? [pts[0], pts[pts.length - 1]] : [];
}

/** Interior direction-change vertices of a polyline — each is a cut. */
function interiorVertices(pointCount: number): number {
  return Math.max(0, pointCount - 2);
}

/**
 * Chain a side's separate runs: connect each pair of runs through their
 * nearest endpoints, smallest links first, until the side is one component
 * (n runs → n−1 links). Each link ≤ JUNCTION_EPSILON_FT is a plain cut;
 * anything longer is a measured jump.
 */
function chainLinks(lines: SatLine[], feetPerPixel: number, aspect: number): number[] {
  const n = lines.length;
  if (n < 2) return [];
  const linkFt: { i: number; j: number; ft: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let best = Infinity;
      for (const a of endpoints(lines[i])) {
        for (const b of endpoints(lines[j])) {
          best = Math.min(best, satDistanceFt(a, b, feetPerPixel, aspect));
        }
      }
      if (Number.isFinite(best)) linkFt.push({ i, j, ft: best });
    }
  }
  linkFt.sort((a, b) => a.ft - b.ft);
  // Greedy union until connected (tiny n — a simple component array is fine).
  const comp = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (comp[x] === x ? x : (comp[x] = find(comp[x])));
  const links: number[] = [];
  for (const l of linkFt) {
    const a = find(l.i);
    const b = find(l.j);
    if (a === b) continue;
    comp[a] = b;
    links.push(l.ft);
    if (links.length === n - 1) break;
  }
  return links;
}

/**
 * Satellite-derived cuts + jumps. Cuts = interior vertices of every drawn side
 * line, + each ≤2ft link (within a side's chain, and between adjacent sides'
 * nearest endpoints). Links longer than the epsilon are measured jumps.
 * With NO satellite scale, only interior vertices count — link distances are
 * unknowable, so nothing is guessed.
 */
export function deriveSatelliteCutsAndJumps(
  lines: SatLinesBySide,
  feetPerPixel: number | null,
  aspect: number,
): { cuts: number; jumpsFt: number[] } {
  const sides = ['front', 'left', 'right', 'back'] as const;
  let cuts = 0;
  const jumpsFt: number[] = [];
  for (const side of sides) {
    for (const line of lines[side] ?? []) {
      cuts += interiorVertices(line?.points?.length ?? 0);
    }
  }
  if (feetPerPixel != null && feetPerPixel > 0) {
    // Within-side chains.
    for (const side of sides) {
      for (const ft of chainLinks(lines[side] ?? [], feetPerPixel, aspect)) {
        if (ft <= JUNCTION_EPSILON_FT) cuts += 1;
        else jumpsFt.push(ft);
      }
    }
    // Side-to-side junctions: the front-run end meeting the left-run start is
    // one physical corner cut. Only ADJACENT (≤ epsilon) cross-side endpoints
    // count — a far cross-side hop is ambiguous (operator/AI territory).
    for (let s = 0; s < sides.length; s++) {
      for (let t = s + 1; t < sides.length; t++) {
        let best = Infinity;
        for (const la of lines[sides[s]] ?? []) {
          for (const lb of lines[sides[t]] ?? []) {
            for (const a of endpoints(la)) {
              for (const b of endpoints(lb)) {
                best = Math.min(best, satDistanceFt(a, b, feetPerPixel, aspect));
              }
            }
          }
        }
        if (best <= JUNCTION_EPSILON_FT) cuts += 1;
      }
    }
  }
  return { cuts, jumpsFt };
}

/**
 * Street-strand elevation cuts (gable rakes/apexes). `points` is the scene
 * strand's flat [x0,y0,x1,y1,…] pixel array. A vertex counts when at least one
 * adjacent segment is steep — flat∧flat vertices are plan corners the
 * satellite already owns (the anti-double-count rule). A gable = 3 cuts:
 * flat→rake, rake→rake (apex), rake→flat.
 */
export function deriveStreetPeakCuts(strands: Array<{ points: number[] }>): number {
  let cuts = 0;
  for (const s of strands) {
    const pts = s?.points ?? [];
    const n = Math.floor(pts.length / 2);
    for (let v = 1; v < n - 1; v++) {
      const ax = pts[2 * (v - 1)], ay = pts[2 * (v - 1) + 1];
      const bx = pts[2 * v], by = pts[2 * v + 1];
      const cx = pts[2 * (v + 1)], cy = pts[2 * (v + 1) + 1];
      const steepIn = Math.abs(by - ay) > STEEP_RATIO * Math.abs(bx - ax);
      const steepOut = Math.abs(cy - by) > STEEP_RATIO * Math.abs(cx - bx);
      if (steepIn || steepOut) cuts += 1;
    }
  }
  return cuts;
}

/**
 * The card's derived counts. `extras` carries what geometry can't see —
 * AI-detected splitters and far jumps (P3) — so the derive stays one pure
 * function whatever the sources.
 */
export function deriveTrackAccessories(args: {
  satelliteLines: SatLinesBySide;
  satelliteFeetPerPixel: number | null;
  satelliteAspect: number;
  /** Canonical (non-twin) bulbType:'permanent' strand point arrays. */
  streetStrandPoints?: Array<{ points: number[] }>;
  extras?: { splitters?: number; jumpsFt?: number[] };
}): TrackAccessories {
  const acc = zero();
  const { cuts, jumpsFt } = deriveSatelliteCutsAndJumps(
    args.satelliteLines,
    args.satelliteFeetPerPixel,
    args.satelliteAspect,
  );
  const totalCuts = cuts + deriveStreetPeakCuts(args.streetStrandPoints ?? []);
  acc[KEY_BY_SIZE[CUT_EXTENSION_FT]] += totalCuts;
  const allJumps = [...jumpsFt, ...(args.extras?.jumpsFt ?? [])];
  for (const ft of allJumps) {
    for (const size of sizeJumpExtensions(ft)) acc[KEY_BY_SIZE[size]] += 1;
    if (ft > JUMP_BOOSTER_FT) acc.jumpBoosters += 1;
  }
  acc.splitters =
    typeof args.extras?.splitters === 'number' && args.extras.splitters > 0
      ? Math.floor(args.extras.splitters)
      : 0;
  return acc;
}

/** True when any drawn geometry exists to derive from (guards the auto-seed). */
export function hasAccessorySignal(
  satelliteLines: SatLinesBySide,
  streetStrandPoints?: Array<{ points: number[] }>,
): boolean {
  const anySat = (['front', 'left', 'right', 'back'] as const).some(
    (s) => (satelliteLines[s] ?? []).some((l) => (l?.points?.length ?? 0) >= 2),
  );
  return anySat || (streetStrandPoints ?? []).some((s) => (s?.points?.length ?? 0) >= 4);
}
