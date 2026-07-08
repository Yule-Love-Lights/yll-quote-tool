// Bridge auto-design (#35 Phase 2): convert the EXISTING AI's analysis output
// — roofline polylines + per-unit detections, all in normalized 0–1 photo
// coords — into real design scene items. This is the v0 of "the AI designs the
// house": today's detection brain feeds the design tool; #8 (Phase 3) then
// upgrades the brain, reusing this exact plumbing.
//
// Mapping (per the data contract — billed spec in quote* fields, visuals are
// just sensible defaults staff can restyle):
//   roofline lines  → tagged C9 strands (seedRoofline — replacement by TAG)
//   bush / tree     → Scattershot MiniAreaItem at the box (AI's stringCount)
//   column          → a vertical mini strand through the box (column wraps
//                     stay strand-based — contract A2)
//   wreath          → WreathItem at the box center (quoteSize/tier from AI)
//   spritzer        → SpritzerItem at the box center (quoteSize from AI)
//   garland         → GarlandItem run across the box (quoteLength/tier from
//                     AI; quoteSections defaults to 1 — staff set the count)
//
// REPLACEMENT RULE: AI-seeded items carry a `seed-` id prefix. Re-seeding
// replaces ONLY seed-* items (any kind) — staff-drawn items are never touched.
// Roofline-TAGGED strands additionally follow #33's rule (the measurement owns
// the roofline, whatever drew it). Empty payloads are NO-OPs — a stray re-seed
// can never wipe a design.

import type {
  Scene,
  SceneItem,
  StrandItem,
  MiniAreaItem,
  WreathItem,
  SpritzerItem,
  GarlandItem as SceneGarlandItem,
  Yardstick,
  QuoteWreathSize,
  QuoteSpritzerSize,
  QuoteGarlandLength,
  Tier,
  WrapStyle,
} from './sceneTypes';
import { isStrand } from './sceneTypes';
import {
  seedRooflineStrands,
  sanitizeSeedLines,
  seedLinesHaveContent,
  type RooflineSeedLines,
} from './seedRoofline';
import { firstYardstickPpf } from './yardstickPpf';

export type NormalizedBox = [number, number, number, number]; // x, y, w, h — 0–1 of the photo

export type MiniDetection = {
  type: 'tree' | 'bush' | 'column' | 'railing';
  wrapStyle: WrapStyle;
  stringCount: number;
  box: NormalizedBox;
};
export type WreathDetection = { size: QuoteWreathSize; tier: Tier; box: NormalizedBox };
export type SpritzerDetection = { size: QuoteSpritzerSize; box: NormalizedBox };
export type GarlandDetection = { length: QuoteGarlandLength; tier: Tier; box: NormalizedBox };

export type AnalysisDetections = {
  miniLights?: MiniDetection[];
  wreaths?: WreathDetection[];
  spritzers?: SpritzerDetection[];
  garland?: GarlandDetection[];
};

// Permanent street run (#140 P3): a track run the permanent analyzer traced on
// the STREET photo, tagged with its house side. Becomes a bulbType:'permanent'
// strand — VISUAL + portal only (billing footage stays satellite-sourced).
export type PermanentRunSeed = {
  side: 'front' | 'left' | 'right';
  points: [number, number][]; // normalized 0-1 street-photo coords
};

export type AnalysisSeed = {
  lines?: RooflineSeedLines;
  detections?: AnalysisDetections;
  // The AI's roofline footage estimates — paired with the drawn lines they
  // yield pixels-per-foot, which seeds the SCALE yardstick (below).
  // winterWonderlandFootage (audit fix, finding #46): WW C9 runs are a
  // first-class roofline family elsewhere (quote/route.ts, QuoteBuilder C9), so
  // a WW-only roofline can now calibrate scale too.
  calibration?: { santasFootage?: number; gingerbreadFootage?: number; winterWonderlandFootage?: number };
  // #140 P3: permanent street runs (see PermanentRunSeed above).
  permanentRuns?: PermanentRunSeed[];
};

const SEED_PREFIX = 'seed-';

// The seeded scale yardstick (5 ft — Jason's pick, S6). Its WIDTH is the
// measuring dimension (pxPerFoot = width / realFeet — see
// editor-core/yardstick.ts); height is cosmetic.
const YARDSTICK_REAL_FEET = 5;
// The permanent DEFAULT (uncalibrated) yardstick labels 10 ft (Jason, S23) — its
// own constant so it doesn't move the holiday calibrated seed above.
const PERMANENT_DEFAULT_YARDSTICK_FEET = 10;

