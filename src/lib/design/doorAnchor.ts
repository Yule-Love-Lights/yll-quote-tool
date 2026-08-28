// SHADOW MODE (door-anchor scale): pure prompt-building + parsing + math for
// deriving a feet-per-pixel scale from a vision model locating the front
// door or garage door in a house's STREET photo — a candidate alternative to
// the staff-placed yardstick (measured unreliable: one address yardsticked
// twice disagreed by 72%, and the training corpus carries mostly-untouched
// realFeet=5 defaults). Same pure/no-I/O house style as polylineFootage.ts
// and yardstickPpf.ts: no network, no Supabase, nothing here can throw on a
// well-typed input, degenerate inputs return null rather than a guess.
//
// APPROVED SCOPE: SHADOW MODE ONLY. Nothing here is consumed by pricing,
// projection, or the analyzer's own street/satellite detections — see the
// PhotoAnalysisResult type comment in photoAnalysis.ts, which is the only
// place this module's output is wired in (the live vision call + failure
// isolation + timeout live there, not here).
//
// METHOD: adapted verbatim from the door-anchor-experiment spike (PR #922,
// scripts/spikes/door-anchor-experiment.ts) — the model is asked ONLY for
// pixel coordinates + an object identity; the feet-per-pixel conversion
// happens in CODE against a standardized real-world size table, never in the
// model's head (the spike's own framing: "the model is good at locating a
// door in a photo and bad at estimating real-world distance"). Measured on
// 78 live vision calls (26 photos x 3 runs each, claude-sonnet-4-6): every
// call resolved to front_door or garage_door (0 window/step_riser/
// brick_course/none), 4.0% mean / 11.3% max run-to-run ppf noise at the row
// level (5.5% mean / 12.7% max deduplicated to distinct addresses) — a large
// improvement over the yardstick's demonstrated 72% swing, but NOT yet
// checked against ground-truth measurements. See the spike's
// DOOR_ANCHOR_RESULTS.md for the full numbers and caveats.
//
// SCOPE NARROWED FROM THE SPIKE: the spike could also anchor off a single
// step_riser or brick_course when no door was visible (its own fallback
// preference order). In the live 26-photo corpus that fallback never fired
// (78/78 calls picked front_door or garage_door), and this shadow field's
// source type only distinguishes the two door kinds — so a step_riser or
// brick_course reading here still validates (it's a defined "say so, don't
// guess" outcome for the model, same as "window"/"none") but yields a null
// scale rather than a computed one. Low-risk given the corpus never relied
// on it, but a real behavior narrowing worth naming plainly (see the PR body).

export type DoorAnchorObject =
  | 'front_door'
  | 'garage_door'
  | 'window'
  | 'step_riser'
  | 'brick_course'
  | 'none';
export type GarageDoorWidth = 'single' | 'double' | null;

// Matches PhotoAnalysisResult['doorAnchorSource'] in photoAnalysis.ts.
export type DoorAnchorSource = 'front-door' | 'garage-door';

export type DoorAnchorModelResult = {
  object: DoorAnchorObject;
  garageDoorWidth: GarageDoorWidth;
  bbox: readonly [number, number, number, number]; // [x, y, w, h] in the SENT image's own pixel space (see buildDoorAnchorPrompt's {W}x{H})
  confidence: number; // 0-1, the model's own certainty its bbox tightly/correctly bounds the named object
};

// Standard real-world sizes (inches) — the exact table from the spike.
const STANDARD_SIZES_IN = {
  frontDoorHeight: 80,
  garageDoorSingleWidth: 108,
  garageDoorDoubleWidth: 192,
} as const;

// Byte-identical wording to the spike's PROMPT constant (door-anchor-experiment.ts),
// down to the object preference order and the bbox-span instructions — this is
// the exact method the measured numbers above are evidence for.
const DOOR_ANCHOR_PROMPT_TEMPLATE = `You are measuring a residential US front-elevation street photo. This image is {W}x{H} pixels, origin (0,0) at the top-left, x increasing right, y increasing down.

Identify ONE object in the photo that has a well-known, STANDARDIZED real-world size, to use as a scale reference. Preference order: front entry door > garage door > exterior brick coursing (one course + one mortar joint) > a single concrete/wood step riser (one step's rise, not the whole staircase). If none of these are clearly visible, or you are not confident which pixels belong to the object, say so — do not guess.

Do NOT estimate feet or inches. Report ONLY what you can see: which object, and its PIXEL location in THIS image. The bounding box:
- front_door: must span the visible door leaf top-to-bottom (head to sill/threshold), not the surrounding trim or a storm door if that reads as a separate frame.
- garage_door: must span the whole door LEFT to RIGHT (its full width). Also report whether it is a single-car or double-car door.
- brick_course: must span exactly ONE brick course including one mortar joint, top to bottom.
- step_riser: must span exactly ONE step's rise (the vertical face of one step), not the full staircase.

Respond with JSON only, no prose, matching exactly this shape:
{"object":"front_door"|"garage_door"|"window"|"step_riser"|"brick_course"|"none","garageDoorWidth":"single"|"double"|null,"bbox":[x,y,width,height],"confidence":0.0}

"window" and "none" mean no standardized-size anchor was usable in this photo. bbox is [0,0,0,0] when object is "none". confidence is 0-1, your own certainty the bbox tightly and correctly bounds the named object.`;

