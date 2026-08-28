import sharp from 'sharp';
import { getClaudeClient } from './claude';
import type { StoredReferenceAsset } from './referenceAssets';
import { footageFromLines, satelliteFootageDisagrees } from './design/polylineFootage';
import {
  buildDoorAnchorPrompt,
  isValidDoorAnchorModelResult,
  doorAnchorScaleFromModelResult,
  rescaleFtPerPxToOriginal,
  type DoorAnchorSource,
} from './design/doorAnchor';

// Fail-safe (analyzer outage): when the Claude analysis fails, the analyze
// routes still return the Street View + satellite imagery so staff can design
// the house manually. This is the user-facing message for that degraded state.
export const ANALYZER_UNAVAILABLE_MESSAGE =
  "The auto-design analyzer is temporarily unavailable, so the design wasn't auto-generated. Your photos are loaded — design the house manually and Calculate, or click Analyze again in a few minutes to retry the auto-design.";

// Physical roof feature the AI can classify per roofline segment (#82 Slice 2c).
// Drives the inventory clip-SKU selection (separate from the red/blue Santa's/
// Gingerbread billing split). The residential subset visible in a photo —
// 'pathway' (ground stake) + 'flat' (commercial parapet) are set elsewhere.
export type RoofFeatureClass = 'gutter' | 'peak' | 'side' | 'ridge' | 'metal';

export type LineSegment = {
  points: [number, number][]; // normalized 0-1 coords: [[x1,y1], [x2,y2], ...]
  label: string;               // e.g. "front gutter ~40ft"
  feature?: RoofFeatureClass;  // physical clip feature (#82 2c); omitted when unsure
};

export type MiniLightDetection = {
  type: 'tree' | 'bush' | 'column' | 'railing';
  wrapStyle: 'canopy' | 'trunk';
  stringCount: number;
  box: [number, number, number, number]; // [x, y, width, height] normalized 0-1
  label: string; // e.g. "small bush — 2 strings"
};

export type WreathSize = '24noble' | '30noble' | '36noble' | '48noble' | '60noble' | '72noble';
export type WreathTier = 'bow' | 'fullDecor'; // bow = Non-Decorated, fullDecor = Decorated (#17)

export type WreathDetection = {
  size: WreathSize;
  tier: WreathTier;
  box: [number, number, number, number]; // [x, y, width, height] normalized 0-1
  label: string; // e.g. "front door wreath ~30in"
};

export type SpritzerSize = '16' | '24' | '32';

export type SpritzerDetection = {
  size: SpritzerSize;
  box: [number, number, number, number]; // [x, y, width, height] normalized 0-1
  label: string; // e.g. "metallic star spritzer 24in"
};

export type GarlandLength = '9ft' | '4.5ft';
export type GarlandTier = 'bow' | 'fullDecor'; // bow = Non-Decorated, fullDecor = Decorated (#17)

// Garland is a linear run (railing, archway, porch beam). Box WIDTH in real
// feet = garland length. Piece count = ceil(widthFt / 9). Measured on the
// photo with a box, same UX as columns.
export type GarlandDetection = {
  length: GarlandLength;
  tier: GarlandTier;
  box: [number, number, number, number];
  label: string; // e.g. "porch railing garland ~18ft"
};

export type PhotoAnalysisResult = {
  santasFootage: number;
  santasDifficulty: 'easy' | 'medium' | 'hard';
  santasLines: LineSegment[];
  gingerbreadFootage: number;
  gingerbreadDifficulty: 'easy' | 'medium' | 'hard';
  gingerbreadLines: LineSegment[];
  // Satellite-based measurements (when satellite image is supplied).
  // Polylines are in satellite image coordinates. Footage computed
  // from satellite pixel distance × known feet-per-pixel scale.
  satelliteSantasLines: LineSegment[];
  satelliteSantasFootage: number;
  satelliteGingerbreadLines: LineSegment[];
  satelliteGingerbreadFootage: number;
  // SHADOW MODE (deterministic-satellite-footage): footage recomputed in pure
  // TypeScript from the model's OWN satelliteSantasLines/satelliteGingerbreadLines
  // (src/lib/design/polylineFootage.ts), alongside — never replacing — the
  // model's self-reported satelliteSantasFootage/satelliteGingerbreadFootage
  // above. null when it couldn't be computed (no satellite image dimensions or
  // no feet-per-pixel scale — see polylineFootage.ts's degenerate-input table).
  // Nothing that reaches pricing reads these two fields today.
  computedSatelliteSantasFootage: number | null;
  computedSatelliteGingerbreadFootage: number | null;
  // True when the computed footage above disagrees with the model's own
  // stated footage by more than SATELLITE_FOOTAGE_DISAGREEMENT_THRESHOLD_PCT
  // (polylineFootage.ts). Always false when the computed value is null.
  satelliteSantasFootageDisagrees: boolean;
  satelliteGingerbreadFootageDisagrees: boolean;
  // SHADOW MODE (door-anchor scale, spike PR #922): a feet-per-pixel scale
  // derived from a SEPARATE, cheap vision call that locates the front door
  // or garage door in the STREET photo (src/lib/design/doorAnchor.ts) — a
  // candidate alternative to the staff-placed yardstick (measured
  // unreliable: one address yardsticked twice disagreed by 72%). Nothing
  // that reaches pricing, projection, or the analyzer's own detections reads
  // these three fields today; they exist to start collecting real-world
  // agreement data against the yardstick (scripts/door-anchor-report.ts).
  // Rescaled into the ORIGINAL uploaded photo's pixel space (same space the
  // design editor's yardstick lives in — see rescaleFtPerPxToOriginal).
  // ALL THREE null together whenever the door-anchor call fails, times out,
  // or the model reports no door/garage-door anchor — this must never throw
  // or delay the caller (see runDoorAnchorShadow below).
  doorAnchorFtPerPx: number | null;
  doorAnchorSource: DoorAnchorSource | null;
  doorAnchorConfidence: number | null;
  preferredSource: 'street' | 'satellite';
  miniLightDetections: MiniLightDetection[];
  wreathDetections: WreathDetection[];
  spritzerDetections: SpritzerDetection[];
  garlandDetections: GarlandDetection[];
  notes: string;
  confidence: 'low' | 'medium' | 'high';
  // Fix round (PR #916): which ANALYZER_PROMPT_VERSION produced this result —
  // stamped by analyzePhoto itself at generation time, so it travels with the
  // result through the analysis-context route into designs.seed_analysis and
  // on into training_examples.prompt_version at capture time. Optional so
  // existing test fixtures / hand-built PhotoAnalysisResult literals that
  // predate this field keep compiling.
  promptVersion?: string;
};

// Strip markdown code fences and pull the outer JSON object out of Claude's
// text response. Uses a brace-balance scan instead of a greedy regex so a
// trailing "```" or extra prose doesn't corrupt the parse. Throws with a
// helpful snippet on failure so callers can see what Claude actually sent.
// W5-024 (#110 wave 5, test-gap): exported so it's directly unit-testable —
// previously only exercised indirectly through analyzePhoto (which needs a
// live Claude client), so its fence-stripping / balance-scan / error-message
// paths had zero coverage.
export function extractJson(text: string): unknown {
  let s = text.trim();
  // Strip ```json ... ``` or ``` ... ``` fences if present
  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  if (fenceMatch) s = fenceMatch[1].trim();
  // Try a direct parse first — Claude usually obeys the "JSON only" instruction
  try { return JSON.parse(s); } catch { /* fall through to balance scan */ }
  // Balance-scan for the outermost {...}
  const start = s.indexOf('{');
  if (start < 0) throw new Error(`Claude returned non-JSON response: ${s.slice(0, 200)}`);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try { return JSON.parse(candidate); }
        catch (e) {
          throw new Error(`Claude returned malformed JSON: ${(e as Error).message}. Snippet: ${candidate.slice(0, 200)}`);
        }
      }
    }
  }
  throw new Error(`Claude returned unbalanced JSON: ${s.slice(0, 200)}`);
}

// --- Audit fix (g14-photoanalysis): robustness tidies on the raw analyzer JSON ---
// Claude returns free-form JSON; the cast to PhotoAnalysisResult does no runtime
// validation, so a stray string footage or off-enum difficulty would flow into
// the form. Coerce the FORM-FACING scalars to safe shapes. (Lines/boxes are
// normalized separately below.)
const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
type Difficulty = (typeof DIFFICULTIES)[number];

export function coerceDifficulty(v: unknown): Difficulty {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (DIFFICULTIES as readonly string[]).includes(s) ? (s as Difficulty) : 'medium';
}