/**
 * A DEFAULT (uncalibrated) scale yardstick for a design that has NO analyzer to
 * derive real px/ft from — permanent quotes (#88). Parity with the holiday
 * auto-yardstick (same `seed-` id, same lower-left corner position) MINUS the AI
 * calibration: it labels 10 ft (Jason's pick) and the width is a fixed FRACTION
 * of the photo (a visible, proportional handle), so the operator sizes it against
 * a known object (garage door ≈ 16 ft, etc.). The `seed-` id keeps "staff
 * calibration wins" intact — a hand-dropped yardstick (non-seed id) supersedes it.
 */
export function makeDefaultYardstick(photoW: number, photoH: number): Yardstick {
  const width = round2(photoW * 0.15);
  return {
    id: `${SEED_PREFIX}yardstick-1`,
    realFeet: PERMANENT_DEFAULT_YARDSTICK_FEET,
    x: round2(photoW * 0.04),
    y: round2(photoH * 0.74),
    width,
    height: round2(width * 0.45), // cosmetic — only width measures
  };
}
// Plausibility bounds for a derived pixels-per-foot — outside this range the
// calibration inputs are garbage (degenerate line, absurd footage).
const MIN_PPF = 2;
const MAX_PPF = 500;
// Audit fix (finding #84): an upper ceiling for a seeded mini stringCount.
// stringCount drives price, so a hallucinated AI detection (e.g.
// stringCount:1000) would seed a runaway billed quantity. This guard lives ONLY
// on the AI-seed path — the shared projectScene projection must NOT cap, or it
// would wrongly truncate a legitimate large MANUAL quote. The ceiling is
// deliberately generous: it only trips on an obviously-hallucinated count, well
// above any plausible real wrap. Clamp (don't reject) — staff can still override
// upward via the QuoteBuilder stringCount input for a genuine big wrap.
const REASONABLE_MAX_STRINGS = 50;

// Visual defaults for seeded items (staff restyle freely — visuals never
// drive price). Mirrors the editor's creation defaults where one exists.
const MINI_AREA_DENSITY = 0.5;
const WARM_WHITE = ['warm-white'];
const WREATH_VISUAL_SIZE_IN = 36;
const SPRITZER_VISUAL_SIZE_IN = 24;

const MINI_TYPES = new Set(['tree', 'bush', 'column', 'railing']);
const WRAP_STYLES = new Set(['canopy', 'trunk']);
const WREATH_SIZES = new Set(['24noble', '30noble', '36noble', '48noble', '60noble', '72noble']);
const SPRITZER_SIZES = new Set(['16', '24', '32']);
const GARLAND_LENGTHS = new Set(['4.5ft', '9ft']);
const TIERS = new Set(['bow', 'fullDecor']); // #17: 'labor' retired

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function isBox(b: unknown): b is NormalizedBox {
  return (
    Array.isArray(b) &&
    b.length === 4 &&
    b.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    b[2] > 0 &&
    b[3] > 0
  );
}

