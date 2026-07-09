// Permanent analyzer orientation (#140 follow-up, S25): deterministic
// front/left/right/back labeling from the Street View camera's position.
// The AI's road-finding self-check flipped a real house 180° (front↔back,
// left↔right swapped) — but the camera's geodata already tells us where the
// road is: the bearing from the house to the panorama IS the direction the
// front faces (the camera sits on the road the house is addressed on). The
// satellite image is north-up (Static Maps, no rotation param), so the side
// labels reduce to pure geometry: the AI traces shapes, math sets the compass.

import type { PermanentSatelliteLines } from './photoAnalysis';

export type LatLng = { lat: number; lng: number };

const SIDES = ['front', 'left', 'right', 'back'] as const;
type Side = (typeof SIDES)[number];

/**
 * Initial bearing from `from` to `to`, degrees clockwise from north [0, 360).
 * Equirectangular approximation — house→camera is tens of meters, where this
 * is exact to well under a degree.
 */
export function bearingDegrees(from: LatLng, to: LatLng): number {
  const dLat = to.lat - from.lat;
  const dLng = (to.lng - from.lng) * Math.cos((((from.lat + to.lat) / 2) * Math.PI) / 180);
  const deg = (Math.atan2(dLng, dLat) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** 8-wind compass label for the analyzer prompt hint. */
export function compassLabel(deg: number): string {
  const winds = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return winds[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

// Unit direction each side FACES, in normalized satellite-image coords
// (x right = east, y down = south — the image is north-up). Left/right follow
// the domain rule (Jason, S25 device round — supersedes the S24 road-viewer
// wording): as if STANDING AT THE HOUSE facing the street — the homeowner's
// left hand = "left". Facing along +front, left = rotate(front) by
// screen-space -90°: (f.y, -f.x).
function sideVectors(frontBearingDeg: number): Record<Side, [number, number]> {
  const rad = (frontBearingDeg * Math.PI) / 180;
  const f: [number, number] = [Math.sin(rad), -Math.cos(rad)];
  return {
    front: f,
    back: [-f[0], -f[1]],
    left: [f[1], -f[0]],
    right: [-f[1], f[0]],
  };
}

/**
 * Re-bucket the four traced side channels so the labels match the KNOWN front
 * bearing, keeping every polyline byte-identical — only which array it lives
 * in can change. Each channel's outward direction from the perimeter centroid
 * is matched against the four side vectors; the best injective assignment
 * (≤4! = 24 options, brute-forced) wins. Returns the ORIGINAL object when the
 * AI's labels were already right (callers can reference-compare to log).
 * Fewer than 2 non-empty channels → nothing to disambiguate against → no-op.
 */
export function relabelPermanentSides(
  lines: PermanentSatelliteLines,
  frontBearingDeg: number,
): PermanentSatelliteLines {
  const nonEmpty = SIDES.filter((s) => (lines[s]?.length ?? 0) > 0);
  if (nonEmpty.length < 2) return lines;

  // Perimeter centroid over every vertex of every channel.
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const side of nonEmpty) {
    for (const seg of lines[side]) {
      for (const [x, y] of seg.points) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  if (n === 0) return lines;
  const cx = sx / n;
  const cy = sy / n;

  // Each channel's outward unit direction from the centroid.
  const channelDirs = nonEmpty.map((side) => {
    let px = 0;
    let py = 0;
    let m = 0;
    for (const seg of lines[side]) {
      for (const [x, y] of seg.points) {
        px += x;
        py += y;
        m++;
      }
    }
    const dx = px / m - cx;
    const dy = py / m - cy;
    const len = Math.hypot(dx, dy);
    return len > 1e-6 ? ([dx / len, dy / len] as [number, number]) : ([0, 0] as [number, number]);
  });

  const dirs = sideVectors(frontBearingDeg);

  // Best injective assignment channel → label, brute force.
  let bestScore = -Infinity;
  let bestLabels: Side[] | null = null;
  const assign = (i: number, used: Set<Side>, labels: Side[], score: number) => {
    if (i === nonEmpty.length) {
      if (score > bestScore) {
        bestScore = score;
        bestLabels = labels.slice();
      }
      return;
    }
    for (const side of SIDES) {
      if (used.has(side)) continue;
      const [dx, dy] = channelDirs[i];
      const [vx, vy] = dirs[side];
      used.add(side);
      labels.push(side);
      assign(i + 1, used, labels, score + dx * vx + dy * vy);
      labels.pop();
      used.delete(side);
    }
  };
  assign(0, new Set(), [], 0);
  if (!bestLabels) return lines;
  const finalLabels: Side[] = bestLabels;

  if (finalLabels.every((label, i) => label === nonEmpty[i])) return lines;

  const out: PermanentSatelliteLines = { front: [], left: [], right: [], back: [] };
  nonEmpty.forEach((side, i) => {
    out[finalLabels[i]] = lines[side];
  });
  return out;
}