// Coerce a footage value (Claude sometimes returns "40ft" or "40"). Number()
// handles numeric strings; anything non-finite or negative falls back to 0.
export function coerceFootage(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Coerce the AI's per-line roof-feature (#82 2c) — keep a known value, else
// undefined (omit) so a hallucinated/off-enum feature never reaches the scene.
const ROOF_FEATURE_CLASSES = ['gutter', 'peak', 'side', 'ridge', 'metal'] as const;
export function coerceRoofFeature(v: unknown): RoofFeatureClass | undefined {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (ROOF_FEATURE_CLASSES as readonly string[]).includes(s) ? (s as RoofFeatureClass) : undefined;
}

// Pick the coordinate scale (0-1 vs 0-1000) by MAJORITY, not the global max, so
// a single hallucinated out-of-range point can't collapse every real coord to a
// near-zero sliver. We take the median of all coords: if the typical coord is
// >1.5 the model is on the 0-1000 scale. Returns 1 or 1/1000.
function pickScale(coords: number[]): number {
  const finite = coords.filter(c => Number.isFinite(c));
  if (finite.length === 0) return 1;
  const sorted = [...finite].sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  return median > 1.5 ? 1 / 1000 : 1;
}

// Normalize polyline coords — Claude sometimes returns the 0-1000 scale. Decide
// the scale by MAJORITY (median, see pickScale) so one out-of-range outlier
// can't collapse every real line. After rescaling, DROP any individual point
// still outside [0,1] (a true hallucination) rather than letting it skew the
// drawing; lines left with <2 points are dropped entirely.
export function normalizeLines(lines: LineSegment[] | undefined): LineSegment[] {
  if (!Array.isArray(lines)) return [];
  const allPoints = lines.flatMap(l => l.points ?? []);
  if (allPoints.length === 0) return [];
  const scale = pickScale(allPoints.flat());
  return lines
    .map(l => ({
      label: l.label,
      feature: coerceRoofFeature(l.feature), // #82 2c — carry the AI's classification
      points: (l.points ?? [])
        .map(([x, y]) => [x * scale, y * scale] as [number, number])
        .filter(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1),
    }))
    .filter(l => l.points.length >= 2);
}

// Same majority-scale logic for detection bounding boxes. A box whose origin
// still lands outside [0,1] after rescaling is a hallucination — drop it.
export function normalizeBoxArray<T extends { box: [number, number, number, number] }>(
  dets: T[] | undefined,
): T[] {
  if (!Array.isArray(dets)) return [];
  const allCoords = dets.flatMap(d => d.box ?? []);
  if (allCoords.length === 0) return [];
  const scale = pickScale(allCoords);
  return dets
    .map(d => ({
      ...d,
      box: (d.box ?? [0, 0, 0, 0]).map(v => v * scale) as [number, number, number, number],
    }))
    .filter(d => d.box[0] >= 0 && d.box[0] <= 1 && d.box[1] >= 0 && d.box[1] <= 1);
}

// W5-026 (#110 wave 5, the #80-066 remaining half): analyzePhoto coerced the
// roofline scalars/boxes but passed each detection's ENUM fields through
// verbatim — a hallucinated off-enum mini type/wrapStyle/wreath size/tier/
// spritzer size/garland length would flow straight into the training-capture
// write. Mirror the known-value Sets already enforced downstream in
// seedFromAnalysis.ts (duplicated here rather than imported — that module is
// owned by a separate #110 track and these Sets aren't exported) and DROP any
// detection with an off-enum field, same "hallucination → discard" policy as
// normalizeLines/normalizeBoxArray above. stringCount is clamped instead of
// dropped (a shape, not an identity, so a wild count just gets bounded).
const MINI_TYPES = new Set(['tree', 'bush', 'column', 'railing']);
const WRAP_STYLES = new Set(['canopy', 'trunk']);
const WREATH_SIZES = new Set(['24noble', '30noble', '36noble', '48noble', '60noble', '72noble']);
const SPRITZER_SIZES = new Set(['16', '24', '32']);
const GARLAND_LENGTHS = new Set(['4.5ft', '9ft']);
const TIERS = new Set(['bow', 'fullDecor']);
// Mirrors seedFromAnalysis.ts's REASONABLE_MAX_STRINGS — a stringCount drives
// price once it reaches the design, so cap it here too rather than trusting
// the seed step to always be the only backstop.
const REASONABLE_MAX_STRINGS = 50;

function clampStringCount(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(1, Math.round(n)), REASONABLE_MAX_STRINGS);
}

export function validateMiniLightDetections(dets: MiniLightDetection[]): MiniLightDetection[] {
  return dets
    .filter(d => MINI_TYPES.has(d.type) && WRAP_STYLES.has(d.wrapStyle))
    .map(d => ({ ...d, stringCount: clampStringCount(d.stringCount) }));
}

export function validateWreathDetections(dets: WreathDetection[]): WreathDetection[] {
  return dets.filter(d => WREATH_SIZES.has(d.size) && TIERS.has(d.tier));
}

export function validateSpritzerDetections(dets: SpritzerDetection[]): SpritzerDetection[] {
  return dets.filter(d => SPRITZER_SIZES.has(d.size));
}

export function validateGarlandDetections(dets: GarlandDetection[]): GarlandDetection[] {
  return dets.filter(d => GARLAND_LENGTHS.has(d.length) && TIERS.has(d.tier));
}

const ROOFLINE_TRACING_RULES = `PACKAGES — there are TWO mutually-exclusive roofline options. Every roof-edge run you trace goes into EXACTLY ONE of them, decided by which way its roof plane faces:
- Santa's Roofline (red, "santasLines"): the FRONT roofline ONLY — the gutter/eave runs on the roof planes that FACE THE STREET, plus the rake edges of any FRONT-facing gable (the diagonals climbing to a street-facing peak). This is everything on the face of the house you see head-on from the curb.
- Gingerbread (blue, "gingerbreadLines"): the RIDGE (peak) lines PLUS the SIDE rooflines — the gutter/eave runs on the planes that face LEFT/RIGHT (the side elevations, which recede from the camera), plus the rakes of any gable that faces sideways. Gingerbread is the upgrade sold as "front + ridge + sides", so it adds the ridge and the sides on top of the front.

THE ONE TEST for every run: does the roof plane it sits on point AT THE STREET? → Santa's (red). Does it point LEFT/RIGHT, or is it a ridge/peak? → Gingerbread (blue). Getting a run into the WRONG bucket mis-prices the job (Santa's must be front-only; sides belong to Gingerbread), so classify carefully.

SCOPE — FRONT OF THE ROOF ONLY: we light only the FRONT section of the roof — the front edge (Santa's), plus that section's side returns and ridge (Gingerbread). We do NOT light the back of the house, nor any run heading toward the backyard. This holds for BOTH street view and satellite. So a "side" run is just the SHORT front portion of a side gutter/rake near the front — do not carry it all the way back. (The rare whole-roof or backyard job is measured manually, so never trace toward the rear.)

ROOFLINE TRACING — CRITICAL RULES (failures here are the #1 cause of under-quoted jobs):

1. A GUTTER LINE (front OR side) is ALWAYS the BOTTOM edge of a roof plane — the horizontal line where roofing shingles meet the top of the siding, OR the physical gutter trough. Ignore anything mid-slope (mid-roof features, texture breaks, shadow lines). The gutter is specifically the drip edge where the roof ends and the wall begins. (Which bucket it goes in — Santa's vs Gingerbread — depends on whether that plane faces the street or the side; see the ONE TEST above.)

2. ROOF SURFACE FEATURES — roofs frequently have mid-slope features that are NOT part of the gutter or ridge: skylights, vents, dormers, shadow bands, texture changes, and dark rectangular roof surfaces. These are on the roof plane, not its edges. NEVER trace along the edge of any mid-slope feature. The gutter is strictly at the bottom of the slope; the ridge is strictly at the top. If a mid-slope feature partially hides the gutter or ridge, still trace the full run based on where the roof actually ends — estimate through occlusion, do not stop short.

3. MULTI-RUN ROOFLINES — most LI homes have several distinct gutter runs. Trace EACH as its own entry, then file it under santasLines (front-facing) or gingerbreadLines (side-facing) by the ONE TEST above:
   - Main front body → 1 long horizontal run across the street-facing eave → santasLines.
   - Front gable projection → its 2 rake runs + any short eave below it → santasLines (it faces the street).
   - One-story extension / wing whose roof faces the street → its front eave → santasLines; the SHORT front portion of the gutter along its side (where it turns the corner) → gingerbreadLines — do not run it back toward the rear.
   - L-shaped footprint → the leg facing the street → santasLines; the front portion of the leg that turns down the side → gingerbreadLines.
   - Dormers on the front slope → their small gable rakes (>4ft each) → santasLines (front-facing).
   Missing a run under-quotes the job — but put each run in the CORRECT bucket (front = red, side = blue). When unsure of footage, trace it; the installer can skip sections later, but can't add what wasn't measured.

3a. SIDES & SYMMETRY SELF-CHECK — wherever a front eave reaches a corner of the house and TURNS to run down the SIDE, the front portion of that side run is GINGERBREAD (blue), not Santa's (stop it before the back of the house). Walk the roof from the left edge of the photo to the right: front-facing eaves are Santa's; every run that wraps onto a side elevation is Gingerbread. Houses are usually roughly symmetric, so a side return on the left implies a mirror on the right — put both in gingerbreadLines. Getting the side into the right bucket (blue, not red) is the #1 fix here.

3b. NEVER TRACE OFF-ROOF OR NON-ROOFLINE LINES — a polyline MUST follow an actual roof EDGE (gutter, rake, or ridge) on the roof. DO NOT trace along:
   - DOWNSPOUTS / leaders — the VERTICAL gutter pipes that run DOWN a wall from the roof edge to the ground. We light ONLY the roofline (the horizontal gutter/eave that runs ALONG the roof edge); we never run lights down a wall to the floor. If a gutter drops vertically down the side of the house, STOP at the roof edge — do not follow it down. Any gutter that is not running along the roof edge is not lit and must not be traced.
   - Power lines, utility wires, telephone cables, or any wire strung between poles / attached to a service mast. These often cross in front of the roof near the top of the photo and look tempting as a "ridge," but they are detached from the structure and we do NOT light them.
   - Tree branches or foliage silhouettes.
   - Fence tops, neighboring rooflines, or anything behind the subject house.
   - Horizon lines, cloud edges, or photo artifacts.
   If a horizontal line at the top of the photo is not CLEARLY attached to the roof (no visible connection to a ridge vent, shingle seam, or chimney), it is almost certainly a wire — skip it. When in doubt, do NOT trace it. The cost of missing a real ridge is much smaller than the cost of hallucinating lights floating in mid-air over a power line.

4. RAKE vs. GUTTER — on a gable-end (the triangular wall below a pitched peak), the two diagonal edges from eave to peak are RAKE lines; lights install along a rake the same way as a gutter. A rake belongs to whichever way its gable FACES: a FRONT-facing gable's rakes are Santa's (red); a gable whose triangle points to the SIDE has its rakes in Gingerbread (blue). The horizontal eave at the bottom of a gable follows the same front/side rule. A single front gable adds ~2× (slope length) of rake to Santa's.

RIDGE & SIDES (GINGERBREAD) — gingerbreadLines holds TWO kinds of run: (a) every RIDGE — the highest horizontal line where two slopes meet at the top (on a gable roof, one long line running front-to-back; on a hip roof, shorter and sometimes hidden behind the front slope); and (b) every SIDE run — the side-facing gutters, eaves, and rakes from the rules above. ALWAYS trace a ridge when a horizontal peak is visible, even if the slope below has skylights/dormers/dark shingles — the ridge is the top edge regardless of what's below it. Only return gingerbreadLines = [] when there is genuinely no ridge AND no side run visible (e.g., a straight-on view of a pure hip roof with no visible top ridge and no side elevations in frame).`;