// Defensive parse of an untrusted request payload. Drops malformed entries
// (bad boxes, unknown enums) instead of failing the call; reuses the roofline
// sanitizer for the lines half.
export function sanitizeAnalysisSeed(input: unknown): AnalysisSeed {
  const out: AnalysisSeed = {};
  if (!input || typeof input !== 'object') return out;
  const o = input as Record<string, unknown>;
  const lines = sanitizeSeedLines(o.lines);
  if (seedLinesHaveContent(lines)) out.lines = lines;

  const cal = o.calibration;
  if (cal && typeof cal === 'object') {
    const c = cal as Record<string, unknown>;
    const calibration: NonNullable<AnalysisSeed['calibration']> = {};
    if (typeof c.santasFootage === 'number' && Number.isFinite(c.santasFootage) && c.santasFootage > 0) {
      calibration.santasFootage = c.santasFootage;
    }
    if (typeof c.gingerbreadFootage === 'number' && Number.isFinite(c.gingerbreadFootage) && c.gingerbreadFootage > 0) {
      calibration.gingerbreadFootage = c.gingerbreadFootage;
    }
    // Audit fix (finding #46): mirror the santas/gingerbread guard for WW.
    if (typeof c.winterWonderlandFootage === 'number' && Number.isFinite(c.winterWonderlandFootage) && c.winterWonderlandFootage > 0) {
      calibration.winterWonderlandFootage = c.winterWonderlandFootage;
    }
    if (Object.keys(calibration).length) out.calibration = calibration;
  }

  // #140 P3: permanent street runs — side must be a street-visible side (back
  // never comes from street view), points must be ≥2 finite pairs.
  const PERM_SIDES = new Set(['front', 'left', 'right']);
  if (Array.isArray(o.permanentRuns)) {
    const runs: PermanentRunSeed[] = [];
    for (const r of o.permanentRuns as unknown[]) {
      if (!r || typeof r !== 'object') continue;
      const run = r as { side?: unknown; points?: unknown };
      if (!PERM_SIDES.has(run.side as string) || !Array.isArray(run.points)) continue;
      const pts = (run.points as unknown[])
        .filter(
          (p): p is [number, number] =>
            Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)),
        )
        .map(([x, y]) => [clamp01(x), clamp01(y)] as [number, number]);
      if (pts.length >= 2) runs.push({ side: run.side as PermanentRunSeed['side'], points: pts });
    }
    if (runs.length) out.permanentRuns = runs.slice(0, 40); // sanity cap
  }

  const d = o.detections;
  if (d && typeof d === 'object') {
    const det = d as Record<string, unknown>;
    const detections: AnalysisDetections = {};
    if (Array.isArray(det.miniLights)) {
      const minis = det.miniLights.filter(
        (m): m is MiniDetection =>
          !!m &&
          typeof m === 'object' &&
          MINI_TYPES.has((m as MiniDetection).type) &&
          WRAP_STYLES.has((m as MiniDetection).wrapStyle) &&
          typeof (m as MiniDetection).stringCount === 'number' &&
          Number.isFinite((m as MiniDetection).stringCount) &&
          isBox((m as MiniDetection).box),
      );
      if (minis.length) detections.miniLights = minis;
    }
    if (Array.isArray(det.wreaths)) {
      const ws = det.wreaths.filter(
        (w): w is WreathDetection =>
          !!w &&
          typeof w === 'object' &&
          WREATH_SIZES.has((w as WreathDetection).size) &&
          TIERS.has((w as WreathDetection).tier) &&
          isBox((w as WreathDetection).box),
      );
      if (ws.length) detections.wreaths = ws;
    }
    if (Array.isArray(det.spritzers)) {
      const sp = det.spritzers.filter(
        (s): s is SpritzerDetection =>
          !!s &&
          typeof s === 'object' &&
          SPRITZER_SIZES.has((s as SpritzerDetection).size) &&
          isBox((s as SpritzerDetection).box),
      );
      if (sp.length) detections.spritzers = sp;
    }
    if (Array.isArray(det.garland)) {
      const g = det.garland.filter(
        (x): x is GarlandDetection =>
          !!x &&
          typeof x === 'object' &&
          GARLAND_LENGTHS.has((x as GarlandDetection).length) &&
          TIERS.has((x as GarlandDetection).tier) &&
          isBox((x as GarlandDetection).box),
      );
      if (g.length) detections.garland = g;
    }
    if (Object.keys(detections).length) out.detections = detections;
  }
  return out;
}

export function detectionsHaveContent(d: AnalysisDetections | undefined): boolean {
  return Boolean(
    d && (d.miniLights?.length || d.wreaths?.length || d.spritzers?.length || d.garland?.length),
  );
}

export function analysisSeedHasContent(seed: AnalysisSeed): boolean {
  return Boolean(
    (seed.lines && seedLinesHaveContent(seed.lines)) ||
      detectionsHaveContent(seed.detections) ||
      (seed.permanentRuns?.length ?? 0) > 0,
  );
}

// A normalized box → pixel-space rect, clamped into the photo. Coords round
// to 2 decimals — sub-pixel float noise has no business living in a scene.
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Pixel length of normalized polylines on a w×h photo.
function lineLengthPx(
  polys: RooflineSeedLines['santas'],
  w: number,
  h: number,
): number {
  let total = 0;
  for (const poly of polys ?? []) {
    for (let i = 1; i < poly.length; i++) {
      const dx = (clamp01(poly[i][0]) - clamp01(poly[i - 1][0])) * w;
      const dy = (clamp01(poly[i][1]) - clamp01(poly[i - 1][1])) * h;
      total += Math.sqrt(dx * dx + dy * dy);
    }
  }
  return total;
}

