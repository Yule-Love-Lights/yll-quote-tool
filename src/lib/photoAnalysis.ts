import { getClaudeClient } from './claude';
import { StoredCorrection } from './corrections';
import type { StoredReferenceAsset } from './referenceAssets';

export type LineSegment = {
  points: [number, number][]; // normalized 0-1 coords: [[x1,y1], [x2,y2], ...]
  label: string;               // e.g. "front gutter ~40ft"
};

export type MiniLightDetection = {
  type: 'tree' | 'bush' | 'column';
  wrapStyle: 'canopy' | 'trunk';
  stringCount: number;
  box: [number, number, number, number]; // [x, y, width, height] normalized 0-1
  label: string; // e.g. "small bush — 2 strings"
};

export type WreathSize = '24noble' | '30noble' | '36noble' | '48noble' | '36oregon';
export type WreathTier = 'labor' | 'bow' | 'fullDecor';

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
export type GarlandTier = 'labor' | 'bow' | 'fullDecor';

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
  preferredSource: 'street' | 'satellite';
  miniLightDetections: MiniLightDetection[];
  wreathDetections: WreathDetection[];
  spritzerDetections: SpritzerDetection[];
  garlandDetections: GarlandDetection[];
  notes: string;
  confidence: 'low' | 'medium' | 'high';
};