const OUTPUT_JSON_SCHEMA = `You MUST respond with ONLY valid JSON matching this schema. No markdown fences, no prose before or after:
{
  "santasFootage": number,
  "santasDifficulty": "easy" | "medium" | "hard",
  "santasLines": [
    { "points": [[x1,y1], [x2,y2], ...], "label": "front gutter ~40ft", "feature": "gutter" }
  ],
  "gingerbreadFootage": number,
  "gingerbreadDifficulty": "easy" | "medium" | "hard",
  "gingerbreadLines": [
    { "points": [[x1,y1], [x2,y2], ...], "label": "main ridge ~30ft", "feature": "ridge" },
    { "points": [[x1,y1], [x2,y2], ...], "label": "right side gutter ~25ft", "feature": "side" }
  ],
  "satelliteSantasLines": [
    { "points": [[x1,y1], [x2,y2], ...], "label": "front edge ~55ft", "feature": "gutter" }
  ],
  "satelliteSantasFootage": number,
  "satelliteGingerbreadLines": [
    { "points": [[x1,y1], [x2,y2], ...], "label": "left + right front-section sides ~45ft", "feature": "side" },
    { "points": [[x1,y1], [x2,y2], ...], "label": "main ridge ~30ft", "feature": "ridge" }
  ],
  "satelliteGingerbreadFootage": number,
  "preferredSource": "street" | "satellite",
  "miniLightDetections": [
    { "type": "bush" | "tree" | "column" | "railing", "wrapStyle": "canopy" | "trunk", "stringCount": number, "box": [x, y, w, h], "label": "foundation bush ~3ft" }
  ],
  "wreathDetections": [
    { "size": "24noble" | "30noble" | "36noble" | "48noble" | "60noble" | "72noble", "tier": "bow" | "fullDecor", "box": [x, y, w, h], "label": "front door wreath ~30in" }
  ],
  "spritzerDetections": [
    { "size": "16" | "24" | "32", "box": [x, y, w, h], "label": "metallic star spritzer 24in" }
  ],
  "garlandDetections": [
    { "length": "9ft" | "4.5ft", "tier": "bow" | "fullDecor", "box": [x, y, w, h], "label": "porch railing garland ~18ft" }
  ],
  "notes": "1-2 sentences on what you saw and any caveats",
  "confidence": "low" | "medium" | "high"
}

Round footage to the nearest 5 feet. Coordinates should be precise — trace right along the visible edge. If a photo is too poor, use confidence "low" and return empty line arrays.`;

// Fix round (PR #916, admin lens MED): bump this string whenever SYSTEM_PROMPT
// below materially changes (wording that could shift what the model returns —
// not a comment-only edit). Stamped onto every PhotoAnalysisResult at the
// point analyzePhoto actually runs the prompt (see the `promptVersion` field
// on the return value below), NOT at training-example capture time — a design
// can be analyzed under one prompt version and sent (captured) days or weeks
// later under a different one, so capture time is the wrong place to read
// this constant. training_examples.prompt_version is populated by copying the
// value that was already stamped into original_analysis at analysis time (see
// src/lib/trainingExamples.ts's captureTrainingExample), so a row is always
// tagged with the prompt that actually produced it.
export const ANALYZER_PROMPT_VERSION = 'v2-segmented-2026-08-28';