// Derive pixels-per-foot from the AI's own roofline: the drawn line's pixel
// length ÷ its footage estimate (the same calibration the old street overlay
// used). Prefers the front gutterline; falls back to ridge+sides. Null when
// the inputs are missing or implausible.
export function derivePxPerFoot(seed: AnalysisSeed, w: number, h: number): number | null {
  const cal = seed.calibration;
  if (!cal) return null;
  const candidates: [RooflineSeedLines['santas'], number | undefined][] = [
    [seed.lines?.santas, cal.santasFootage],
    [seed.lines?.gingerbread, cal.gingerbreadFootage],
    // Audit fix (finding #46): a WW-only roofline can now calibrate scale.
    [seed.lines?.winterWonderland, cal.winterWonderlandFootage],
  ];
  for (const [polys, feet] of candidates) {
    if (!polys?.length || typeof feet !== 'number' || !Number.isFinite(feet) || feet <= 0) continue;
    const px = lineLengthPx(polys, w, h);
    if (px <= 0) continue;
    const ppf = px / feet;
    if (ppf >= MIN_PPF && ppf <= MAX_PPF) return ppf;
  }
  return null;
}

// The scale used to size garland runs (#90): the AI's roofline calibration when
// present, else the staff (or leftover seed) yardstick. Null = no scale of any
// kind → garland falls back to 1 section and is surfaced via
// countSeededGarlandUnestimated so staff can set the count.
function effectiveSeedPpf(seed: AnalysisSeed, scene: Scene, w: number, h: number): number | null {
  return derivePxPerFoot(seed, w, h) ?? firstYardstickPpf(scene);
}

function pxBox(box: NormalizedBox, w: number, h: number) {
  const x0 = clamp01(box[0]);
  const y0 = clamp01(box[1]);
  const x1 = clamp01(box[0] + box[2]);
  const y1 = clamp01(box[1] + box[3]);
  return {
    x: round2(x0 * w),
    y: round2(y0 * h),
    width: round2((x1 - x0) * w),
    height: round2((y1 - y0) * h),
  };
}

