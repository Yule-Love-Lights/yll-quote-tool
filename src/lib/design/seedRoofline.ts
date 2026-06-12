// Seed the design's roofline strands from the builder's measurement polylines
// (#33). The builder already holds staff-corrected red/blue/C9 lines on the
// SAME street photo the design uses, perfectly split front vs ridge+sides —
// so instead of staff re-drawing + hand-tagging rooflines in the editor, we
// convert those lines into ordinary, editable C9 StrandItems pre-tagged
// `santas-roofline` / `gingerbread` / `winter-wonderland`. Those tags are what
// the portal's picture-toggle keys on (sceneLinks.ts).
//
// REPLACEMENT RULE (Jason, S6): the measurement is the source of truth for
// rooflines (data contract §7 — roofline is measurement-driven). Re-seeding
// REPLACES every roofline-TAGGED strand, whatever its origin. Untagged strands
// (hand-drawn C9 decor) and all other item kinds are never touched. Calling
// with no lines at all is a NO-OP — a stray sync can't wipe a tagged design.
//
// Coordinates: builder polylines are normalized (0–1 of the photo); scene
// points are photo-pixels. The design's base photo IS the analyzed street
// photo, so the conversion is exact: x×photoW, y×photoH.

import type { Scene, SceneItem, StrandItem, Surface } from './sceneTypes';
import { isStrand } from './sceneTypes';

export type NormalizedPoint = [number, number];
export type NormalizedPolyline = NormalizedPoint[];

// One optional polyline set per roofline surface. Keys mirror the builder's
// three measurement line colors (red / blue / C9 custom runs).
export type RooflineSeedLines = {
  santas?: NormalizedPolyline[];
  gingerbread?: NormalizedPolyline[];
  winterWonderland?: NormalizedPolyline[];
};

const ROOFLINE_SURFACES: ReadonlySet<string> = new Set([
  'santas-roofline',
  'gingerbread',
  'winter-wonderland',
]);

// The editor's C9 creation defaults (editor.ts tool defaults) so seeded strands
// look exactly like hand-drawn ones and stay fully editable.
const C9_SPACING_IN = 12;
const C9_COLOR_PATTERN = ['warm-white'];

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function isPoint(p: unknown): p is NormalizedPoint {
  return (
    Array.isArray(p) &&
    p.length === 2 &&
    typeof p[0] === 'number' &&
    Number.isFinite(p[0]) &&
    typeof p[1] === 'number' &&
    Number.isFinite(p[1])
  );
}

// Defensive parse of an untrusted request payload into RooflineSeedLines.
// Drops malformed points/polylines rather than failing the whole call.
export function sanitizeSeedLines(input: unknown): RooflineSeedLines {
  const out: RooflineSeedLines = {};
  if (!input || typeof input !== 'object') return out;
  const o = input as Record<string, unknown>;
  for (const key of ['santas', 'gingerbread', 'winterWonderland'] as const) {
    const raw = o[key];
    if (!Array.isArray(raw)) continue;
    const polys = raw
      .map((poly) => (Array.isArray(poly) ? poly.filter(isPoint) : []))
      .filter((poly) => poly.length >= 2);
    if (polys.length) out[key] = polys as NormalizedPolyline[];
  }
  return out;
}

export function seedLinesHaveContent(lines: RooflineSeedLines): boolean {
  return Boolean(
    lines.santas?.length || lines.gingerbread?.length || lines.winterWonderland?.length,
  );
}

function strandsFor(
  polys: NormalizedPolyline[] | undefined,
  surface: Surface,
  idPrefix: string,
  photoW: number,
  photoH: number,
): StrandItem[] {
  if (!polys) return [];
  return polys
    .filter((poly) => poly.length >= 2)
    .map((poly, i) => ({
      id: `seed-${idPrefix}-${i + 1}`,
      yardstickId: null,
      kind: 'strand' as const,
      bulbType: 'c9' as const,
      spacingIn: C9_SPACING_IN,
      drawingStyle: 'strand' as const,
      colorPattern: [...C9_COLOR_PATTERN],
      points: poly.flatMap(([x, y]) => [clamp01(x) * photoW, clamp01(y) * photoH]),
      surface,
      included: true,
    }));
}

// Pure: returns a new Scene with the roofline-tagged strands replaced by
// strands built from `lines`. No-ops (returns the input scene) when the lines
// are empty or the photo dimensions are unusable.
export function seedRooflineStrands(
  scene: Scene,
  lines: RooflineSeedLines,
  photoW: number,
  photoH: number,
): Scene {
  if (!Number.isFinite(photoW) || !Number.isFinite(photoH) || photoW <= 0 || photoH <= 0) {
    return scene;
  }
  if (!seedLinesHaveContent(lines)) return scene;

  const existing: SceneItem[] = Array.isArray(scene?.items) ? scene.items : [];
  const kept = existing.filter(
    (i) => !(isStrand(i) && i.surface && ROOFLINE_SURFACES.has(i.surface)),
  );

  const seeded: StrandItem[] = [
    ...strandsFor(lines.santas, 'santas-roofline', 'santas', photoW, photoH),
    ...strandsFor(lines.gingerbread, 'gingerbread', 'gingerbread', photoW, photoH),
    ...strandsFor(lines.winterWonderland, 'winter-wonderland', 'ww', photoW, photoH),
  ];

  return { ...scene, items: [...kept, ...seeded] };
}

// How many roofline-tagged strands a scene holds — the builder's sync feedback.
export function countRooflineStrands(scene: Scene): number {
  const items: SceneItem[] = Array.isArray(scene?.items) ? scene.items : [];
  return items.filter((i) => isStrand(i) && i.surface && ROOFLINE_SURFACES.has(i.surface)).length;
}