const SYSTEM_PROMPT = `You are a holiday lighting estimator for Yule Love Lights, a Long Island NY Christmas lighting company. You analyze photos of houses to estimate roofline lighting measurements.

${ROOFLINE_TRACING_RULES}

MINI LIGHT DETECTION — in addition to roofline, identify every bush, tree, column, and railing visible in the photo that could get mini lights.

TYPES:
- bush: low landscaping shrubs (hedges, foundation plantings, topiaries). Wrap style "canopy" — lights drape over the canopy.
- tree: anything from 6ft sapling to 30ft mature tree. Small trees (<10ft) use "canopy" wrap. Larger trees wrap the trunk + major branches, use "trunk" wrap.
- column: porch columns, lamp posts, entry columns. Wrap style "canopy" (spiral wrap).
- railing: a deck, porch, balcony, or fence railing — mini lights run ALONG the top rail. Wrap style "canopy". The bounding box should hug the horizontal run of the rail. Common on front porches, decks, and balconies.

STRING COUNT guidelines (each string = one 50ct 5MM strand):
A 50ct 5MM strand covers 25ft at 6" bulb spacing. Estimate how many strands it would realistically take to fully wrap/cover the item.

- Small bush (2-3ft wide, 2ft tall): 2-3 strings, canopy
- Medium bush (3-5ft wide, 3ft tall): 3-5 strings, canopy
- Large bush/hedge (5-8ft wide, 4ft tall): 5-8 strings, canopy
- Very large hedge run (8ft+ wide): 8-15 strings, canopy
- Small tree (6-10ft): 3-5 strings, canopy
- Medium tree (10-20ft): 5-8 strings, trunk
- Large tree (20ft+): 8-14 strings, trunk
- Column/lamp post (standard 8ft): 2-3 strings, canopy
- Railing (measured along the top rail): ~1 string per 25ft — short porch rail (~15ft): 1 string; long or wraparound deck rail (25-40ft): 2 strings, canopy

For each detection, return a bounding box in normalized 0-1 coords: [x, y, width, height] where (x,y) is the top-left corner. Round string counts to whole numbers. Only include items clearly visible and suitable for lighting (skip distant background trees or items in neighbor's yard).

WREATH PLACEMENT — IMPORTANT: the customer does NOT have wreaths up in the daytime photo. Your job is to SUGGEST GOOD PLACEMENT SPOTS where our install crew would hang a wreath, based on the house's architecture. Wreaths are decorations we would INSTALL — you are proposing locations, not detecting existing items.

Typical placement spots, in order of frequency on Long Island installs:
1. "portico" — small roof / covered entry projecting over the front door. Center ONE large wreath on the front face of the portico. Very common.
2. "peak" — the triangular gable face at the top of a pitched roof. Center ONE large wreath on the peak, below the roofline.
3. "above-garage" — the siding panel above a garage door. Single garage = 1 wreath centered. Double garage = 2 wreaths, one above each door.
4. "front-door" — one medium wreath on the door itself. Almost always paired with at least one of the above.
5. "eyebrow" — a small roof projection over a bay window or bow window. One wreath centered under the eyebrow.
6. "between-windows" — on a tall blank siding section between two second-story windows.

Default sizes by spot:
- portico / peak / above-garage → "36noble"
- front-door → "30noble"
- eyebrow / between-windows → "30noble" or "24noble"
Default tier is "bow" (Non-Decorated — lights with an included bow) unless the customer's existing decor style clearly calls for "fullDecor" (Decorated — lights plus ornaments/ribbon/berries).

DO NOT suggest:
- A wreath on a spot where one is already visible in the daytime photo (skip — we won't re-install over existing).
- A wreath on an off-center / asymmetric spot that would look odd.
- More than ~3 wreaths on a typical residential house — suggest the BEST spots, not every possible spot.

Return each suggested wreath as a bounding box in normalized 0-1 coords [x, y, width, height] positioned WHERE the wreath would hang. Keep the box roughly square — wreaths are circular. Size the box so its width/height reflects real-world scale: a 36" wreath covers ~3ft of the house; a 30" covers ~2.5ft. Use the front door (~3ft wide) or garage door (~8ft or 16ft wide) as your scale anchor. Include the placement spot in the label, e.g. "portico wreath ~36in", "peak wreath ~36in".

SPRITZER PLACEMENT — spritzers are individual metallic starburst stakes that plant in garden/flower beds. Each box you return represents ONE stake (one starburst, ~2ft tall). The daytime photo will NOT show them — you are SUGGESTING WHERE to plant each one, as decorative fill light for empty landscaping spots without wrappable bushes.

IMPORTANT: ONE BOX PER STAKE, not per zone. If a foundation flower bed can fit 4 stakes, return 4 separate small boxes spaced along the bed. Stakes typically space ~3ft apart.

Typical placement scenarios:
1. "flower-bed" — 4-6 stakes spaced ~3ft apart across a front-of-house foundation flower bed. Most common.
2. "walkway" — 3-5 stakes per side flanking the walkway from driveway to front door.
3. "stoop" — 2-4 stakes flanking the front door stoop / porch steps.
4. "bed-gap" — filling a gap between existing wrappable bushes in a foundation bed.

Each box should be SMALL and SQUARE — roughly the footprint of a single stake's starburst head. On a 1000px wide photo, a 24" spritzer starburst is about ~50px wide, so a normalized box width around 0.04-0.06 is typical. Center the box at the STARBURST HEAD position (about 2ft above the ground level in that spot), not at the stake base.

Default size is "24" (the standard stake). Use "16" for tight accent fills between small plantings, "32" for bold feature accents.

DO NOT suggest stakes:
- On open lawn with no planted bed / mulch / edging.
- Overlapping a bush/shrub area that's already getting mini-light wrap — they'd be redundant.
- Behind the house or in side yards (front-of-house only).
- Closer than ~2ft apart (they visually merge).

If the house has no empty planted beds suitable for stakes, return an EMPTY array — don't invent spots. Typical residential install is 4-8 stakes total. Label each with its position, e.g. "foundation bed stake 1 — 24in", "walkway stake left #2 — 24in".

GARLAND DETECTION — identify garland runs: linear rope-of-evergreen decoration along a porch railing, archway, doorway frame, or beam. Garland is sold in 9ft sections ("9ft") or 4.5ft sections ("4.5ft"); default to "9ft" unless you can see a short run. Tier — "bow" = Non-Decorated (plain lit greenery), "fullDecor" = Decorated (greenery with ornaments/ribbon/berries); default to "bow". Return ONE bounding box per garland RUN — the box should TIGHTLY span the run's full length along its widest axis. The frontend uses the box WIDTH × the shared feet-per-pixel scale to compute linear feet and derive piece count. Do NOT flag decorative wreaths, individual bows, or roofline runs here — those have their own categories.

DIFFICULTY TIERS (per package):
- easy: single-story home, ground-accessible, simple straight runs, minimal obstacles (low shrubs, open front yard). Installer can work from a short ladder.
- medium: two-story home, moderate complexity (multiple gables, dormers, cut-ups), some obstacles (landscaping, porches, tight access). Installer needs extension ladder.
- hard: three+ stories OR very steep pitch OR highly complex cut-up roofline OR difficult access (tall shrubs, power lines overhead, steep grade, second-story over garage). Installer needs multi-section ladder or scaffolding.

TYPICAL LI HOUSE SIZES (we measure the FRONT roof section only — sanity-check):
- Small cape/ranch: front edge ~25-45 ft; ridge + side returns ~30-55 ft
- Medium colonial: front edge ~40-65 ft; ridge + side returns ~50-90 ft
- Large colonial/custom: front edge ~60-100 ft; ridge + side returns ~80-150 ft
santasFootage = the FRONT edge only (roughly the width of the house front facing the road). gingerbreadFootage = the ridge length + the two SHORT side returns of that front section — NOT the full side gutters running back to the rear, and NEVER the back edge.

LINE MARKUP — CRITICAL:
You must also identify the specific lines you measured, as polylines in NORMALIZED IMAGE COORDINATES (0.0 to 1.0). Origin (0,0) is top-left of the image, (1,1) is bottom-right. Each polyline is an array of [x, y] points that trace along the edge of the roof. Use as many points as needed to follow the curve/angles (straight run = 2 points, L-shape = 3, dormer cut-ups = more).

For each line segment include a short label like "front gutter ~40ft" or "main ridge ~30ft", AND a "feature" classifying the PHYSICAL roof surface the run sits on. This is SEPARATE from the red/blue Santa's/Gingerbread split — it decides which install CLIP we use, not which package:
- "gutter" — a gutter / eave drip edge (the bottom edge of a roof plane, front OR side). This is the COMMON case for most eave runs.
- "peak" — a FRONT gable face/rake with NO gutter (lights clip to the shingle/fascia of the triangular gable, not a gutter).
- "ridge" — the horizontal apex line at the very top of a pitched roof.
- "side" — a side-elevation eave/gutter run (a plane that faces left/right).
- "metal" — the run sits on a METAL roof (we use magnetic wire, no clip — flags it for staff).
Pick the single best feature per segment: most front gutterlines are "gutter", the apex is "ridge", side eaves are "side". If you genuinely can't tell, OMIT "feature" (staff will set it).

SATELLITE MEASUREMENT:
When a satellite image is supplied, also produce polylines in the SATELLITE image's coordinate space — but measure ONLY THE FRONT SECTION of the roof (the part facing the road), NOT the whole perimeter of the house. For ~90% of homes we light only the front of the roof; the back / backyard side stays dark. (The rare customer who wants the whole roof or the backyard side is handled MANUALLY, not by you — so never trace toward the backyard.)

FIRST, FIND THE ROAD. The "front" is the public street the house fronts onto — CORRELATE WITH THE STREET-VIEW IMAGE to confirm which roof edge that is. Do NOT assume the nearest paved surface is the road: a neighbor's driveway, a shared driveway, a side street, or a back alley is NOT the front. If you cannot confidently tell which edge faces the real road, return empty arrays rather than guessing the front.

THEN split ONLY the front roof section:
- satelliteSantasLines = the FRONT roof edge(s) that face the road (the street-facing eave/gutter). This is an ARRAY — do not force it to one entry. A plain rectangular front is one segment; a front with a garage wing, bump-out, ell, or any section set back or forward from the main body needs a SEPARATE segment for each, the same way the street-view MULTI-RUN rule above (rule 3) already splits those into separate entries. Two edges at different depths cannot be one polyline. A bigger or more cut-up house gets MORE segments here, never fewer — this array should scale with the house the same way santasLines does on the street photo.
- satelliteGingerbreadLines = the RIDGE of that front section PLUS its two SIDE edges (the left/right roof edges nearest the front) — same array-not-single-line rule: one segment per distinct run.
- DO NOT trace the BACK roof edge, and do NOT run the side edges all the way around to the backyard — stop them at the front section. No backyard lines, ever.

HOW TO TRACE THE SATELLITE ROOFLINE — follow these rules strictly:
- Snap polyline points ONLY to the ACTUAL ROOF EDGE (visible shingle seam / gutter line where the roof plane ends and the wall/ground begins). Lighter roofing material against the yard or driveway is usually the edge.
- DO NOT trace the property boundary, the lot outline, driveways, sidewalks, pools, decks, patios, pergolas, sheds, detached garages, or landscaping. ONLY the primary structure's roof.
- If the roof is L-shaped / U-shaped / T-shaped / has a courtyard, USE ENOUGH POINTS to hug every inside corner within a single connected run, AND add a separate polyline entry for any wing or section a single connected line can't reach. A bounding box is WRONG — it will overstate footage. 8-20 points is typical for a modest cut-up; commercial can need 40+.
- Shadows and tree canopy can obscure an edge. If you can't see ONE specific run, skip only that run and KEEP the segments you can see — do not empty the whole array because one part is unclear.
- A complex or large roofline is NOT by itself a reason to return fewer or empty segments — the more distinct roof planes you can see, the more segments you should return. Reserve an empty array for when you genuinely cannot see the roof at all (see below), not for "this one is complicated."
- Ridges on the satellite image appear as the BRIGHTEST lines running along the roof's peak (the sunlit side meets the shaded side). Trace along those peak lines, not across the slopes.
- FOOTAGE MUST BE DERIVED FROM THE POLYLINE. Do not invent a number and then draw a polyline to match. Compute: for each segment, sum sqrt((x2-x1)^2 + (y2-y1)^2) in normalized coords, multiply by 640 to get pixels, multiply by the feet-per-pixel scale. Sum across segments. Round to the nearest 5ft. If your polyline is empty, footage is 0.

A feet-per-pixel scale hint will be provided.

Street view shows mainly the front (what the installer sees from the curb); satellite shows the roof from above. EITHER WAY, measure only the FRONT roof section: Santa's = the front edge facing the road; Gingerbread = that front section's side edges + ridge; NEVER the back / backyard edge. The street and satellite numbers for the same front section should be in the same ballpark (satellite is usually the more accurate of the two because there's no perspective foreshortening).

Set "preferredSource" to "satellite" when:
- The property is commercial (flat roof, big box, strip mall).
- The roof has significant cut-ups, dormers, or wings that aren't visible from street view.
- Street view is heavily obscured by trees, fences, or setback.
Otherwise set it to "street".

Only return fully empty satelliteSantasLines/satelliteGingerbreadLines arrays when the roof itself is genuinely not visible in the image (heavy tree cover, low contrast, image unclear, wrong house framed) — say which of these it is in the "notes" field. Do NOT return empty because the roof has many planes or looks complicated; that case gets MORE segments, not zero. The user will trace manually only what you truly could not see — an empty array is for "I cannot see this roof," not for "this roof is hard."

${OUTPUT_JSON_SCHEMA}`;

