// PERMANENT LIGHTING photo analyzer (ledger #88) — structurally parallel to
// `src/lib/photoAnalysis.ts` (the HOLIDAY analyzer) but a COMPLETELY SEPARATE
// taxonomy and prompt. Do not merge or share prompt text between the two —
// they price different products and a shared prompt would drift both ways.
//
// PERMANENT TAXONOMY (see `src/lib/permanent/types.ts` for the locked domain):
// - ROOFLINE ONLY. We detect the gutter/fascia roofline run on up to four
//   sides of the house — front, left, right, back — wherever visible. Each
//   run is one polyline tagged with the side it sits on.
// - CORNERS. Every vertex of a traced polyline (including its two endpoints)
//   is a "corner" — a transition where the aluminum track needs an end cap or
//   a mitred joint. A straight run has 2 corners; a run traced start → apex →
//   end (a gable peak) has 3. This mirrors the Permanent domain rule already
//   encoded in `projectPermanent.ts` (every polyline vertex counts, a peak
//   always costs 3) — the analyzer's corner count should line up with what
//   that projector would compute from the same polyline.
// - GAPS. A NET-NEW concept the holiday analyzer does not have: a gap is a
//   break IN THE ROOFLINE on one side — a stretch where there is no gutter/
//   fascia to mount track on (a garage-to-house jog, a bay window return, a
//   chimney interruption, a porch roof set back from the main roofline) where
//   the track run stops and restarts. We report gap CANDIDATES: an approximate
//   length in feet when a scale can be derived (satellite feet-per-pixel, or a
//   known reference edge), else just a position/flag so staff can measure it
//   by hand. Gaps drive extension-cable / splitter counts in the BOM — see
//   `PermanentGap` in `types.ts`.
//
// EXPLICITLY EXCLUDED — none of this holiday-analyzer machinery applies here:
// - NO ridge tracing (permanent track never runs the ridge).
// - NO "peak" as a distinct roof-feature class, and no red/blue Santa's vs.
//   Gingerbread package split — permanent has one package model, not two.
// - NO mini-lights, wreaths, spritzers, or garland detection — permanent is
//   roofline-puck-on-track ONLY. No accessories, no decorations.
//
// Like the holiday analyzer, this supports BOTH a street-view image and a
// satellite (top-down) image in the same call — satellite is frequently the
// ONLY vantage point that shows the left/right/back rooflines at all, since a
// street photo usually only shows the front (and maybe a sliver of one side).
//
// Reuses the same Anthropic client (`getClaudeClient`), the same image
// downscale-for-vision helper pattern, and the same JSON-extraction plumbing
// as the holiday analyzer, so the two analyzers stay consistent in cost and
// reliability characteristics even though their prompts never share text.

import sharp from 'sharp';
import { getClaudeClient } from '../claude';

// --- Result types ------------------------------------------------------

export type PermanentSide = 'front' | 'left' | 'right' | 'back';

const PERMANENT_SIDES: readonly PermanentSide[] = ['front', 'left', 'right', 'back'];

/**
 * One detected roofline run. `points` is a FLAT array [x0,y0,x1,y1,...] in the
 * SAME normalized-image-coordinate convention as the holiday analyzer's
 * LineSegment (0.0-1.0, origin top-left) — flattened (rather than pairs) to
 * match `projectPermanent.ts`'s polyline convention, since permanent designs
 * and this analyzer's output both ultimately feed the same per-side projector.
 */
export type PermanentRooflineRun = {
  side: PermanentSide;
  points: number[];
  label: string; // e.g. "front roofline ~42ft"
  footageFt?: number; // this run's own estimated length, when derivable
};

/**
 * A candidate break in the roofline on one side — the run stops and (usually)
 * restarts further along. `lengthFt` is populated when a scale is derivable
 * (satellite feet-per-pixel, or a confident street-view reference); otherwise
 * omitted and the gap is still reported (position + side) so staff can
 * measure it manually. `position` is the normalized [x,y] midpoint of the gap
 * in the image it was detected on.
 */