// Strip markdown code fences and pull the outer JSON object out of Claude's
// text response. Uses a brace-balance scan instead of a greedy regex so a
// trailing "```" or extra prose doesn't corrupt the parse. Throws with a
// helpful snippet on failure so callers can see what Claude actually sent.
function extractJson(text: string): unknown {
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

const SYSTEM_PROMPT = `You are a holiday lighting estimator for Yule Love Lights, a Long Island NY Christmas lighting company. You analyze photos of houses to estimate roofline lighting measurements.

PACKAGES:
- Santa's Roofline (gutterline): lights run along the front gutters/eaves — the bottom edge of the roof visible from the street. Measure the total linear footage.
- Gingerbread Ridge (ridgeline): lights run along the peak/ridge of the roof. Measure the total linear footage across all visible ridge lines.

GUTTER-LINE TRACING — CRITICAL RULES (failures here are the #1 cause of under-quoted jobs):

1. The "Santa's gutter" is ALWAYS the BOTTOM edge of the roof plane — the horizontal line where roofing shingles meet the top of the siding, OR the physical gutter trough. Ignore anything mid-slope (mid-roof features, texture breaks, shadow lines). The gutter is specifically the drip edge where the roof ends and the wall begins.

2. ROOF SURFACE FEATURES — roofs frequently have mid-slope features that are NOT part of the gutter or ridge: skylights, vents, dormers, shadow bands, texture changes, and dark rectangular roof surfaces. These are on the roof plane, not its edges. NEVER trace along the edge of any mid-slope feature. The gutter is strictly at the bottom of the slope; the ridge is strictly at the top. If a mid-slope feature partially hides the gutter or ridge, still trace the full run based on where the roof actually ends — estimate through occlusion, do not stop short.

3. MULTI-RUN ROOFLINES — most LI homes have multiple distinct gutter runs visible from the street. Trace EACH as a separate "santasLines" entry:
   - Classic ranch / hip-roof with front gable projection → 1 long horizontal run across the main body PLUS 2 rake runs (diagonal up-and-down) on the gable face PLUS possibly a short horizontal gutter below the gable's eave.
   - Colonial with two-story front and a one-story extension → horizontal run for main front + horizontal run for the extension (different heights).
   - L-shaped footprint → one horizontal run per leg of the L, meeting at a hip or valley.
   - Dormers projecting from the main roof slope → each dormer has its own gable with 2 short rake runs; trace them if they're large enough to light (>4ft each).
   Missing even one of these means the job is under-quoted. When in doubt, trace it — the installer can skip sections later, but can't add what wasn't measured.

3a. LEFT/RIGHT SYMMETRY SELF-CHECK — before returning santasLines, mentally walk the roof from LEFT edge of the photo to RIGHT edge. Does your santasLines list cover BOTH sides of the house? If the left edge has a gutter run going offscreen/around-the-corner, the right edge probably has the mirror. If you only have runs on one side of the main peak, that is almost always a miss — trace the symmetric run on the opposite side. Very few houses have lights on only one side. Over-tracing is far safer than under-tracing: the installer skips what isn't needed, but can never install what wasn't quoted.

3b. NEVER TRACE OFF-ROOF LINES — a polyline MUST follow an actual roof edge (gutter, rake, or ridge) that is physically part of the house. DO NOT trace along:
   - Power lines, utility wires, telephone cables, or any wire strung between poles / attached to a service mast. These often cross in front of the roof near the top of the photo and look tempting as a "ridge," but they are detached from the structure and we do NOT light them.
   - Tree branches or foliage silhouettes.
   - Fence tops, neighboring rooflines, or anything behind the subject house.
   - Horizon lines, cloud edges, or photo artifacts.
   If a horizontal line at the top of the photo is not CLEARLY attached to the roof (no visible connection to a ridge vent, shingle seam, or chimney), it is almost certainly a wire — skip it. When in doubt, do NOT trace it. The cost of missing a real ridge is much smaller than the cost of hallucinating lights floating in mid-air over a power line.

4. RAKE vs. GUTTER — on a gable-end face (the triangular wall below a pitched roof peak), the two diagonal edges going from eave to peak are called RAKE lines. Rakes count as Santa's roofline (lights install the same way). Horizontal eaves at the bottom of the gable also count. A single gable adds ~2× (slope length) of rake + whatever eave runs below it.

RIDGE TRACING — the ridge is the HIGHEST horizontal line on the roof (where two slopes meet at the top). On a gable roof it's one long line running front-to-back. On a hip roof, the ridge is shorter and may be partially or fully hidden behind the front slope. ALWAYS trace a ridge line when a horizontal peak is visible — even if the roof slope has unusual surface features (dark shingles, skylights, dormers, etc.) between the gutter and the peak. The ridge is the top horizontal edge of the roof, independent of what surface is below it. Only return gingerbreadLines = [] when there is genuinely no horizontal ridge visible from street view (e.g., a pure hip roof with no visible top ridge).

MINI LIGHT DETECTION — in addition to roofline, identify every bush, tree, and column visible in the photo that could get mini lights.

TYPES:
- bush: low landscaping shrubs (hedges, foundation plantings, topiaries). Wrap style "canopy" — lights drape over the canopy.
- tree: anything from 6ft sapling to 30ft mature tree. Small trees (<10ft) use "canopy" wrap. Larger trees wrap the trunk + major branches, use "trunk" wrap.
- column: porch columns, lamp posts, entry columns. Wrap style "canopy" (spiral wrap).

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
Default tier is "bow" unless the customer's existing decor style clearly calls for "fullDecor". Never default to "labor".

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

GARLAND DETECTION — identify garland runs: linear rope-of-evergreen decoration along a porch railing, archway, doorway frame, or beam. Garland is sold in 9ft sections ("9ft") or 4.5ft sections ("4.5ft"); default to "9ft" unless you can see a short run. Tier — "labor" = plain greenery, "bow" = greenery with a bow, "fullDecor" = heavy ornament/ribbon/berries; default to "bow". Return ONE bounding box per garland RUN — the box should TIGHTLY span the run's full length along its widest axis. The frontend uses the box WIDTH × the shared feet-per-pixel scale to compute linear feet and derive piece count. Do NOT flag decorative wreaths, individual bows, or roofline runs here — those have their own categories.

DIFFICULTY TIERS (per package):
- easy: single-story home, ground-accessible, simple straight runs, minimal obstacles (low shrubs, open front yard). Installer can work from a short ladder.
- medium: two-story home, moderate complexity (multiple gables, dormers, cut-ups), some obstacles (landscaping, porches, tight access). Installer needs extension ladder.
- hard: three+ stories OR very steep pitch OR highly complex cut-up roofline OR difficult access (tall shrubs, power lines overhead, steep grade, second-story over garage). Installer needs multi-section ladder or scaffolding.

TYPICAL LI HOUSE SIZES (sanity-check):
- Small cape/ranch: 60-90 ft gutterline, 30-50 ft ridge
- Medium colonial: 100-140 ft gutterline, 60-100 ft ridge
- Large colonial/custom: 150-220 ft gutterline, 100-180 ft ridge

LINE MARKUP — CRITICAL:
You must also identify the specific lines you measured, as polylines in NORMALIZED IMAGE COORDINATES (0.0 to 1.0). Origin (0,0) is top-left of the image, (1,1) is bottom-right. Each polyline is an array of [x, y] points that trace along the edge of the roof. Use as many points as needed to follow the curve/angles (straight run = 2 points, L-shape = 3, dormer cut-ups = more).

For each line segment include a short label like "front gutter ~40ft" or "main ridge ~30ft".

SATELLITE MEASUREMENT — CRITICAL for commercial properties and complex rooflines:
When a satellite image is supplied, you MUST ALSO produce polylines in the SATELLITE image's coordinate space for the full visible perimeter (gutterline) AND all ridgelines, as seen from top-down.

Satellite gutterline = the full outer perimeter of the ROOF visible from above (all sides, not just front). Satellite ridgeline = every ridge/peak visible from above (main ridge + cross-gables + dormer ridges).

HOW TO TRACE THE SATELLITE ROOFLINE — follow these rules strictly. If you can't follow them for this image, return an EMPTY array ("satelliteSantasLines": []) instead of guessing:
- Snap polyline points ONLY to the ACTUAL ROOF EDGE (visible shingle seam / gutter line where the roof plane ends and the wall/ground begins). Lighter roofing material against the yard or driveway is usually the edge.
- DO NOT trace the property boundary, the lot outline, driveways, sidewalks, pools, decks, patios, pergolas, sheds, detached garages, or landscaping. ONLY the primary structure's roof.
- If the roof is L-shaped / U-shaped / T-shaped / has a courtyard, USE ENOUGH POINTS to hug every inside corner. A bounding box is WRONG — it will overstate footage. 8-20 points is typical for a modest cut-up; commercial can need 40+.
- Shadows and tree canopy can obscure an edge. If you can't see the edge, DO NOT guess — skip that segment or return an empty array.
- Ridges on the satellite image appear as the BRIGHTEST lines running along the roof's peak (the sunlit side meets the shaded side). Trace along those peak lines, not across the slopes.
- FOOTAGE MUST BE DERIVED FROM THE POLYLINE. Do not invent a number and then draw a polyline to match. Compute: for each segment, sum sqrt((x2-x1)^2 + (y2-y1)^2) in normalized coords, multiply by 640 to get pixels, multiply by the feet-per-pixel scale. Sum across segments. Round to the nearest 5ft. If your polyline is empty, footage is 0.

A feet-per-pixel scale hint will be provided.

The street-view measurement is ALWAYS the front only (what the installer sees from the curb). The satellite measurement captures the FULL roof (all sides). For a simple single-family home these values can match. For a commercial building or complex L-shaped / U-shaped / courtyard home, the satellite number will be much higher and is the correct total.

Set "preferredSource" to "satellite" when:
- The property is commercial (flat roof, big box, strip mall).
- The roof has significant cut-ups, dormers, or wings that aren't visible from street view.
- Street view is heavily obscured by trees, fences, or setback.
Otherwise set it to "street".

If you could not reliably trace the satellite roofline (heavy tree cover, low contrast, image unclear), set satelliteSantasLines to [] and satelliteGingerbreadLines to []. Note this in the "notes" field. The user will trace it manually — an empty array is MUCH better than a wrong one.

You MUST respond with ONLY valid JSON matching this schema. No markdown fences, no prose before or after:
{
  "santasFootage": number,
  "santasDifficulty": "easy" | "medium" | "hard",
  "santasLines": [
    { "points": [[x1,y1], [x2,y2], ...], "label": "front gutter ~40ft" }
  ],
  "gingerbreadFootage": number,
  "gingerbreadDifficulty": "easy" | "medium" | "hard",
  "gingerbreadLines": [
    { "points": [[x1,y1], [x2,y2], ...], "label": "main ridge ~30ft" }
  ],
  "satelliteSantasLines": [
    { "points": [[x1,y1], [x2,y2], ...], "label": "full perimeter ~180ft" }
  ],
  "satelliteSantasFootage": number,
  "satelliteGingerbreadLines": [
    { "points": [[x1,y1], [x2,y2], ...], "label": "main ridge ~50ft" }
  ],
  "satelliteGingerbreadFootage": number,
  "preferredSource": "street" | "satellite",
  "miniLightDetections": [
    { "type": "bush" | "tree" | "column", "wrapStyle": "canopy" | "trunk", "stringCount": number, "box": [x, y, w, h], "label": "foundation bush ~3ft" }
  ],
  "wreathDetections": [
    { "size": "24noble" | "30noble" | "36noble" | "48noble" | "36oregon", "tier": "labor" | "bow" | "fullDecor", "box": [x, y, w, h], "label": "front door wreath ~30in" }
  ],
  "spritzerDetections": [
    { "size": "16" | "24" | "32", "box": [x, y, w, h], "label": "metallic star spritzer 24in" }
  ],
  "garlandDetections": [
    { "length": "9ft" | "4.5ft", "tier": "labor" | "bow" | "fullDecor", "box": [x, y, w, h], "label": "porch railing garland ~18ft" }
  ],
  "notes": "1-2 sentences on what you saw and any caveats",
  "confidence": "low" | "medium" | "high"
}

Round footage to the nearest 5 feet. Coordinates should be precise — trace right along the visible edge. If a photo is too poor, use confidence "low" and return empty line arrays.`;

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export type TrainingExamplePhoto = {
  base64: string;
  mediaType: string;
  tag?: string; // e.g. "front_install", "front_takedown", "side", "detail"
  caption?: string;
};

type FewShotExample = {
  // Support multi-photo training houses OR single-photo corrections.
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
  source: 'correction' | 'training';
};

function correctionToExample(c: StoredCorrection): FewShotExample {
  return {
    photos: [{ base64: c.photo_base64, mediaType: c.photo_media_type, tag: 'front_install' }],
    santasFootage: c.corrected_santas_footage,
    santasDifficulty: c.corrected_santas_difficulty,
    santasLines: c.corrected_santas_lines,
    gingerbreadFootage: c.corrected_gingerbread_footage,
    gingerbreadDifficulty: c.corrected_gingerbread_difficulty,
    gingerbreadLines: c.corrected_gingerbread_lines,
    satelliteSantasLines: c.corrected_satellite_santas_lines ?? [],
    satelliteGingerbreadLines: c.corrected_satellite_gingerbread_lines ?? [],
    miniLightDetections: c.corrected_mini_light_detections ?? [],
    wreathDetections: c.corrected_wreath_detections ?? [],
    spritzerDetections: c.corrected_spritzer_detections ?? [],
    garlandDetections: c.corrected_garland_detections ?? [],
    source: 'correction',
  };
}

function buildFewShotMessages(examples: FewShotExample[]) {
  type Block =
    | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }
    | { type: 'text'; text: string };
  const messages: { role: 'user' | 'assistant'; content: Block[] }[] = [];

  for (const ex of examples) {
    const userContent: Block[] = [];
    const label = ex.source === 'training'
      ? `Completed installation${ex.houseStyle ? ` (${ex.houseStyle})` : ''} — confirmed measurements from takedown.`
      : 'Human-corrected measurement.';

    userContent.push({
      type: 'text',
      text: `${label} ${ex.photos.length > 1 ? `${ex.photos.length} photos provided — front install first, then alternate angles/details.` : ''}`,
    });
    for (const p of ex.photos) {
      const mt = p.mediaType as ImageMediaType;
      userContent.push({ type: 'image', source: { type: 'base64', media_type: mt, data: p.base64 } });
      if (p.tag) userContent.push({ type: 'text', text: `^ tag: ${p.tag}${p.caption ? ` — ${p.caption}` : ''}` });
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

function buildReferenceMessages(references: StoredReferenceAsset[]) {
  if (references.length === 0) return [];
  type Block =
    | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }
    | { type: 'text'; text: string };
  const userContent: Block[] = [
    {
      type: 'text',
      text: `PRODUCT REFERENCE LIBRARY — ${references.length} image(s). These are what each product looks like up close. Use them to more accurately recognize and classify these items when you see them on a house photo.`,
    },
  ];
  for (const r of references) {
    userContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: r.media_type as ImageMediaType,
        data: r.base64,
      },
    });
    const tier = r.tier ? ` · ${r.tier}` : '';
    const cap = r.caption ? ` — ${r.caption}` : '';
    userContent.push({
      type: 'text',
      text: `^ ${r.asset_type} · ${r.size}${tier}${cap}`,
    });
  }
  userContent.push({
    type: 'text',
    text: 'Acknowledge that you have these product references loaded, then wait for the house photo.',
  });
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

