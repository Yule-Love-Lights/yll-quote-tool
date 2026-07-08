// Permanent Lighting #140 (P2+P3) — the permanent-specific analyzer.
//
// SATELLITE: traces the house's gutter-line roof perimeter on the top-down
// image as FOUR side channels (front/left/right/back) — the same editable
// channels the operator draws by hand (QuoteBuilder.permanentSatLines) — so
// everything downstream (footage/corners via deriveSideMeasure, the
// Extensions/Splitters counts via trackAccessories, portal persistence) flows
// from the DRAWN, OPERATOR-EDITABLE lines. Numbers never bypass the geometry:
// that trust model is why the previous analyzer was removed (S22).
//
// STREET (P3): traces the visible permanent runs on the street photo (gutter +
// gable rakes, tagged front/left/right) — seeded as editable bulbType:
// 'permanent' strands, VISUAL/portal only. And detects JUMPS between separated
// runs (measured ft + the splitter branch flag) — what pure geometry can't see
// — which seed the Extensions/Splitters card as `extras`.
//
// The street photo also anchors the satellite orientation cross-check (which
// edge faces the road = front) — the #1 satellite failure mode, inherited from
// the holiday analyzer's self-check.

import { getClaudeClient } from '@/lib/claude';
import { extractJson, normalizeLines, type LineSegment } from '@/lib/photoAnalysis';

export type PermanentSatelliteLines = {
  front: LineSegment[];
  left: LineSegment[];
  right: LineSegment[];
  back: LineSegment[];
};

// #140 P3: a track run traced on the STREET photo, tagged with its house side
// (back never shows from the street). Street-photo coordinate space.
export type PermanentStreetRun = {
  side: 'front' | 'left' | 'right';
  points: [number, number][];
  label: string;
};

// #140 P3: a detected JUMP — a physical break separated runs must bridge with
// extensions (garage↔house, porch↔upper story). `splitter` marks the Jason
// branch rule: the line splits two directions/levels at this connection.
export type PermanentJump = {
  ft: number;
  splitter: boolean;
  label: string;
};

export type PermanentSatelliteAnalysis = {
  satelliteLines: PermanentSatelliteLines;
  streetRuns: PermanentStreetRun[];
  jumps: PermanentJump[];
  notes: string;
  confidence: 'low' | 'medium' | 'high';
};

// Static system prompt — byte-identical across calls so it caches (the W5-012
// pattern). Permanent-specific: FULL perimeter (all four sides, unlike
// holiday's front-section rule), gutter line only, no ridges.
const PERMANENT_SATELLITE_PROMPT = `You are a professional permanent-lighting estimator analyzing a TOP-DOWN SATELLITE image of a residential property. Permanent track lighting mounts along the GUTTER LINE (roof eave) of the house — the OUTER PERIMETER edges of the roof as seen from above.

YOUR TASK: trace the house's roof perimeter as polylines, split into the four sides of the house:
- "front" — the side whose plane faces the ROAD the house is addressed on.
- "left" / "right" — as seen FROM THE ROAD looking at the front of the house.
- "back" — the side facing away from the road.

TRACING RULES:
1. Trace along the OUTER roof edge (the eave/gutter line as projected top-down). Follow it faithfully: place a vertex at EVERY corner where the edge changes direction — corners drive both the corner-light count and the track-cut count, so do not smooth them away.
2. FULL PERIMETER: unlike holiday lighting, permanent covers all four sides. Trace every side that is clearly visible.
3. NEVER trace ridges (the interior lines where roof planes meet) — only the outer perimeter.
4. Where the roofline PHYSICALLY BREAKS on one side (a recessed garage jog, a covered breezeway, a separate roof mass), END the current polyline and START A NEW ONE in the same side's array — do NOT draw across the break. The gap between runs is measured downstream.
5. The MAIN HOUSE only: include attached garages; EXCLUDE detached garages, sheds, pool houses, and the neighbors' roofs.
6. Do NOT trace driveways, walkways, fences, hedges, tree canopies, or shadows. If a side is hidden under trees or unclear, return an EMPTY array for that side and say so in notes.

ORIENTATION SELF-CHECK (do this BEFORE finalizing): find the road in the satellite image and, when a street-view photo is provided, CONFIRM against it which edge is the front. If your front assignment would put "front" on an edge the street photo clearly shows is a side, they are wrong — fix them before answering. Left/right are from the ROAD's point of view (the road-viewer's left hand = "left").

STREET RUNS (only when a street-view photo is provided): ALSO trace the permanent track runs ON THE STREET PHOTO as "streetRuns" — these become the customer's visual preview:
- Follow the gutter/eave line AND go UP AND OVER front-facing gable peaks (rake edges) — permanent track runs up the rakes; NEVER trace ridges.
- Vertex at EVERY direction change (gutter→rake transition, apex, rake→gutter, wall corner).
- Tag each run's side: "front", "left", or "right" (the back never shows from the street).
- Where the roofline PHYSICALLY BREAKS (a lower porch roof vs the upper story, a garage jog), END the polyline and start a NEW run — never draw across the break.

JUMPS + SPLITTERS: report every place SEPARATED runs must be wired together as "jumps":
- A jump = the wire bridge between two runs that do not touch (a lower porch roof up to the second-story roof, the house across to an attached garage's separate roof mass, around a deep recess).
- "ft": best estimate of the wiring distance in FEET — use the satellite scale where the jump is visible top-down; else estimate from the street photo using cues (front door ≈ 7 ft tall, one story ≈ 10 ft).
- "splitter": true when the line BRANCHES at this connection — it continues in one direction AND feeds a second direction or another LEVEL (e.g. a run's end feeding both an upper-story run and a continuing lower run). A simple end-to-end continuation is false.
- Do NOT report the small cuts at corners/peaks WITHIN a traced run — those are counted from the drawn geometry downstream. Only bridges between SEPARATE runs.

COORDINATES: satellite polyline points are normalized 0-1 relative to the SATELLITE image; street-run points are normalized 0-1 relative to the STREET photo (x = left→right, y = top→bottom in both). Never mix the two spaces.

Respond with JSON ONLY, exactly this shape:
{
  "front": [{ "points": [[x,y],[x,y],...], "label": "front eave ~42ft" }],
  "left":  [{ "points": [[x,y],...], "label": "left eave ~30ft" }],
  "right": [{ "points": [[x,y],...], "label": "right eave ~30ft" }],
  "back":  [{ "points": [[x,y],...], "label": "back eave ~40ft" }],
  "streetRuns": [{ "side": "front" | "left" | "right", "points": [[x,y],...], "label": "front gutter + gable" }],
  "jumps": [{ "ft": 12, "splitter": true, "label": "porch roof up to second story, branches toward garage" }],
  "notes": "1-2 sentences: what was unclear, sides skipped and why",
  "confidence": "low" | "medium" | "high"
}`;