export type PermanentGapCandidate = {
  side: PermanentSide;
  position: [number, number];
  lengthFt?: number;
  label: string; // e.g. "gap at garage return ~6ft"
};

export type PermanentPhotoAnalysisResult = {
  rooflineRuns: PermanentRooflineRun[];
  feetBySide: Record<PermanentSide, number>;
  cornersBySide: Record<PermanentSide, number>;
  gapCandidates: PermanentGapCandidate[];
  // Satellite-based measurements, mirroring the holiday analyzer's dual-image
  // handling — populated only when a satellite image is supplied. Polylines
  // here live in the SATELLITE image's own coordinate space.
  satelliteRooflineRuns: PermanentRooflineRun[];
  satelliteFeetBySide: Record<PermanentSide, number>;
  satelliteCornersBySide: Record<PermanentSide, number>;
  satelliteGapCandidates: PermanentGapCandidate[];
  preferredSource: 'street' | 'satellite';
  notes: string;
  confidence: 'low' | 'medium' | 'high';
};

// --- JSON extraction (byte-identical approach to the holiday analyzer) ---

// Strip markdown code fences and pull the outer JSON object out of Claude's
// text response. Uses a brace-balance scan instead of a greedy regex so a
// trailing "```" or extra prose doesn't corrupt the parse. Mirrors
// `extractJson` in `src/lib/photoAnalysis.ts` exactly (duplicated rather than
// imported — this module intentionally has zero dependency on the holiday
// analyzer file so the two taxonomies can never entangle).
export function extractJson(text: string): unknown {
  let s = text.trim();
  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  if (fenceMatch) s = fenceMatch[1].trim();
  try { return JSON.parse(s); } catch { /* fall through to balance scan */ }
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

// --- Sanitizers / normalizers / validators --------------------------------

function zeroBySide(): Record<PermanentSide, number> {
  return { front: 0, left: 0, right: 0, back: 0 };
}

export function coerceSide(v: unknown): PermanentSide | undefined {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (PERMANENT_SIDES as readonly string[]).includes(s) ? (s as PermanentSide) : undefined;
}

// Coerce a footage value (Claude sometimes returns "40ft" or "40"). Number()
// handles numeric strings; anything non-finite or negative falls back to 0.
// Mirrors `coerceFootage` in the holiday analyzer.
export function coerceFootage(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// A gap length is optional (undefined when no scale is derivable) — unlike
// footage, an invalid/negative value should DROP the length rather than
// coerce to 0 (a 0-length gap is a contradiction; better to omit it and let
// staff measure by hand than assert a false "no gap" length).
function coerceOptionalFootage(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Below this a "gap" is noise (rounding jitter / touching runs), not a real
// break that needs an extension cable — mirrors GAP_MIN_FT's role in
// projectPermanent.ts (there 0.5ft; kept the same threshold here since it's
// measuring the same physical concept from a photo instead of a design).
export const GAP_MIN_FT = 0.5;

// Pick the coordinate scale (0-1 vs 0-1000) by MAJORITY (median), not the
// global max, so a single hallucinated out-of-range point can't collapse
// every real coordinate to a near-zero sliver. Mirrors `pickScale` in the
// holiday analyzer.
function pickScale(coords: number[]): number {
  const finite = coords.filter(c => Number.isFinite(c));
  if (finite.length === 0) return 1;
  const sorted = [...finite].sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  return median > 1.5 ? 1 / 1000 : 1;
}

/**
 * Normalize a flat-point roofline run array: rescale 0-1000 → 0-1 by majority
 * scale, drop any individual coordinate still out of [0,1] after rescaling,
 * drop a run whose surviving point count falls below 2 vertices (4 numbers),
 * and drop any run with an unrecognized/missing `side`. Mirrors
 * `normalizeLines`'s hallucination-drop policy, adapted to the flat-array +
 * side-tag shape used here.
 */
export function normalizeRooflineRuns(
  runs: PermanentRooflineRun[] | undefined,
): PermanentRooflineRun[] {
  if (!Array.isArray(runs)) return [];
  const allCoords = runs.flatMap(r => (Array.isArray(r.points) ? r.points : []));
  if (allCoords.length === 0) return [];
  const scale = pickScale(allCoords);

  const out: PermanentRooflineRun[] = [];
  for (const r of runs) {
    const side = coerceSide(r.side);
    if (!side) continue; // off-enum / missing side — hallucination, drop the run
    const rawPoints = Array.isArray(r.points) ? r.points : [];
    const scaledPairs: [number, number][] = [];
    for (let i = 0; i + 1 < rawPoints.length; i += 2) {
      const x = rawPoints[i] * scale;
      const y = rawPoints[i + 1] * scale;
      if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
        scaledPairs.push([x, y]);
      }
    }
    if (scaledPairs.length < 2) continue; // needs at least a 2-point run
    out.push({
      side,
      points: scaledPairs.flat(),
      label: typeof r.label === 'string' ? r.label : '',
      footageFt: coerceOptionalFootage(r.footageFt),
    });
  }
  return out;
}

/**
 * Normalize gap candidates: drop off-enum sides, drop malformed/out-of-range
 * positions, drop any gap whose (derivable) length is below GAP_MIN_FT — a
 * gap with NO derivable length is kept (position/flag only, per spec) since
 * "unknown length" is not the same claim as "negligible length."
 */
export function normalizeGapCandidates(
  gaps: PermanentGapCandidate[] | undefined,
): PermanentGapCandidate[] {
  if (!Array.isArray(gaps)) return [];
  const allCoords = gaps.flatMap(g => (Array.isArray(g.position) ? g.position : []));
  const scale = allCoords.length > 0 ? pickScale(allCoords) : 1;

  const out: PermanentGapCandidate[] = [];
  for (const g of gaps) {
    const side = coerceSide(g.side);
    if (!side) continue;
    const rawPos = Array.isArray(g.position) ? g.position : [];
    if (rawPos.length < 2) continue;
    const x = rawPos[0] * scale;
    const y = rawPos[1] * scale;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) continue;
    const lengthFt = coerceOptionalFootage(g.lengthFt);
    if (lengthFt !== undefined && lengthFt < GAP_MIN_FT) continue; // negligible, not a real gap
    out.push({
      side,
      position: [x, y],
      lengthFt,
      label: typeof g.label === 'string' ? g.label : '',
    });
  }
  return out;
}

/** Sum each run's own footageFt (when present) into a per-side total. Runs
 * without a footageFt contribute 0 — staff can fill footage in manually via
 * the per-side override fields on PermanentQuoteFields. Rounded to match the
 * "quoted per whole foot" convention used elsewhere in the permanent domain
 * (see projectPermanentDesign). */
export function sumFeetBySide(runs: PermanentRooflineRun[]): Record<PermanentSide, number> {
  const totals = zeroBySide();
  for (const r of runs) {
    totals[r.side] += r.footageFt ?? 0;
  }
  for (const k of PERMANENT_SIDES) {
    totals[k] = Math.round(totals[k]);
  }
  return totals;
}

/** Every vertex of every run on a side is a corner (Naldo's rule: a run
 * traced start→apex→end counts 3). Mirrors cornersBySide in
 * projectPermanent.ts — a run needs >=2 vertices to count at all (already
 * enforced by normalizeRooflineRuns). */
export function sumCornersBySide(runs: PermanentRooflineRun[]): Record<PermanentSide, number> {
  const totals = zeroBySide();
  for (const r of runs) {
    const verts = Math.floor(r.points.length / 2);
    if (verts >= 2) totals[r.side] += verts;
  }
  return totals;
}

// --- Image downscale (byte-identical approach to the holiday analyzer) ---

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

// Claude Vision's effective max resolution is ~1568px on the long edge —
// anything larger is downscaled server-side before the model sees it anyway.
// Mirrors MAX_VISION_EDGE_PX / downscaleImageForVision in the holiday
// analyzer exactly.
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
    if (longEdge <= MAX_VISION_EDGE_PX) {
      return { base64: raw, mediaType: mediaType as ImageMediaType };
    }
    const resized = await sharp(buf)
      .resize({ width: MAX_VISION_EDGE_PX, height: MAX_VISION_EDGE_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { base64: resized.toString('base64'), mediaType: 'image/jpeg' };
  } catch {
    const comma = base64.indexOf(',');
    const raw = base64.startsWith('data:') && comma >= 0 ? base64.slice(comma + 1) : base64;
    return { base64: raw, mediaType: mediaType as ImageMediaType };
  }
}

// --- Prompt + schema -------------------------------------------------------

const PERMANENT_TRACING_RULES = `SCOPE — ROOFLINE ONLY: you are estimating a PERMANENT lighting install — RGB pucks riding in a track mounted to the gutter/fascia. There is no red/blue package split, no ridge lighting, and no accessories (no mini-lights, wreaths, spritzers, or garland). Trace ONLY the roofline: the gutter / fascia line where the roof edge meets the top of the siding, on EVERY side of the house that is visible in the image — FRONT, LEFT, RIGHT, and BACK.

1. A ROOFLINE RUN is the BOTTOM edge of a roof plane — the horizontal (or gently sloped, on a gable rake) line where the shingles end and the gutter/fascia trough sits. Ignore anything mid-slope: skylights, vents, dormers, shadow bands, texture changes. The gutter is strictly at the bottom of the slope.

2. SIDE TAGGING — tag every run with the side of the house its roof plane faces: "front" (faces the street), "left", "right" (the two side elevations), or "back" (faces the rear yard). A gable rake belongs to the side its triangle points toward, same as the front/side rule in holiday roofline tracing.

3. MULTIPLE RUNS PER SIDE — a side of the house often has more than one physically separate roofline run (a garage wing set forward of the main house, a bay window bump-out, a porch roof at a different height). Trace EACH physically distinct run as its own entry, all tagged to the same side. Do NOT bridge two visually separate runs into one polyline — a real physical separation between runs is a GAP (see below), not a corner within one run.

4. CORNERS — every vertex you place on a polyline (INCLUDING both endpoints) is a corner: a point where the aluminum track needs an end cap or a mitred joint. A straight run has exactly 2 corners (its two ends). A run traced through a direction change — e.g. start → up a gable rake → across the apex → down the far rake → end — has as many vertices as needed to follow the shape; a simple gable peak (base → apex → base) is 3 vertices = 3 corners. Use as many points as the roofline's actual shape needs — don't add extra vertices along a straight stretch just to inflate the corner count, and don't skip a real direction change to save a vertex.

5. GAP DETECTION (net-new — this concept does not exist in holiday-lighting roofline tracing): a GAP is a break IN THE ROOFLINE on one side — a place where there is no continuous gutter/fascia to mount track on, so the physical track run stops and (usually) restarts further along. Common causes: the roofline jogs inward/outward at a wing or bump-out, a chimney interrupts the eave, a porch roof sits at a different height and its own gutter doesn't connect to the main house's gutter, or the roofline is simply not there for a stretch (open soffit, a gap in the fascia). For each gap you notice, report its side, an approximate position (the [x,y] point roughly at the middle of the break, in the SAME image and coordinate space as the roofline runs), and its length in feet IF you can derive one (e.g. from the satellite feet-per-pixel scale, or a confident comparison to a nearby run's known footage) — otherwise omit the length and just flag the position so staff can measure it on site. Do not invent a length you can't support from the image.

6. DO NOT TRACE (same discipline as holiday roofline tracing):
   - Downspouts (vertical gutter pipes) — track never runs down a wall.
   - Power lines, utility wires, or anything strung between poles/mast.
   - Tree branches, foliage silhouettes, fence tops, neighboring rooflines.
   - The ridge (the peak apex where two slopes meet) — permanent track is NEVER installed on the ridge.
   - Any mid-slope surface feature (skylight, vent, dormer body).

7. NO RED/BLUE SPLIT: unlike holiday lighting, there is only ONE roofline category here. Every run you trace goes into the same "rooflineRuns" array, distinguished only by its "side" tag — never split runs into two packages.`;

const PERMANENT_OUTPUT_JSON_SCHEMA = `You MUST respond with ONLY valid JSON matching this schema. No markdown fences, no prose before or after:
{
  "rooflineRuns": [
    { "side": "front" | "left" | "right" | "back", "points": [x0,y0,x1,y1, ...], "label": "front roofline ~42ft", "footageFt": number }
  ],
  "gapCandidates": [
    { "side": "front" | "left" | "right" | "back", "position": [x, y], "lengthFt": number, "label": "gap at garage return ~6ft" }
  ],
  "satelliteRooflineRuns": [
    { "side": "front" | "left" | "right" | "back", "points": [x0,y0,x1,y1, ...], "label": "front roofline ~48ft", "footageFt": number }
  ],
  "satelliteGapCandidates": [
    { "side": "front" | "left" | "right" | "back", "position": [x, y], "lengthFt": number, "label": "gap at bay window ~4ft" }
  ],
  "preferredSource": "street" | "satellite",
  "notes": "1-2 sentences on what you saw and any caveats",
  "confidence": "low" | "medium" | "high"
}

"points" is a FLAT array [x0,y0,x1,y1,x2,y2,...] of normalized 0.0-1.0 image coordinates (origin top-left), not an array of pairs. Use as many points as the roofline's real shape needs. "footageFt" and "lengthFt" are each this run's/gap's own best estimate in feet when you can support one from the image — omit the field entirely if you cannot derive a real number (never invent one). Round any footage to the nearest 5 feet. If a photo is too poor to trace reliably, use confidence "low" and return empty arrays rather than guessing.`;

/**
 * The permanent-lighting system prompt. Deliberately does NOT reuse or
 * reference the holiday analyzer's SYSTEM_PROMPT / COMPLETED_INSTALL_PROMPT —
 * separate product, separate taxonomy, separate prompt text.
 */
export const SYSTEM_PROMPT = `You are a permanent lighting estimator for Yule Love Lights, a Long Island NY lighting company. You analyze photos of houses to identify where to mount PERMANENT track-lighting (RGB pucks riding in an aluminum track fixed to the gutter/fascia) — this is a year-round install, not seasonal holiday lighting.

${PERMANENT_TRACING_RULES}

SATELLITE MEASUREMENT:
When a satellite (top-down) image is supplied, ALSO produce polylines in the SATELLITE image's own coordinate space, covering every side of the house's roofline visible from above — front, left, right, and back. Satellite is frequently the ONLY vantage point that shows the left, right, and back rooflines at all (a street photo usually only shows the front and maybe a sliver of one side), so treat the satellite image as the primary source for left/right/back when it's supplied.

HOW TO TRACE THE SATELLITE ROOFLINE:
- Snap polyline points ONLY to the ACTUAL ROOF EDGE (the visible shingle seam / gutter line where the roof plane ends and the wall/ground begins).
- Do NOT trace the property boundary, lot outline, driveways, sidewalks, pools, decks, patios, sheds, or detached garages — only the primary structure's roof.
- If the roofline is L-shaped / U-shaped / has wings or bump-outs, use enough points to follow every corner — a bounding box or a single straight line across an irregular footprint is wrong.
- Shadows and tree canopy can obscure an edge — if you can't see it, do not guess; skip that segment.
- A feet-per-pixel scale hint will be provided when available — use it to compute "footageFt" for each run (sum the polyline's segment lengths in normalized coords, multiply by the image's native pixel width, then by the scale) and to compute "lengthFt" for any gap whose extent you can read off the image.

Set "preferredSource" to "satellite" when the roofline has meaningful complexity on more than the front (wings, an L/U shape, multiple wings) or when street view can't show left/right/back at all. Otherwise set it to "street".

If you could not reliably trace a side (heavy tree cover, low contrast, that side simply isn't visible in either image), leave that side out of the arrays rather than guessing — an incomplete-but-accurate result is far better than a hallucinated run. Note any side you could not measure in "notes".

${PERMANENT_OUTPUT_JSON_SCHEMA}`;

// --- Analyzer entrypoint ---------------------------------------------------

export type PermanentSatelliteReference = {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png';
  feetPerPixel?: number; // known scale from Google Static Maps zoom level
};

export type AnalyzePermanentOptions = {
  satellite?: PermanentSatelliteReference;
};

/**
 * Analyze a house photo (and optionally a satellite/top-down image) for
 * permanent-lighting roofline runs, per-side corner counts, and roofline
 * gaps. Mirrors `analyzePhoto`'s signature/behavior shape (image input,
 * downscale, model call, JSON parse, validate) from the holiday analyzer,
 * but with the permanent-only taxonomy above — no few-shot examples, no
 * reference-asset library (permanent has no accessory catalog to teach).
 */
export async function analyzePermanentPhoto(
  base64Image: string,
  mediaType: string,
  options: AnalyzePermanentOptions = {},
): Promise<PermanentPhotoAnalysisResult> {
  const client = getClaudeClient();
  if (!client) {
    throw new Error('Claude API not configured — set ANTHROPIC_API_KEY in .env.local');
  }

  const validMediaTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
  if (!validMediaTypes.includes(mediaType as typeof validMediaTypes[number])) {
    throw new Error(`Unsupported image type: ${mediaType}`);
  }

  const { satellite } = options;

  const satelliteNote = satellite
    ? `\n\nTWO IMAGES WILL BE PROVIDED: (1) street view — front elevation, use for the street-view "rooflineRuns" in that image's coordinates. (2) satellite/top-down of the same property — use for "satelliteRooflineRuns" in the satellite image's OWN coordinates. Do not mix the two coordinate spaces.${
        satellite.feetPerPixel
          ? ` Satellite feet-per-pixel scale: ${satellite.feetPerPixel.toFixed(4)} ft/px (top-down, no perspective). Your satellite polyline coords are normalized 0-1 — multiply by the image's native pixel width (640 unless otherwise noted) before applying the scale to derive footageFt/lengthFt.`
          : ''
      }`
    : '';

  const dynamicSystemSuffix = satelliteNote;

  const content: Array<
    | { type: 'image'; source: { type: 'base64'; media_type: typeof validMediaTypes[number]; data: string } }
    | { type: 'text'; text: string }
  > = [
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
  content.push({
    type: 'text',
    text: 'Identify the permanent-lighting roofline runs (and any roofline gaps) for this house. Respond with JSON only.',
  });

  const response = await client.messages.create({
    // Same model the holiday analyzer uses (src/lib/photoAnalysis.ts) — do
    // not hardcode a different one for this analyzer.
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ...(dynamicSystemSuffix.trim() ? [{ type: 'text' as const, text: dynamicSystemSuffix }] : []),
    ],
    messages: [{ role: 'user', content }],
  });

  if (response.stop_reason === 'max_tokens') {
    console.warn('[analyzePermanentPhoto] response truncated at max_tokens — JSON may be incomplete');
  }

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  const raw = textBlock.text.trim();
  const parsed = extractJson(raw) as PermanentPhotoAnalysisResult;

  const rooflineRuns = normalizeRooflineRuns(parsed.rooflineRuns);
  const satelliteRooflineRuns = normalizeRooflineRuns(parsed.satelliteRooflineRuns);
  const gapCandidates = normalizeGapCandidates(parsed.gapCandidates);
  const satelliteGapCandidates = normalizeGapCandidates(parsed.satelliteGapCandidates);

  return {
    rooflineRuns,
    feetBySide: sumFeetBySide(rooflineRuns),
    cornersBySide: sumCornersBySide(rooflineRuns),
    gapCandidates,
    satelliteRooflineRuns,
    satelliteFeetBySide: sumFeetBySide(satelliteRooflineRuns),
    satelliteCornersBySide: sumCornersBySide(satelliteRooflineRuns),
    satelliteGapCandidates,
    preferredSource: parsed.preferredSource === 'satellite' ? 'satellite' : 'street',
    notes: typeof parsed.notes === 'string' ? parsed.notes : '',
    confidence: parsed.confidence === 'high' || parsed.confidence === 'low' ? parsed.confidence : 'medium',
  };
}