// #54: the COMPLETED-INSTALL analyzer. /training/new uploads photos of FINISHED
// jobs, not bare houses to quote. The quoting SYSTEM_PROMPT above SUGGESTS where
// lights could go (hallucinating boxes on a done install) — wrong tool. This
// prompt RECORDS what is actually installed & lit in a night photo, so saved
// training examples are ground truth, not a re-design. Shares the crown-jewel
// ROOFLINE_TRACING_RULES + OUTPUT_JSON_SCHEMA with the quoting prompt so the
// tracing discipline and output shape can't drift between the two modes.
const COMPLETED_INSTALL_PROMPT = `You are a holiday lighting technician for Yule Love Lights, a Long Island NY Christmas lighting company. You are looking at a NIGHT photo of a COMPLETED installation — our lights are already installed and turned ON. Your job is to RECORD EXACTLY what was installed and is lit, as ground-truth training data.

THIS IS NOT A DESIGN TASK. Do not suggest, add, or "recommend" anything. Report ONLY light that is visibly ON in this photo. If a roof edge is dark, a bush is bare, or a spot has no wreath, it does not exist for your purposes — leave it out. A missed item is fine; an INVENTED item corrupts our training data.

${ROOFLINE_TRACING_RULES}

COMPLETED-INSTALL ROOFLINE — apply every tracing rule above, with ONE change: trace ONLY the roof runs that are ACTUALLY LIT. Follow the visible line of bulbs along the eave / rake / ridge. A roof edge with no bulbs on it was NOT installed — do not trace it (return fewer lines, or empty arrays, rather than tracing a dark edge). The red/blue Santa's-vs-Gingerbread split, the front-only scope, and the no-downspout / no-wire discipline all still apply. NIGHT-PHOTO CARE: glare and bloom fatten a lit string — trace the CENTERLINE of the run where it sits on the roof edge, not the outer glow. If a string sags below the gutter, place the polyline on the roof edge it hangs from, not the sag. Derive footage from the polyline as usual.

MINI LIGHTS (as installed) — identify every bush, tree, column, and railing that is ACTUALLY WRAPPED and lit. Skip anything bare/unlit — we did not light it.
- bush: a shrub/hedge glowing with wrapped mini lights. Wrap style "canopy".
- tree: a wrapped tree; small (<10ft) "canopy", larger "trunk".
- column: a lit porch column / lamp post, "canopy".
- railing: a lit run along a deck / porch / balcony top rail, "canopy" — the box hugs the horizontal lit run.
Estimate stringCount from the LIT extent (one 50ct 5MM strand ≈ 25ft): small bush 2-3, medium 3-5, large hedge 5-15, small tree 3-5, medium tree 5-8, large tree 8-14, column 2-3, railing ~1 per 25ft. Box each in normalized 0-1 coords [x,y,w,h]. Skip distant background / neighbor items.

WREATHS (as installed) — detect wreaths ACTUALLY HUNG and lit. Report each one's position + best-guess size ("24noble"/"30noble"/"36noble"/"48noble"/"60noble"/"72noble") and tier ("bow" = lights + bow, "fullDecor" = lights + ornaments/ribbon). Do NOT propose empty spots. If no lit wreath is visible, return []. At night a lit wreath reads as a bright ring — only report clear ones (this is a lower-confidence detection than roofline/minis).

SPRITZERS (as installed) — detect metallic starburst stakes ACTUALLY PLANTED and lit in the beds. ONE box per lit starburst head, small and square. These are small and easy to lose in night glare — report only clearly-lit starbursts; when unsure, OMIT. Return [] if none (lower-confidence than roofline/minis).

GARLAND (as installed) — detect garland runs ACTUALLY INSTALLED and lit along a railing, archway, doorway, or beam. ONE tight box per lit run (box width × scale = linear feet). Do not confuse a lit garland swag with a roofline run or a mini-light string. Return [] if none (lower-confidence than roofline/minis).

DIFFICULTY (of the install that was performed):
- easy: single-story, ground-accessible, simple straight runs.
- medium: two-story, multiple gables / dormers, some access obstacles.
- hard: three+ stories OR very steep / complex roofline OR difficult access.

LINE MARKUP — return each lit run you traced as a polyline in NORMALIZED IMAGE COORDINATES (0.0-1.0), origin top-left, as an array of [x,y] points following the lit edge. Include a short label and a "feature" (gutter / peak / ridge / side / metal) exactly as defined in the roofline rules above. There is no satellite image in this mode — leave the satellite arrays empty and set preferredSource to "street".

${OUTPUT_JSON_SCHEMA}

Record ONLY what is lit and visible tonight. Round footage to the nearest 5 feet. When the photo is too dark / unclear to be sure, use confidence "low" and return empty arrays rather than guessing.`;

// #54: pick the base system prompt by analyzer mode. 'design' (default) = the
// quoting analyzer; 'completed' = the completed-install recorder above.
export function baseSystemPromptFor(mode: 'design' | 'completed'): string {
  return mode === 'completed' ? COMPLETED_INSTALL_PROMPT : SYSTEM_PROMPT;
}

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

// W5-007 (#110 wave 5): Claude Vision's effective max resolution is ~1568px on
// the long edge — anything larger is downscaled server-side before the model
// sees it anyway, so sending it at full size only pays extra upload + image
// tokens for zero detection benefit. Shrink to that ceiling (never upscale) so
// few-shot house photos and reference images are as cheap as they can be
// without losing any real fidelity. Re-encodes to JPEG (quality 85) since the
// analyzer only reads these for detection, not for storage.
const MAX_VISION_EDGE_PX = 1568;