function detectionItems(d: AnalysisDetections, w: number, h: number, ppf: number | null): SceneItem[] {
  const items: SceneItem[] = [];

  (d.miniLights ?? []).forEach((m, i) => {
    const r = pxBox(m.box, w, h);
    // Audit fix (finding #84): clamp the seeded string count to a sane ceiling.
    const stringCount = Math.min(Math.max(1, Math.round(m.stringCount)), REASONABLE_MAX_STRINGS);
    if (m.type === 'column' || m.type === 'railing') {
      // Columns + railings stay strand-based (contract A2): a straight line through
      // the box — column = VERTICAL, railing = HORIZONTAL along the top rail.
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const points = m.type === 'column'
        ? [cx, r.y, cx, r.y + r.height]
        : [r.x, cy, r.x + r.width, cy];
      const strand: StrandItem = {
        id: `${SEED_PREFIX}mini-${i + 1}`,
        yardstickId: null,
        kind: 'strand',
        bulbType: 'mini',
        spacingIn: 6,
        drawingStyle: 'strand',
        colorPattern: [...WARM_WHITE],
        points,
        surface: m.type,
        included: true,
        wrapStyle: m.wrapStyle,
        stringCount,
      };
      items.push(strand);
    } else {
      const area: MiniAreaItem = {
        id: `${SEED_PREFIX}mini-${i + 1}`,
        yardstickId: null,
        kind: 'miniArea',
        shape: 'box',
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        density: MINI_AREA_DENSITY,
        colorPattern: [...WARM_WHITE],
        surface: m.type,
        included: true,
        wrapStyle: m.wrapStyle,
        stringCount,
      };
      items.push(area);
    }
  });

  (d.wreaths ?? []).forEach((wd, i) => {
    const r = pxBox(wd.box, w, h);
    const wreath: WreathItem = {
      id: `${SEED_PREFIX}wreath-${i + 1}`,
      yardstickId: null,
      kind: 'wreath',
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      sizeIn: WREATH_VISUAL_SIZE_IN,
      withLights: true,
      quoteSize: wd.size,
      tier: wd.tier,
      included: true,
    };
    items.push(wreath);
  });

  (d.spritzers ?? []).forEach((sd, i) => {
    const r = pxBox(sd.box, w, h);
    const spritzer: SpritzerItem = {
      id: `${SEED_PREFIX}spritzer-${i + 1}`,
      yardstickId: null,
      kind: 'spritzer',
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      sizeIn: SPRITZER_VISUAL_SIZE_IN,
      colorPattern: [...WARM_WHITE],
      quoteSize: sd.size,
      included: true,
    };
    items.push(spritzer);
  });

  (d.garland ?? []).forEach((gd, i) => {
    const r = pxBox(gd.box, w, h);
    // Billed section count from the run's real-world length when a scale is
    // available (#8 Stage C / C4): runFeet = run px ÷ pixels-per-foot
    // (derived from the AI's roofline, same scale that sizes the yardstick),
    // then sections = ceil(runFeet / section length) — the documented garland
    // convention ("piece count = ceil(widthFt / 9)", see photoAnalysis). With
    // no scale (no roofline calibration on this quote) fall back to ONE section;
    // staff set the count. Under-billing beats silently over-billing.
    // Audit fix (finding #72): use the LONGER axis of the box, not width only —
    // a diagonal/near-vertical run (porch post, doorway arch, gable rake) has a
    // box width far smaller than the true run length, which undercounts sections.
    const sectionFeet = gd.length === '4.5ft' ? 4.5 : 9;
    const runPx = Math.max(r.width, r.height);
    const quoteSections =
      ppf && ppf > 0 ? Math.max(1, Math.ceil(runPx / ppf / sectionFeet)) : 1;
    // Draw the seed segment along the longer axis so the visual matches the run
    // we billed (horizontal for a wide box, vertical for a tall one).
    const vertical = r.height > r.width;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const points: [number, number, number, number] = vertical
      ? [cx, r.y, cx, r.y + r.height]
      : [r.x, cy, r.x + r.width, cy];
    const garland: SceneGarlandItem = {
      id: `${SEED_PREFIX}garland-${i + 1}`,
      yardstickId: null,
      kind: 'garland',
      points,
      drawingStyle: 'strand',
      withLights: true,
      quoteLength: gd.length,
      quoteSections,
      tier: gd.tier,
      included: true,
    };
    items.push(garland);
  });

  return items;
}