export function buildDoorAnchorPrompt(widthPx: number, heightPx: number): string {
  return DOOR_ANCHOR_PROMPT_TEMPLATE.replace('{W}', String(widthPx)).replace('{H}', String(heightPx));
}

const DOOR_ANCHOR_OBJECTS: readonly DoorAnchorObject[] = [
  'front_door', 'garage_door', 'window', 'step_riser', 'brick_course', 'none',
];

// Schema validation of the model's raw parsed JSON — mirrors the spike's
// isValidModelAnchorResult exactly. Anything off-shape (wrong enum, missing
// field, non-finite bbox number, a non-finite confidence) fails closed.
export function isValidDoorAnchorModelResult(v: unknown): v is DoorAnchorModelResult {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.object !== 'string' || !DOOR_ANCHOR_OBJECTS.includes(o.object as DoorAnchorObject)) return false;
  if (o.garageDoorWidth !== 'single' && o.garageDoorWidth !== 'double' && o.garageDoorWidth !== null) return false;
  if (!Array.isArray(o.bbox) || o.bbox.length !== 4 || !o.bbox.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence)) return false;
  return true;
}

export type DoorAnchorScale = {
  ftPerPx: number; // feet-per-pixel, in the SAME image pixel space as the model's bbox (see r.bbox's own comment) — matches this codebase's SatelliteReference.feetPerPixel convention (feet/px, not the spike's px/ft)
  source: DoorAnchorSource;
  confidence: number;
};

/**
 * Pure: a validated model result -> a shadow scale, or null when no
 * standardized-size conversion applies. Never throws.
 *
 * Degenerate/excluded cases, every one documented:
 *  - object is "window" | "step_riser" | "brick_course" | "none" -> null
 *    (no source type for these — see the module comment's scope narrowing)
 *  - object is "front_door" but bbox height <= 0                 -> null
 *  - object is "garage_door" but bbox width <= 0                 -> null
 *  - object is "garage_door" but garageDoorWidth is null          -> null
 *    (ambiguous single/double — no standard size to anchor to, matches the spike)
 */
export function doorAnchorScaleFromModelResult(r: DoorAnchorModelResult): DoorAnchorScale | null {
  const [, , w, h] = r.bbox;
  if (r.object === 'front_door') {
    if (!(h > 0)) return null;
    return { ftPerPx: (STANDARD_SIZES_IN.frontDoorHeight / 12) / h, source: 'front-door', confidence: r.confidence };
  }
  if (r.object === 'garage_door') {
    if (!(w > 0)) return null;
    if (r.garageDoorWidth === 'single') {
      return { ftPerPx: (STANDARD_SIZES_IN.garageDoorSingleWidth / 12) / w, source: 'garage-door', confidence: r.confidence };
    }
    if (r.garageDoorWidth === 'double') {
      return { ftPerPx: (STANDARD_SIZES_IN.garageDoorDoubleWidth / 12) / w, source: 'garage-door', confidence: r.confidence };
    }
    return null; // ambiguous width
  }
  return null; // window / step_riser / brick_course / none
}

/**
 * A door-anchor ftPerPx is only meaningful in the pixel space of the exact
 * image bytes the model saw (`sentWidthPx`). The design editor's yardstick
 * and traced scene items live in the ORIGINAL uploaded photo's pixel space
 * (see yardstickPpf.ts) — when the image sent to the model was downscaled
 * first (downscaleImageForVision, a cost/quality guard for large uploads),
 * this rescales into that same original space so a later comparison
 * (scripts/door-anchor-report.ts) is comparing like-for-like pixel grids,
 * not two different ones. Derivation: a real-world extent spans fewer
 * pixels in a smaller (downscaled) image, so ftPerPx measured there is
 * proportionally SMALLER than ftPerPx in the larger original — scaling by
 * (sentWidthPx / originalWidthPx) corrects for that. Assumes the downscale
 * preserved aspect ratio (true for downscaleImageForVision's `fit: 'inside'`
 * resize — no cropping), so a single width-based factor is exact for both axes.
 *
 * No-op (returns the input unchanged) when either width is not a real
 * positive number, or the two widths already match (no downscale happened) —
 * never throws, never returns NaN/Infinity.
 */
export function rescaleFtPerPxToOriginal(
  ftPerPxInSentSpace: number,
  sentWidthPx: number,
  originalWidthPx: number,
): number {
  if (!(sentWidthPx > 0) || !(originalWidthPx > 0)) return ftPerPxInSentSpace;
  return ftPerPxInSentSpace * (sentWidthPx / originalWidthPx);
}