export async function downscaleImageForVision(
  base64: string,
  mediaType: string,
): Promise<{ base64: string; mediaType: ImageMediaType }> {
  try {
    const comma = base64.indexOf(',');
    const raw = base64.startsWith('data:') && comma >= 0 ? base64.slice(comma + 1) : base64;
    const buf = Buffer.from(raw, 'base64');
    const meta = await sharp(buf).metadata();
    const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
    // Already small enough (or dimensions unreadable) — leave the bytes as-is.
    if (longEdge <= MAX_VISION_EDGE_PX) {
      return { base64: raw, mediaType: mediaType as ImageMediaType };
    }
    const resized = await sharp(buf)
      .resize({ width: MAX_VISION_EDGE_PX, height: MAX_VISION_EDGE_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { base64: resized.toString('base64'), mediaType: 'image/jpeg' };
  } catch {
    // Any decode failure — fall back to the original bytes rather than
    // dropping the image; detection quality with the original is strictly
    // better than no image at all.
    const comma = base64.indexOf(',');
    const raw = base64.startsWith('data:') && comma >= 0 ? base64.slice(comma + 1) : base64;
    return { base64: raw, mediaType: mediaType as ImageMediaType };
  }
}

export type TrainingExamplePhoto = {
  base64: string;
  mediaType: string;
  tag?: string; // e.g. "front_install", "front_takedown", "side", "detail"
  caption?: string;
};

type FewShotExample = {
  // Support multi-photo training houses and scene-based design examples.
  photos: TrainingExamplePhoto[];
  santasFootage: number;
  santasDifficulty: 'easy' | 'medium' | 'hard';
  santasLines: LineSegment[];
  gingerbreadFootage: number;
  gingerbreadDifficulty: 'easy' | 'medium' | 'hard';
  gingerbreadLines: LineSegment[];
  satelliteSantasLines?: LineSegment[];
  satelliteSantasFootage?: number;
  satelliteGingerbreadLines?: LineSegment[];
  satelliteGingerbreadFootage?: number;
  miniLightDetections: MiniLightDetection[];
  wreathDetections: WreathDetection[];
  spritzerDetections: SpritzerDetection[];
  garlandDetections?: GarlandDetection[];
  houseStyle?: string;
  aiFailureNotes?: string | null;
  // #8 Stage C (C1): a compact "you first guessed X, staff corrected to Y" note
  // built from the captured seed→final pair (design examples only). Injected
  // into the example's user turn so the model learns the correction, not just
  // the final answer. Null/absent when there's no seed to compare against.
  seedDiffNote?: string | null;
  // 'training' = confirmed install (training_houses); 'design' = a scene-based
  // training example captured from a staff-finalized design (#8 Stage A).
  source: 'training' | 'design';
};

// Exported test-only (mirrors the FewShotExample type export below) — proves
// aiFailureNotes (a staff-typed "what did the AI get wrong" note) actually
// reaches the assembled prompt text, not just the few-shot data shape.
export async function buildFewShotMessages(examples: FewShotExample[]) {
  type Block =
    | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }
    | { type: 'text'; text: string };
  const messages: { role: 'user' | 'assistant'; content: Block[] }[] = [];

  for (const ex of examples) {
    const userContent: Block[] = [];
    const label = ex.source === 'design'
      ? 'Staff-confirmed design from a sent quote — ground-truth layout, measurements, and item placement.'
      : `Completed installation${ex.houseStyle ? ` (${ex.houseStyle})` : ''} — confirmed measurements from takedown.`;

    const photosNote = ex.photos.length > 1
      ? ex.source === 'design'
        ? 'Street photo first, then the top-down satellite it was measured against.'
        : `${ex.photos.length} photos provided — front install first, then alternate angles/details.`
      : '';
    userContent.push({
      type: 'text',
      text: `${label} ${photosNote}`,
    });
    for (const p of ex.photos) {
      // W5-007 (#110 wave 5): downscale to Claude Vision's effective max before
      // sending — lossless for detection, much cheaper than the original photo.
      const { base64, mediaType: mt } = await downscaleImageForVision(p.base64, p.mediaType);
      userContent.push({ type: 'image', source: { type: 'base64', media_type: mt, data: base64 } });
      if (p.tag) userContent.push({ type: 'text', text: `^ tag: ${p.tag}${p.caption ? ` — ${p.caption}` : ''}` });
    }
    // #8 Stage C (C1): teach from the seed→final correction, not just the answer.
    if (ex.seedDiffNote) {
      userContent.push({ type: 'text', text: ex.seedDiffNote });
    }
    userContent.push({ type: 'text', text: 'Respond with the confirmed JSON measurements.' });

    messages.push({ role: 'user', content: userContent });

    const assistantPayload = {
      santasFootage: ex.santasFootage,
      santasDifficulty: ex.santasDifficulty,
      santasLines: ex.santasLines,
      gingerbreadFootage: ex.gingerbreadFootage,
      gingerbreadDifficulty: ex.gingerbreadDifficulty,
      gingerbreadLines: ex.gingerbreadLines,
      satelliteSantasLines: ex.satelliteSantasLines ?? [],
      satelliteSantasFootage: ex.satelliteSantasFootage ?? 0,
      satelliteGingerbreadLines: ex.satelliteGingerbreadLines ?? [],
      satelliteGingerbreadFootage: ex.satelliteGingerbreadFootage ?? 0,
      // Prefer satellite when the example actually has satellite lines —
      // otherwise fall back to street. Hardcoding 'street' on every example
      // was biasing Claude toward street measurements even for commercial
      // / complex-roof training houses where satellite was the truth source.
      preferredSource: (ex.satelliteSantasLines?.length ?? 0) > 0 ? 'satellite' : 'street',
      miniLightDetections: ex.miniLightDetections,
      wreathDetections: ex.wreathDetections ?? [],
      spritzerDetections: ex.spritzerDetections ?? [],
      garlandDetections: ex.garlandDetections ?? [],
      notes: ex.aiFailureNotes
        ? `${label} Known AI pitfall on this house: ${ex.aiFailureNotes}`
        : label,
      confidence: 'high',
    };
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: JSON.stringify(assistantPayload) }],
    });
  }
  return messages;
}

async function buildReferenceMessages(references: StoredReferenceAsset[]) {
  if (references.length === 0) return [];
  type Block =
    | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string }; cache_control?: { type: 'ephemeral' } }
    | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
  const userContent: Block[] = [
    {
      type: 'text',
      text: `PRODUCT REFERENCE LIBRARY — ${references.length} image(s). These are what each product looks like up close. Use them to more accurately recognize and classify these items when you see them on a house photo.`,
    },
  ];
  for (const r of references) {
    // W5-007/W5-010 (#110 wave 5): downscale, same as few-shot house photos.
    const { base64, mediaType: mt } = await downscaleImageForVision(r.base64, r.media_type);
    userContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mt,
        data: base64,
      },
    });
    const tier = r.tier ? ` · ${r.tier}` : '';
    const cap = r.caption ? ` — ${r.caption}` : '';
    userContent.push({
      type: 'text',
      text: `^ ${r.asset_type} · ${r.size}${tier}${cap}`,
    });
  }
  const lastText = {
    type: 'text' as const,
    text: 'Acknowledge that you have these product references loaded, then wait for the house photo.',
    // W5-010 (#110 wave 5): the reference library is IDENTICAL across every
    // analyze call (it only changes when staff edit it in Settings), so mark
    // this turn cacheable — the breakpoint here covers every reference image
    // + label above it too (a cache_control breakpoint caches everything back
    // to the previous breakpoint / start of the block).
    cache_control: { type: 'ephemeral' as const },
  };
  userContent.push(lastText);
  return [
    { role: 'user' as const, content: userContent },
    {
      role: 'assistant' as const,
      content: [
        {
          type: 'text' as const,
          text: 'Product references loaded. I will use them to identify wreaths, spritzers, and garland on the house photos.',
        },
      ],
    },
  ];
}

export { type FewShotExample };

// SHADOW MODE (door-anchor scale, spike PR #922): model + hard timeout for
// the second, cheap vision call. Model matches the main analyzer call above
// (same tier the spike measured its numbers on — see doorAnchor.ts). Timeout
// is a few seconds of margin over the spike's observed per-call latency
// (78/78 live calls succeeded with no retries needed); analyze-photo/
// analyze-address are both maxDuration=60 routes that already spend 20-40s
// on the main call, so this must degrade to null well before eating into
// that budget rather than risk timing out the customer-facing response.
const DOOR_ANCHOR_MODEL = 'claude-sonnet-4-6';
const DOOR_ANCHOR_TIMEOUT_MS = 8000;

type DoorAnchorShadowFields = {
  doorAnchorFtPerPx: number | null;
  doorAnchorSource: DoorAnchorSource | null;
  doorAnchorConfidence: number | null;
};

const NULL_DOOR_ANCHOR: DoorAnchorShadowFields = {
  doorAnchorFtPerPx: null,
  doorAnchorSource: null,
  doorAnchorConfidence: null,
};

// Strips a "data:image/...;base64," prefix if present. Local copy of the
// same 2-line check downscaleImageForVision already does inline (twice) —
// duplicated here rather than touching that function's body, which stays
// byte-identical to before this change.
function rawBase64(input: string): string {
  const comma = input.indexOf(',');
  return input.startsWith('data:') && comma >= 0 ? input.slice(comma + 1) : input;
}