// Pure: roofline lines via #33's tag-replacement, then per-unit detections via
// the seed-* id-replacement. Either half being empty is a NO-OP for that half.
export function seedSceneFromAnalysis(
  scene: Scene,
  seed: AnalysisSeed,
  photoW: number,
  photoH: number,
): Scene {
  if (!Number.isFinite(photoW) || !Number.isFinite(photoH) || photoW <= 0 || photoH <= 0) {
    return scene;
  }
  let out = scene;

  // SCALE FIRST: without a yardstick the renderer guesses 50 px/ft and seeded
  // wreaths/spritzers render comically large. Derive the real scale from the
  // AI's roofline estimate and seed a 5 ft yardstick. STAFF CALIBRATION WINS:
  // any non-seed yardstick in the scene means we leave the array untouched;
  // otherwise we add (or replace) OUR seed yardstick. Seeded items bind to
  // yardstickId:null = "the first yardstick", so staff replacing it with their
  // own front-door box re-scales everything instantly.
  const ppf = derivePxPerFoot(seed, photoW, photoH);
  if (ppf != null) {
    const existingYs: Yardstick[] = Array.isArray(out?.yardsticks) ? out.yardsticks : [];
    const hasStaffYardstick = existingYs.some((y) => !y.id.startsWith(SEED_PREFIX));
    if (!hasStaffYardstick) {
      const width = round2(YARDSTICK_REAL_FEET * ppf);
      const ys: Yardstick = {
        id: `${SEED_PREFIX}yardstick-1`,
        realFeet: YARDSTICK_REAL_FEET,
        x: round2(photoW * 0.04),
        y: round2(photoH * 0.74),
        width,
        height: round2(width * 0.45), // cosmetic — only width measures
      };
      out = { ...out, yardsticks: [ys] };
    }
  }

  if (seed.lines && seedLinesHaveContent(seed.lines)) {
    out = seedRooflineStrands(out, seed.lines, photoW, photoH);
  }

  // #140 P3: permanent street runs → bulbType:'permanent' strands tagged with
  // their sideOfHouse. Replace-on-reseed swaps ONLY previously-seeded permanent
  // strands (seed-* id + bulbType 'permanent') — hand-drawn permanent strands
  // and every holiday item survive. Visual + portal only: billing footage stays
  // satellite-sourced (the permanent money model).
  if ((seed.permanentRuns?.length ?? 0) > 0) {
    const existing: SceneItem[] = Array.isArray(out?.items) ? out.items : [];
    const kept = existing.filter(
      (i) => !(i.id.startsWith(SEED_PREFIX) && isStrand(i) && i.bulbType === 'permanent'),
    );
    const seeded: StrandItem[] = seed.permanentRuns!.map((run, i) => ({
      id: `${SEED_PREFIX}perm-${i + 1}`,
      yardstickId: null,
      kind: 'strand',
      bulbType: 'permanent',
      spacingIn: 8, // the locked permanent spacing (S28)
      drawingStyle: 'strand',
      colorPattern: ['warm-white'],
      points: run.points.flatMap(([x, y]) => [round2(clamp01(x) * photoW), round2(clamp01(y) * photoH)]),
      sideOfHouse: run.side,
      included: true,
    }));
    out = { ...out, items: [...kept, ...seeded] };
    // A permanent seed has no holiday calibration, so the SCALE FIRST block
    // above never fires — without this the analyze path ships a design with NO
    // yardstick (the createDesign default-yardstick branch is skipped whenever
    // an analysis seed is present). Seed the permanent default 10 ft yardstick,
    // but ONLY into an empty array: unlike holiday's recalibration, the default
    // carries no new information, so an existing (possibly operator-resized)
    // yardstick always wins.
    const existingYs: Yardstick[] = Array.isArray(out?.yardsticks) ? out.yardsticks : [];
    if (existingYs.length === 0) {
      out = { ...out, yardsticks: [makeDefaultYardstick(photoW, photoH)] };
    }
  }

  if (detectionsHaveContent(seed.detections)) {
    const existing: SceneItem[] = Array.isArray(out?.items) ? out.items : [];
    // Replace previously AI-seeded PER-UNIT items: seed-* ids that are not
    // roofline strands (those belong to the tag rule above) and not permanent
    // runs (the #140 block above owns those). Staff items — any id without the
    // prefix — always survive.
    const kept = existing.filter((i) => {
      if (!i.id.startsWith(SEED_PREFIX)) return true;
      return isStrand(i) && (i.bulbType === 'c9' || i.bulbType === 'permanent');
    });
    // #90: garland section count uses the roofline calibration when present, else
    // the staff (or leftover seed) yardstick — so a long run with a drawn
    // yardstick but no calibrated roofline isn't silently billed as 1 section.
    // No scale of any kind → null → the deliberate 1-section default.
    const garlandPpf = ppf ?? firstYardstickPpf(out);
    out = { ...out, items: [...kept, ...detectionItems(seed.detections!, photoW, photoH, garlandPpf)] };
  }

  return out;
}

// Seeded-item counts for API feedback / builder status lines.
export function countSeededItems(scene: Scene): { roofline: number; perUnit: number } {
  const items: SceneItem[] = Array.isArray(scene?.items) ? scene.items : [];
  let roofline = 0;
  let perUnit = 0;
  for (const i of items) {
    if (!i.id.startsWith(SEED_PREFIX)) continue;
    // Permanent runs count as "roofline" here — they're roof-run strands too
    // (the counts feed builder status lines, not billing).
    if (isStrand(i) && (i.bulbType === 'c9' || i.bulbType === 'permanent')) roofline++;
    else perUnit++;
  }
  return { roofline, perUnit };
}

// #90: how many AI-seeded garland runs got NO usable scale (no roofline
// calibration AND no yardstick) and therefore fell back to the deliberate
// 1-section default. Gated on the SAME effective ppf detectionItems used, so it
// exactly matches what was seeded — when any scale exists every garland is
// estimated (→ 0). The seed-analysis route + createDesign surface this so the
// builder can warn "N garland runs need section counts before quoting."
export function countSeededGarlandUnestimated(
  seed: AnalysisSeed,
  scene: Scene,
  photoW: number,
  photoH: number,
): number {
  if (effectiveSeedPpf(seed, scene, photoW, photoH) != null) return 0;
  const items: SceneItem[] = Array.isArray(scene?.items) ? scene.items : [];
  return items.filter((i) => i.id.startsWith(`${SEED_PREFIX}garland-`)).length;
}
