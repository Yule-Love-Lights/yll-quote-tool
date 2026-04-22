import { getClaudeClient } from './claude';

export type PhotoAnalysisResult = {
  santasFootage: number;
  santasDifficulty: 'easy' | 'medium' | 'hard';
  gingerbreadFootage: number;
  gingerbreadDifficulty: 'easy' | 'medium' | 'hard';
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

You MUST respond with ONLY valid JSON matching this schema. No markdown fences, no prose before or after:
{
  "santasFootage": number,
  "santasDifficulty": "easy" | "medium" | "hard",
  "gingerbreadFootage": number,
  "gingerbreadDifficulty": "easy" | "medium" | "hard",
  "notes": "1-2 sentences on what you saw and any caveats (e.g. 'only front visible, estimated back from typical cape layout')",
  "confidence": "low" | "medium" | "high"
}

Round footage to the nearest 5 feet. If a photo is too poor to estimate, use confidence "low" and give conservative mid-range estimates.`;

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
  return parsed;
}