// SHADOW MODE (door-anchor scale): a SEPARATE, cheap vision call that asks
// the model to locate the front door / garage door in the STREET photo and
// derive a feet-per-pixel scale (src/lib/design/doorAnchor.ts has the
// prompt/parsing/math — this function is the I/O + failure-isolation shell
// around it). FAILURE-ISOLATED end to end and TIME-BOUNDED: any decode
// failure, API error, timeout, or schema-invalid model response degrades
// every field to null via NULL_DOOR_ANCHOR — this must NEVER throw and must
// NEVER take longer than DOOR_ANCHOR_TIMEOUT_MS, so it can never delay or
// fail the customer-facing analyze response. Never mutates or reads the
// main analysis result — fully independent of it.
async function runDoorAnchorShadow(
  client: NonNullable<ReturnType<typeof getClaudeClient>>,
  base64Image: string,
  mediaType: string,
): Promise<DoorAnchorShadowFields> {
  const attempt = (async (): Promise<DoorAnchorShadowFields> => {
    const { base64: sentBase64, mediaType: sentMediaType } = await downscaleImageForVision(base64Image, mediaType);
    const [sentMeta, originalMeta] = await Promise.all([
      sharp(Buffer.from(sentBase64, 'base64')).metadata(),
      sharp(Buffer.from(rawBase64(base64Image), 'base64')).metadata(),
    ]);
    const sentW = sentMeta.width ?? null;
    const sentH = sentMeta.height ?? null;
    if (!sentW || !sentH) return NULL_DOOR_ANCHOR;

    const response = await client.messages.create({
      model: DOOR_ANCHOR_MODEL,
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: sentMediaType, data: sentBase64 } },
            { type: 'text', text: buildDoorAnchorPrompt(sentW, sentH) },
          ],
        },
      ],
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') return NULL_DOOR_ANCHOR;
    const parsed = extractJson(textBlock.text.trim());
    if (!isValidDoorAnchorModelResult(parsed)) return NULL_DOOR_ANCHOR;
    const scale = doorAnchorScaleFromModelResult(parsed);
    if (!scale) return NULL_DOOR_ANCHOR;

    const originalW = originalMeta.width ?? 0;
    const ftPerPx = rescaleFtPerPxToOriginal(scale.ftPerPx, sentW, originalW);
    return { doorAnchorFtPerPx: ftPerPx, doorAnchorSource: scale.source, doorAnchorConfidence: scale.confidence };
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DoorAnchorShadowFields>((resolve) => {
    timer = setTimeout(() => resolve(NULL_DOOR_ANCHOR), DOOR_ANCHOR_TIMEOUT_MS);
  });
  try {
    return await Promise.race([attempt, timeout]);
  } catch {
    // Anything the attempt threw (decode failure, API rejection, malformed
    // response) — never propagate, never delay the caller.
    return NULL_DOOR_ANCHOR;
  } finally {
    clearTimeout(timer);
  }
}

export type SatelliteReference = {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png';
  feetPerPixel?: number; // known scale from Google Static Maps zoom level
};

export type AnalyzeOptions = {
  satellite?: SatelliteReference;
  references?: StoredReferenceAsset[];
  houseStyleHint?: string;
  // #8 Stage C (C2): a corpus-wide "you systematically tend to X" calibration
  // block (already prefixed with blank lines), appended to the system prompt.
  corpusBiasNote?: string | null;
  // #54: 'design' (default) = quote a bare house (SUGGEST placements); 'completed'
  // = record what is actually installed & lit in a night photo of a finished job
  // (/training/new ground-truth capture). Selects the base system prompt.
  mode?: 'design' | 'completed';
};