const SIDES = ['front', 'left', 'right', 'back'] as const;
const STREET_SIDES = new Set(['front', 'left', 'right']);
const MAX_JUMP_FT = 200; // sanity cap on a hallucinated distance

/** Coerce the raw model JSON into the typed result (exported for tests). */
export function normalizePermanentSatelliteResult(parsed: unknown): PermanentSatelliteAnalysis {
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const satelliteLines = {} as PermanentSatelliteLines;
  for (const side of SIDES) {
    satelliteLines[side] = normalizeLines(obj[side] as LineSegment[] | undefined);
  }
  // #140 P3: street runs — normalize each run's points individually (they share
  // the LineSegment shape) and keep only street-visible side tags.
  const streetRuns: PermanentStreetRun[] = [];
  if (Array.isArray(obj.streetRuns)) {
    for (const raw of obj.streetRuns as Array<Record<string, unknown>>) {
      if (!raw || !STREET_SIDES.has(raw.side as string)) continue;
      const [line] = normalizeLines([
        { points: raw.points as [number, number][], label: typeof raw.label === 'string' ? raw.label : '' },
      ]);
      if (line && line.points.length >= 2) {
        streetRuns.push({
          side: raw.side as PermanentStreetRun['side'],
          points: line.points,
          label: line.label ?? '',
        });
      }
    }
  }
  // #140 P3: jumps — finite positive feet only, capped; splitter coerced.
  const jumps: PermanentJump[] = [];
  if (Array.isArray(obj.jumps)) {
    for (const raw of obj.jumps as Array<Record<string, unknown>>) {
      const ft = typeof raw?.ft === 'number' && Number.isFinite(raw.ft) ? raw.ft : 0;
      if (ft <= 0 || ft > MAX_JUMP_FT) continue;
      jumps.push({
        ft,
        splitter: raw.splitter === true,
        label: typeof raw.label === 'string' ? raw.label.slice(0, 200) : '',
      });
    }
  }
  const conf = obj.confidence;
  return {
    satelliteLines,
    streetRuns: streetRuns.slice(0, 40),
    jumps: jumps.slice(0, 40),
    notes: typeof obj.notes === 'string' ? obj.notes.slice(0, 500) : '',
    confidence: conf === 'high' || conf === 'medium' ? conf : 'low',
  };
}

export async function analyzePermanentSatellite(args: {
  satelliteBase64: string;
  satelliteMediaType: 'image/jpeg' | 'image/png';
  /** Street photo for the front-orientation cross-check (optional but strongly recommended). */
  streetBase64?: string;
  streetMediaType?: 'image/jpeg' | 'image/png';
  feetPerPixel?: number | null;
}): Promise<PermanentSatelliteAnalysis> {
  const client = getClaudeClient();
  if (!client) {
    throw new Error('Claude API not configured — set ANTHROPIC_API_KEY in .env.local');
  }

  const content: Array<
    | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png'; data: string } }
    | { type: 'text'; text: string }
  > = [
    { type: 'text', text: 'Image 1: satellite top-down of the property.' },
    {
      type: 'image',
      source: { type: 'base64', media_type: args.satelliteMediaType, data: args.satelliteBase64 },
    },
  ];
  if (args.streetBase64 && args.streetMediaType) {
    content.push({ type: 'text', text: 'Image 2: street view of the SAME property — use it ONLY for the front-orientation cross-check.' });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: args.streetMediaType, data: args.streetBase64 },
    });
  }
  const scaleNote =
    args.feetPerPixel && args.feetPerPixel > 0
      ? ` Satellite scale: ${args.feetPerPixel.toFixed(4)} ft/px on the 640×640 image — use it to sanity-check your run labels' footage estimates.`
      : '';
  content.push({
    type: 'text',
    text: `Trace the permanent-lighting roof perimeter for this house as the four side channels.${scaleNote} Respond with JSON only.`,
  });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [{ type: 'text', text: PERMANENT_SATELLITE_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
  });

  if (response.stop_reason === 'max_tokens') {
    console.warn('[analyzePermanentSatellite] response truncated at max_tokens — JSON may be incomplete');
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude');
  }
  return normalizePermanentSatelliteResult(extractJson(textBlock.text.trim()));
}