export { correctionToExample, type FewShotExample };

export type SatelliteReference = {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png';
  feetPerPixel?: number; // known scale from Google Static Maps zoom level
};

export type AnalyzeOptions = {
  satellite?: SatelliteReference;
  references?: StoredReferenceAsset[];
  houseStyleHint?: string;
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

  const { satellite, references = [], houseStyleHint } = options;

  const refMessages = buildReferenceMessages(references);
  const fewShotMessages = buildFewShotMessages(fewShotExamples);
  const trainingCount = fewShotExamples.filter(e => e.source === 'training').length;
  const correctionCount = fewShotExamples.filter(e => e.source === 'correction').length;
  const refsNote = references.length > 0
    ? `\n\nYou have ${references.length} product reference image(s) loaded in the conversation so you can more accurately recognize specific wreath sizes, spritzer shapes, and garland styles.`
    : '';
  const corrNote = fewShotExamples.length > 0
    ? `\n\nYou have ${trainingCount} completed-job reference(s) and ${correctionCount} human-corrected example(s) shown in the conversation history below. Completed-job references are CONFIRMED measurements from takedown — highest trust. Match their precision and coordinate style.`
    : '';
  const satelliteNote = satellite
    ? `\n\nTWO IMAGES WILL BE PROVIDED: (1) street view — front elevation. Use for the STREET-VIEW polylines (santasLines, gingerbreadLines) in streetview coordinates, bushes/trees/columns, wreaths, spritzers. (2) satellite/top-down of the same property. Use for the SATELLITE polylines (satelliteSantasLines, satelliteGingerbreadLines) in satellite image coordinates. Each polyline set lives in its OWN image's coordinate space — do not mix.${
        satellite.feetPerPixel
          ? ` Satellite feet-per-pixel scale: ${satellite.feetPerPixel.toFixed(4)} ft/px (image is top-down, no perspective). Compute satelliteSantasFootage and satelliteGingerbreadFootage by summing each polyline's pixel-distance (in the satellite image's native pixel dimensions, which is 640x640 unless otherwise noted; but your polyline coords are normalized 0-1 so multiply by 640 before applying scale) and multiplying by the scale. Round to nearest 5ft.`
          : ''
      }`
    : '';
  const styleNote = houseStyleHint
    ? `\n\nHouse style hint from user: ${houseStyleHint}. Prior training examples shown are selected to match this style where possible.`
    : '';
  const systemPrompt = SYSTEM_PROMPT + refsNote + satelliteNote + styleNote + corrNote;

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
  content.push({
    type: 'text',
    text: 'Estimate Christmas lighting measurements for this house. Polylines go on the street-view image only. Respond with JSON only.',
  });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [
      ...refMessages,
      ...fewShotMessages,
      { role: 'user', content },
    ],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  const raw = textBlock.text.trim();
  const parsed = extractJson(raw) as PhotoAnalysisResult;

  // Normalize coordinates — Claude sometimes returns 0-1000 scale. Detect and rescale.
  const normalizeLines = (lines: LineSegment[] | undefined): LineSegment[] => {
    if (!Array.isArray(lines)) return [];
    const allPoints = lines.flatMap(l => l.points ?? []);
    if (allPoints.length === 0) return [];
    const maxCoord = Math.max(...allPoints.flat());
    const scale = maxCoord > 1.5 ? 1 / 1000 : 1;
    return lines.map(l => ({
      label: l.label,
      points: (l.points ?? []).map(([x, y]) => [x * scale, y * scale] as [number, number]),
    }));
  };

  const normalizeBoxArray = <T extends { box: [number, number, number, number] }>(dets: T[] | undefined): T[] => {
    if (!Array.isArray(dets)) return [];
    const allCoords = dets.flatMap(d => d.box ?? []);
    if (allCoords.length === 0) return [];
    const maxCoord = Math.max(...allCoords);
    const scale = maxCoord > 1.5 ? 1 / 1000 : 1;
    return dets.map(d => ({
      ...d,
      box: (d.box ?? [0, 0, 0, 0]).map(v => v * scale) as [number, number, number, number],
    }));
  };

  return {
    ...parsed,
    santasLines: normalizeLines(parsed.santasLines),
    gingerbreadLines: normalizeLines(parsed.gingerbreadLines),
    satelliteSantasLines: normalizeLines(parsed.satelliteSantasLines),
    satelliteGingerbreadLines: normalizeLines(parsed.satelliteGingerbreadLines),
    satelliteSantasFootage: parsed.satelliteSantasFootage ?? 0,
    satelliteGingerbreadFootage: parsed.satelliteGingerbreadFootage ?? 0,
    preferredSource: parsed.preferredSource ?? 'street',
    miniLightDetections: normalizeBoxArray(parsed.miniLightDetections),
    wreathDetections: normalizeBoxArray(parsed.wreathDetections),
    spritzerDetections: normalizeBoxArray(parsed.spritzerDetections),
    garlandDetections: normalizeBoxArray(parsed.garlandDetections),
  };
}