export async function analyzePhoto(
  base64Image: string,
  mediaType: string,
  fewShotExamples: FewShotExample[] = [],
  optionsOrSatellite?: AnalyzeOptions | SatelliteReference,
): Promise<PhotoAnalysisResult> {
  const client = getClaudeClient();
  if (!client) {
    throw new Error('Claude API not configured — set ANTHROPIC_API_KEY in .env.local');
  }

  // Back-compat: second positional used to be just a satellite image.
  const options: AnalyzeOptions = optionsOrSatellite && 'base64' in optionsOrSatellite && !('references' in optionsOrSatellite)
    ? { satellite: optionsOrSatellite as SatelliteReference }
    : ((optionsOrSatellite as AnalyzeOptions) ?? {});

  const validMediaTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
  if (!validMediaTypes.includes(mediaType as typeof validMediaTypes[number])) {
    throw new Error(`Unsupported image type: ${mediaType}`);
  }

  // SHADOW MODE (door-anchor scale): kicked off HERE, NOT awaited — it runs
  // CONCURRENTLY with the few-shot/reference assembly and the main vision
  // call below, so its latency (a single ~2-5s call per the spike) overlaps
  // the main call's 20-40s instead of stacking after it. Awaited once, right
  // before the return, with its own hard timeout — see runDoorAnchorShadow.
  const doorAnchorPromise = runDoorAnchorShadow(client, base64Image, mediaType);

  const { satellite, references = [], houseStyleHint, corpusBiasNote, mode = 'design' } = options;

  const refMessages = await buildReferenceMessages(references);
  const fewShotMessages = await buildFewShotMessages(fewShotExamples);
  const trainingCount = fewShotExamples.filter(e => e.source === 'training').length;
  const designCount = fewShotExamples.filter(e => e.source === 'design').length;
  const refsNote = references.length > 0
    ? `\n\nYou have ${references.length} product reference image(s) loaded in the conversation so you can more accurately recognize specific wreath sizes, spritzer shapes, and garland styles.`
    : '';
  // Enumerate every example source so the count is never wrong (a missing
  // source made the note claim "0 examples" when only design examples loaded).
  const exampleParts: string[] = [];
  if (trainingCount) exampleParts.push(`${trainingCount} completed-job reference(s)`);
  if (designCount) exampleParts.push(`${designCount} staff-confirmed design example(s) from sent quotes`);
  const examplesNote = exampleParts.length > 0
    ? `\n\nYou have ${exampleParts.join(', ')} shown in the conversation history below. Completed-job references and staff-confirmed designs are GROUND TRUTH from real installs — highest trust. Match their precision and coordinate style.`
    : '';
  const satelliteNote = satellite
    ? `\n\nTWO IMAGES WILL BE PROVIDED: (1) street view — front elevation. Use for the STREET-VIEW polylines (santasLines, gingerbreadLines) in streetview coordinates, bushes/trees/columns, wreaths, spritzers. (2) satellite/top-down of the same property. Use for the SATELLITE polylines (satelliteSantasLines, satelliteGingerbreadLines) in satellite image coordinates. Each polyline set lives in its OWN image's coordinate space — do not mix.${
        satellite.feetPerPixel
          ? ` Satellite feet-per-pixel scale: ${satellite.feetPerPixel.toFixed(4)} ft/px (image is top-down, no perspective). Compute satelliteSantasFootage and satelliteGingerbreadFootage by summing each polyline's pixel-distance (in the satellite image's native pixel dimensions, which is 640x640 unless otherwise noted; but your polyline coords are normalized 0-1 so multiply by 640 before applying scale) and multiplying by the scale. Round to nearest 5ft.`
          : ''
      }`
    : '';
  // Audit fix: cap the user-supplied hint before interpolating it into the
  // system prompt (untrusted free text — don't let it balloon the prompt).
  const safeStyleHint = houseStyleHint?.slice(0, 200);
  const styleNote = safeStyleHint
    ? `\n\nHouse style hint from user: ${safeStyleHint}. Prior training examples shown are selected to match this style where possible.`
    : '';
  // #8 Stage C (C3): satellite orientation self-check. Flipping the red (front)
  // and blue (ridge+sides) buckets on the top-down image is the single most
  // common satellite mistake — force an explicit street-view cross-check before
  // the model commits. Only relevant when a satellite image is supplied.
  const satelliteSelfCheck = satellite
    ? `\n\nSATELLITE ORIENTATION SELF-CHECK (do this BEFORE finalizing the satellite polylines): the top-down view makes it easy to mislabel which edge is the front. (1) Find the road in the satellite image and CONFIRM it against the street-view image — the front roof edge is the one whose plane faces that road. (2) satelliteSantasLines (red) MUST be that road-facing FRONT edge; satelliteGingerbreadLines (blue) are its ridge PLUS the two SIDE edges. (3) Cross-check the result against the street view: if your red/blue assignment would put "front" on an edge the street view clearly shows is a side or the ridge, they are FLIPPED — swap them. A flipped front/side is the single most common satellite error, so verify orientation before answering.`
    : '';
  // W5-012 (#110 wave 5): split the system prompt into a STATIC prefix (the
  // base prompt — ~3,400 tokens of ROOFLINE_TRACING_RULES + OUTPUT_JSON_SCHEMA
  // + mode-specific instructions, byte-identical across every call for a given
  // mode) and a DYNAMIC suffix (per-request notes: reference/example counts,
  // satellite hints, the user's style-hint text, corpus bias).
  //
  // cache-breakpoint fix: the dynamic suffix must NOT sit between the cached
  // static prompt and the cached reference-image block. Its per-request text
  // (e.g. satellite.feetPerPixel.toFixed(4)) changed the prefix hash for the
  // reference block's cache_control breakpoint on every address, so the ~6-image
  // library was re-written at 1.25x and almost never read back (a standing
  // surcharge instead of the intended ~90% saving). The suffix now rides in the
  // FINAL user message instead, so [static system prompt] + [reference block]
  // form a byte-stable cached prefix. The model still receives the exact same
  // words — only WHERE the dynamic text lives changed, not its content.
  const staticSystemPrompt = baseSystemPromptFor(mode);
  const dynamicSystemSuffix = refsNote + satelliteNote + satelliteSelfCheck + styleNote + examplesNote + (corpusBiasNote ?? '');

  const content: Array<{ type: 'image'; source: { type: 'base64'; media_type: typeof validMediaTypes[number]; data: string } } | { type: 'text'; text: string }> = [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType as typeof validMediaTypes[number],
        data: base64Image,
      },
    },
  ];
  if (satellite) {
    content.push({
      type: 'text',
      text: 'Image 1 above: street view. Image 2 below: satellite top-down of the same property.',
    });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: satellite.mediaType, data: satellite.base64 },
    });
  }
  // Per-request notes (reference/example counts, satellite hints, style hint,
  // corpus bias) ride in the final user turn — NOT in the system array — so the
  // static system prompt + reference-image block stay a byte-stable cached
  // prefix (see the cache-breakpoint note above). Same words, new location.
  // Omitted when empty (a blank/whitespace-only text block is a 400 from the API).
  if (dynamicSystemSuffix.trim()) {
    content.push({ type: 'text', text: dynamicSystemSuffix });
  }
  content.push({
    type: 'text',
    text: mode === 'completed'
      ? 'This is a NIGHT photo of a COMPLETED install with the lights ON. Record ONLY what is actually installed and lit — trace the lit roof runs, and detect the wrapped / hung / planted items that are visibly lit. Do not suggest anything that is not there. Respond with JSON only.'
      : 'Estimate Christmas lighting measurements for this house. Polylines go on the street-view image only. Respond with JSON only.',
  });

  // #149: request built ONCE so a bounded retry (below) reuses the IDENTICAL
  // params object — the cached static-prompt prefix (and the reference-image
  // block above it) hits on the second call exactly as on any repeat request.
  const request = {
    model: 'claude-sonnet-4-6',
    // W5-011 (#110 wave 5): 2048 was too tight for a large/commercial house —
    // a truncated response makes extractJson throw, silently dropping the
    // whole seed. Only actual output tokens are billed, so raising the
    // ceiling costs nothing on the common case and just removes the failure
    // mode on the rare big one.
    max_tokens: 8192,
    system: [
      // W5-012 (#110 wave 5): the static base prompt (ROOFLINE_TRACING_RULES +
      // OUTPUT_JSON_SCHEMA + mode instructions) is byte-identical across every
      // call for a given mode — cache it so it's billed once per TTL window
      // instead of on every analyze call. The system array is ONLY this static
      // block now: the per-request notes moved into the final user message so
      // the reference-image block downstream stays a byte-stable cached prefix.
      { type: 'text' as const, text: staticSystemPrompt, cache_control: { type: 'ephemeral' as const } },
    ],
    messages: [
      ...refMessages,
      ...fewShotMessages,
      { role: 'user' as const, content },
    ],
  };
  const requestOnce = () => client.messages.create(request);

  // #149: parse stage pulled out so it can run against the first response
  // and, on a retry, again against a fresh one — identical logic either time.
  const parseResponse = (response: Awaited<ReturnType<typeof requestOnce>>): unknown => {
    // W5-011 (#110 wave 5): a large/commercial house can still hit the (much
    // higher) ceiling — log so it's visible instead of silently truncating into
    // a parse failure below.
    if (response.stop_reason === 'max_tokens') {
      console.warn(`[analyzePhoto] response truncated at max_tokens (mode=${mode}) — JSON may be incomplete`);
    }

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text response from Claude');
    }

    const raw = textBlock.text.trim();
    return extractJson(raw);
  };

  // The first call stays OUTSIDE the try — an API-call rejection (network,
  // 5xx, rate limit; the Anthropic SDK already retries those internally)
  // must propagate immediately and never trigger the #149 retry below.
  const first = await requestOnce();
  let parsedRaw: unknown;
  try {
    parsedRaw = parseResponse(first);
  } catch (err) {
    // #149: one bounded retry on transient unusable model JSON (missing text
    // block / extractJson throw) — never on an API-call failure (caught
    // above, outside this try). A second parse failure propagates exactly
    // like before, so the route's imagery-only fail-safe still fires.
    console.warn(`[analyzePhoto] model JSON unusable (mode=${mode}) — retrying once (#149): ${(err as Error).message}`);
    parsedRaw = parseResponse(await requestOnce());
  }
  const parsed = parsedRaw as PhotoAnalysisResult;

  const finalSantasLines = normalizeLines(parsed.satelliteSantasLines);
  const finalGingerbreadLines = normalizeLines(parsed.satelliteGingerbreadLines);
  const finalSatelliteSantasFootage = coerceFootage(parsed.satelliteSantasFootage);
  const finalSatelliteGingerbreadFootage = coerceFootage(parsed.satelliteGingerbreadFootage);

  // SHADOW MODE (deterministic-satellite-footage): recompute satellite footage
  // from the model's OWN drawn lines, in pure TypeScript, purely for
  // visibility — never consumed by pricing. Needs the REAL pixel dimensions
  // of the exact satellite image bytes the model was shown (satellite.base64
  // above), not an assumed "640x640" (a live training row measures 642x470).
  // Best-effort: any decode failure (corrupt bytes, no satellite supplied)
  // just leaves both computed fields null — this must never throw and break
  // a live analyze call.
  let satelliteImgWidthPx: number | null = null;
  let satelliteImgHeightPx: number | null = null;
  if (satellite) {
    try {
      const meta = await sharp(Buffer.from(satellite.base64, 'base64')).metadata();
      satelliteImgWidthPx = meta.width ?? null;
      satelliteImgHeightPx = meta.height ?? null;
    } catch {
      // Decode failure — leave both null; footageFromLines treats null
      // dimensions as "cannot compute" (returns null), not a thrown error.
    }
  }
  const computedSatelliteSantasFootage = footageFromLines(
    finalSantasLines, satelliteImgWidthPx, satelliteImgHeightPx, satellite?.feetPerPixel,
  );
  const computedSatelliteGingerbreadFootage = footageFromLines(
    finalGingerbreadLines, satelliteImgWidthPx, satelliteImgHeightPx, satellite?.feetPerPixel,
  );

  // SHADOW MODE (door-anchor scale): awaited last, after all the other
  // post-processing above has had time to run concurrently with it. Already
  // internally time-bounded (DOOR_ANCHOR_TIMEOUT_MS) and failure-isolated —
  // this await can never throw and never waits longer than that timeout.
  const doorAnchor = await doorAnchorPromise;

  return {
    ...parsed,
    // Fix round (PR #916): stamp the prompt version that actually produced
    // this result, always the live constant — never trust anything the model
    // itself might echo back under this key (it's not part of the requested
    // JSON schema, so `...parsed` above should never carry it, but override
    // explicitly rather than rely on that).
    promptVersion: ANALYZER_PROMPT_VERSION,
    // Audit fix: coerce form-facing scalars (raw JSON is cast, never validated).
    santasFootage: coerceFootage(parsed.santasFootage),
    santasDifficulty: coerceDifficulty(parsed.santasDifficulty),
    gingerbreadFootage: coerceFootage(parsed.gingerbreadFootage),
    gingerbreadDifficulty: coerceDifficulty(parsed.gingerbreadDifficulty),
    santasLines: normalizeLines(parsed.santasLines),
    gingerbreadLines: normalizeLines(parsed.gingerbreadLines),
    satelliteSantasLines: finalSantasLines,
    satelliteGingerbreadLines: finalGingerbreadLines,
    satelliteSantasFootage: finalSatelliteSantasFootage,
    satelliteGingerbreadFootage: finalSatelliteGingerbreadFootage,
    // SHADOW MODE fields — see the PhotoAnalysisResult type comment. Rounded
    // ONCE here (never inside footageFromLines, which returns an unrounded
    // float) to the nearest whole foot, matching Math.round's standard
    // round-half-up direction; the model's own stated numbers are rounded to
    // the nearest 5ft by its own prompt instruction, so these are
    // intentionally a finer-grained "what the lines actually measure".
    computedSatelliteSantasFootage:
      computedSatelliteSantasFootage == null ? null : Math.round(computedSatelliteSantasFootage),
    computedSatelliteGingerbreadFootage:
      computedSatelliteGingerbreadFootage == null ? null : Math.round(computedSatelliteGingerbreadFootage),
    satelliteSantasFootageDisagrees: satelliteFootageDisagrees(finalSatelliteSantasFootage, computedSatelliteSantasFootage),
    satelliteGingerbreadFootageDisagrees: satelliteFootageDisagrees(finalSatelliteGingerbreadFootage, computedSatelliteGingerbreadFootage),
    // SHADOW MODE fields — see the PhotoAnalysisResult type comment and
    // runDoorAnchorShadow. Always all-null together on any failure/timeout.
    doorAnchorFtPerPx: doorAnchor.doorAnchorFtPerPx,
    doorAnchorSource: doorAnchor.doorAnchorSource,
    doorAnchorConfidence: doorAnchor.doorAnchorConfidence,
    preferredSource: parsed.preferredSource === 'satellite' ? 'satellite' : 'street',
    // W5-026: enum-validate AFTER box-normalization — a detection with a
    // hallucinated box gets dropped by normalizeBoxArray first; one with a
    // hallucinated type/size/tier gets dropped here.
    miniLightDetections: validateMiniLightDetections(normalizeBoxArray(parsed.miniLightDetections)),
    wreathDetections: validateWreathDetections(normalizeBoxArray(parsed.wreathDetections)),
    spritzerDetections: validateSpritzerDetections(normalizeBoxArray(parsed.spritzerDetections)),
    garlandDetections: validateGarlandDetections(normalizeBoxArray(parsed.garlandDetections)),
  };
}
