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

import type { Scene, SceneItem, StrandItem, Surface, RoofFeature } from './sceneTypes';
import { isStrand } from './sceneTypes';
// #843 fix 2: derived (not a fresh literal) so a future spacing trim moves
// this automatically instead of orphaning it again -- row 248 originally
// shipped C9_SPACING_IN as a hand literal (12) that immediately drifted
// off-preset the moment the row-248 trim landed (#834 caught it). The
// editor-core -> src/lib import direction is already established (this
// same module's sizePresets.ts is imported by toolDefaults.ts; colors.ts /
// yardstick-scale.ts are imported the same way by materialsProjection.ts
// and others), so this crosses no boundary the repo avoids.
import { C9_SPACINGS } from '@/components/design/editor-core/sizePresets';

export type NormalizedPoint = [number, number];
export type NormalizedPolyline = NormalizedPoint[];

export type RooflineSurfaceKey = 'santas' | 'gingerbread' | 'winterWonderland' | 'stakeLighting';

// One optional polyline set per roofline surface. Keys mirror the builder's
// three measurement line colors (red / blue / C9 custom runs).
export type RooflineSeedLines = {
  santas?: NormalizedPolyline[];
  gingerbread?: NormalizedPolyline[];
  winterWonderland?: NormalizedPolyline[];
  stakeLighting?: NormalizedPolyline[];
  // #82 2c: AI-detected physical roof feature per polyline, index-aligned with the
  // arrays above (santas[i] ↔ features.santas[i]). Additive + optional: absent ⇒
  // no auto-feature (staff set it via the editor dropdown). sanitizeSeedLines keeps
  // the alignment when it drops a malformed polyline.
  features?: Partial<Record<RooflineSurfaceKey, (RoofFeature | null)[]>>;
};

const ROOFLINE_SURFACES: ReadonlySet<string> = new Set([
  'santas-roofline',
  'gingerbread',
  'winter-wonderland',
  'stake-lighting',
]);

// The editor's C9 creation defaults (editor.ts tool defaults) so seeded strands
// look exactly like hand-drawn ones and stay fully editable.
// Jason 2026-08-20: the Medium preset after the row-248 trim (12 is no
// longer a selectable preset; drawn spacing is design-only aesthetics — the
// materials projection pins real orders to the 12" install standard, #834).
// Derived from C9_SPACINGS' own middle entry (not a fresh literal) so a
// future trim can't orphan this again the way it did on the first pass.
const C9_SPACING_IN = C9_SPACINGS[Math.floor(C9_SPACINGS.length / 2)];
const C9_COLOR_PATTERN = ['warm-white'];

// Valid physical roof features (the full RoofFeature union). The AI emits the
// residential subset; stake runs default to 'pathway'.
const ROOF_FEATURES: ReadonlySet<string> = new Set([
  'gutter', 'peak', 'side', 'ridge', 'pathway', 'flat', 'metal',
]);
function asRoofFeature(v: unknown): RoofFeature | null {
  return typeof v === 'string' && ROOF_FEATURES.has(v) ? (v as RoofFeature) : null;
}

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
  const rawFeatures =
    o.features && typeof o.features === 'object' ? (o.features as Record<string, unknown>) : {};
  for (const key of ['santas', 'gingerbread', 'winterWonderland', 'stakeLighting'] as const) {
    const raw = o[key];
    if (!Array.isArray(raw)) continue;
    // #82 2c: features are index-aligned with the raw polyline array; zip + filter
    // TOGETHER so dropping a malformed polyline never drifts the feature index.
    const rf = Array.isArray(rawFeatures[key]) ? (rawFeatures[key] as unknown[]) : [];
    const polys: NormalizedPolyline[] = [];
    const feats: (RoofFeature | null)[] = [];
    raw.forEach((poly, i) => {
      const clean = Array.isArray(poly) ? poly.filter(isPoint) : [];
      if (clean.length >= 2) {
        polys.push(clean as NormalizedPolyline);
        feats.push(asRoofFeature(rf[i]));
      }
    });
    if (polys.length) {
      out[key] = polys;
      if (feats.some((f) => f !== null)) (out.features ??= {})[key] = feats;
    }
  }
  return out;
}

export function seedLinesHaveContent(lines: RooflineSeedLines): boolean {
  return Boolean(
    lines.santas?.length ||
      lines.gingerbread?.length ||
      lines.winterWonderland?.length ||
      lines.stakeLighting?.length,
  );
}

function strandsFor(
  polys: NormalizedPolyline[] | undefined,
  surface: Surface,
  idPrefix: string,
  photoW: number,
  photoH: number,
  features?: (RoofFeature | null)[],
  defaultFeature: RoofFeature | null = null,
): StrandItem[] {
  if (!polys) return [];
  // Pair each polyline with its index-aligned feature BEFORE filtering, so a
  // dropped short polyline never misaligns the features (#82 2c).
  return polys
    .map((poly, i) => ({ poly, feature: features?.[i] ?? defaultFeature }))
    .filter(({ poly }) => poly.length >= 2)
    .map(({ poly, feature }, i) => {
      const strand: StrandItem = {
        id: `seed-${idPrefix}-${i + 1}`,
        yardstickId: null,
        kind: 'strand',
        bulbType: 'c9',
        spacingIn: C9_SPACING_IN,
        drawingStyle: 'strand',
        colorPattern: [...C9_COLOR_PATTERN],
        points: poly.flatMap(([x, y]) => [clamp01(x) * photoW, clamp01(y) * photoH]),
        surface,
        included: true,
      };
      if (feature) strand.roofFeature = feature; // omit when unset — staff sets it
      return strand;
    });
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

  const f = lines.features ?? {};
  const seeded: StrandItem[] = [
    ...strandsFor(lines.santas, 'santas-roofline', 'santas', photoW, photoH, f.santas),
    ...strandsFor(lines.gingerbread, 'gingerbread', 'gingerbread', photoW, photoH, f.gingerbread),
    ...strandsFor(lines.winterWonderland, 'winter-wonderland', 'ww', photoW, photoH, f.winterWonderland),
    // Stake-lighting runs physically use pathway ground stakes → default 'pathway'.
    ...strandsFor(lines.stakeLighting, 'stake-lighting', 'stake', photoW, photoH, f.stakeLighting, 'pathway'),
  ];

  return { ...scene, items: [...kept, ...seeded] };
}

// How many roofline-tagged strands a scene holds — the builder's sync feedback.
export function countRooflineStrands(scene: Scene): number {
  const items: SceneItem[] = Array.isArray(scene?.items) ? scene.items : [];
  return items.filter((i) => isStrand(i) && i.surface && ROOFLINE_SURFACES.has(i.surface)).length;
}
