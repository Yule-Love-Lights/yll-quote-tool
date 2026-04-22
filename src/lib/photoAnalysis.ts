import { getClaudeClient } from './claude';

export type LineSegment = {
  points: [number, number][]; // normalized 0-1 coords: [[x1,y1], [x2,y2], ...]
  label: string;               // e.g. "front gutter ~40ft"
};

export type PhotoAnalysisResult = {
  santasFootage: number;
  santasDifficulty: 'easy' | 'medium' | 'hard';
  santasLines: LineSegment[];
  gingerbreadFootage: number;
  gingerbreadDifficulty: 'easy' | 'medium' | 'hard';
  gingerbreadLines: LineSegment[];
  notes: string;
  confidence: 'low' | 'medium' | 'high';
};

const SYSTEM_PROMPT = `You are a holiday lighting estimator for Yule Love Lights, a Long Island NY Christmas lighting company. You analyze photos of houses to estimate roofline lighting measurements.

PACKAGES:
- Santa's Roofline (gutterline): lights run along the front gutters/eaves — the bottom edge of the roof visible from the street. Measure the total linear footage.
- Gingerbread Ridge (ridgeline): lights run along the peak/ridge of the roof. Measure the total linear footage across all visible ridge lines.

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
  "notes": "1-2 sentences on what you saw and any caveats",
  "confidence": "low" | "medium" | "high"
}

Round footage to the nearest 5 feet. Coordinates should be precise — trace right along the visible edge. If a photo is too poor, use confidence "low" and return empty line arrays.`;

export async function analyzePhoto(base64Image: string, mediaType: string): Promise<PhotoAnalysisResult> {
  const client = getClaudeClient();
  if (!client) {
    throw new Error('Claude API not configured — set ANTHROPIC_API_KEY in .env.local');
  }

  const validMediaTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
  if (!validMediaTypes.includes(mediaType as typeof validMediaTypes[number])) {
    throw new Error(`Unsupported image type: ${mediaType}`);
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType as typeof validMediaTypes[number],
              data: base64Image,
            },
          },
          {
            type: 'text',
            text: 'Estimate Christmas lighting measurements for this house. Respond with JSON only.',
          },
        ],
      },
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

  return {
    ...parsed,
    santasLines: normalizeLines(parsed.santasLines),
    gingerbreadLines: normalizeLines(parsed.gingerbreadLines),
  };
}
