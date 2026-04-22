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

export type PhotoAnalysisResult = {
  santasFootage: number;
  santasDifficulty: 'easy' | 'medium' | 'hard';
  santasLines: LineSegment[];
  gingerbreadFootage: number;
  gingerbreadDifficulty: 'easy' | 'medium' | 'hard';
  gingerbreadLines: LineSegment[];
  miniLightDetections: MiniLightDetection[];
  wreathDetections: WreathDetection[];
  spritzerDetections: SpritzerDetection[];
  notes: string;
  confidence: 'low' | 'medium' | 'high';
};

const SYSTEM_PROMPT = `You are a holiday lighting estimator for Yule Love Lights, a Long Island NY Christmas lighting company. You analyze photos of houses to estimate roofline lighting measurements.

PACKAGES:
- Santa's Roofline (gutterline): lights run along the front gutters/eaves — the bottom edge of the roof visible from the street. Measure the total linear footage.
- Gingerbread Ridge (ridgeline): lights run along the peak/ridge of the roof. Measure the total linear footage across all visible ridge lines.

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

WREATH DETECTION — identify every wreath visible on the house (front door, garage doors, windows). Estimate size based on context: a standard front door is about 80in tall, so a wreath covering ~30-35in of that height is a 30" wreath; ~40in is a 36"; ~48in is a 48". Garage doors commonly get 24" or 30" wreaths. Sizes available: "24noble", "30noble", "36noble", "48noble", "36oregon" (Oregon = a wider fuller pine). Default to "30noble" if you cannot tell.

WREATH TIER — "labor" = plain hanging, "bow" = wreath with a bow, "fullDecor" = heavy ornament/berry/ribbon decoration. Default to "bow" if uncertain.

Return each wreath as a bounding box in normalized 0-1 coords plus size + tier.

SPRITZER DETECTION — identify spritzers: decorative outdoor metallic star/snowflake/starburst figures on stakes (not rope lights or projectors). They appear as shiny 3D metallic ornaments placed in garden beds, along walkways, or near the entrance. Sizes: "16" (small, ~16in), "24" (medium, common), "32" (large). Default to "24" if uncertain. Only include items actually visible as distinct placed decorations — do NOT flag distant blurs or items in the background. Return each as a bounding box plus size label.

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
  "miniLightDetections": [
    { "type": "bush" | "tree" | "column", "wrapStyle": "canopy" | "trunk", "stringCount": number, "box": [x, y, w, h], "label": "foundation bush ~3ft" }
  ],
  "wreathDetections": [
    { "size": "24noble" | "30noble" | "36noble" | "48noble" | "36oregon", "tier": "labor" | "bow" | "fullDecor", "box": [x, y, w, h], "label": "front door wreath ~30in" }
  ],
  "spritzerDetections": [
    { "size": "16" | "24" | "32", "box": [x, y, w, h], "label": "metallic star spritzer 24in" }
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
  miniLightDetections: MiniLightDetection[];
  wreathDetections: WreathDetection[];
  spritzerDetections: SpritzerDetection[];
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
    miniLightDetections: c.corrected_mini_light_detections ?? [],
    wreathDetections: [],
    spritzerDetections: [],
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
      miniLightDetections: ex.miniLightDetections,
      wreathDetections: ex.wreathDetections ?? [],
      spritzerDetections: ex.spritzerDetections ?? [],
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
    ? `\n\nTWO IMAGES WILL BE PROVIDED: (1) street view — front elevation, use for gutterline, ridgeline polylines, bushes/trees/columns. (2) satellite/top-down — use for cross-checking total roof footprint and identifying roof complexity. All polyline coordinates MUST be in the STREET VIEW image's coordinate space. Do NOT place polylines on the satellite image.`
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
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Claude returned non-JSON response: ${raw.slice(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]) as PhotoAnalysisResult;

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
    miniLightDetections: normalizeBoxArray(parsed.miniLightDetections),
    wreathDetections: normalizeBoxArray(parsed.wreathDetections),
    spritzerDetections: normalizeBoxArray(parsed.spritzerDetections),
  };
}
