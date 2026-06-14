import { NextRequest, NextResponse } from 'next/server';
import { analyzePhoto, correctionToExample, FewShotExample } from '@/lib/photoAnalysis';
import { isClaudeConfigured } from '@/lib/claude';
import { getRecentCorrections } from '@/lib/corrections';
import { getRecentTrainingExamples, exampleToFewShot } from '@/lib/trainingExamples';
import { getTrainingFewShot } from '@/lib/training';
import { getReferenceAssetsForAnalysis } from '@/lib/referenceAssets';
import { rateLimitResponse } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export async function POST(req: NextRequest) {
  // Each call hits Anthropic vision — cap at 20/min/IP as a budget guardrail.
  const blocked = rateLimitResponse(req, { bucket: 'analyze-photo', limit: 20, windowMs: 60_000 });
  if (blocked) return blocked;

  if (!isClaudeConfigured()) {
    return NextResponse.json(
      { error: 'Photo analysis not configured — ANTHROPIC_API_KEY missing' },
      { status: 503 },
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const file = formData.get('photo');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No photo uploaded (field name must be "photo")' }, { status: 400 });
  }

  if (file.size > MAX_SIZE_BYTES) {
    return NextResponse.json({ error: 'Photo too large — max 10MB' }, { status: 400 });
  }

  const mediaType = file.type;
  if (!mediaType.startsWith('image/')) {
    return NextResponse.json({ error: 'File must be an image' }, { status: 400 });
  }

  const houseStyleHint = (formData.get('houseStyle') as string | null)?.trim() || undefined;

  const arrayBuffer = await file.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  try {
    const [sceneExamples, corrections, trainingHouses, references] = await Promise.all([
      getRecentTrainingExamples(2),
      getRecentCorrections(2),
      getTrainingFewShot(2, houseStyleHint),
      getReferenceAssetsForAnalysis(2),
    ]);
    // Scene-based examples (#8 Stage A) take the correction slots first;
    // legacy photo_corrections only fill what's left (they sunset at the
    // planned data wipe).
    const designFewShots = sceneExamples
      .map(exampleToFewShot)
      .filter((e): e is NonNullable<typeof e> => e != null);
    const correctionFill = corrections
      .slice(0, Math.max(0, 2 - designFewShots.length))
      .map(correctionToExample);
    const examples: FewShotExample[] = [
      // Training first (highest trust) so the model weights them as the template
      ...trainingHouses
        .filter(h => h.photos?.length && h.santas_footage != null && h.gingerbread_footage != null)
        .map(h => {
          // Include up to 4 photos per training house: front_install + alt angles/details.
          // Front install always first so the model anchors on the primary reference frame.
          const ordered = [...h.photos].sort((a, b) => {
            const order: Record<string, number> = {
              front_install: 0, front_takedown: 1, side: 2, detail: 3, back: 4, satellite: 5, other: 6,
            };
            return (order[a.tag] ?? 9) - (order[b.tag] ?? 9);
          }).slice(0, 4);
          return {
            photos: ordered.map(p => ({
              base64: p.base64,
              mediaType: p.mediaType,
              tag: p.tag,
              caption: p.caption,
            })),
            santasFootage: h.santas_footage!,
            santasDifficulty: h.santas_difficulty ?? 'medium',
            santasLines: h.santas_lines ?? [],
            gingerbreadFootage: h.gingerbread_footage!,
            gingerbreadDifficulty: h.gingerbread_difficulty ?? 'medium',
            gingerbreadLines: h.gingerbread_lines ?? [],
            miniLightDetections: h.mini_light_detections ?? [],
            wreathDetections: h.wreath_detections ?? [],
            spritzerDetections: h.spritzer_detections ?? [],
            garlandDetections: h.garland_detections ?? [],
            houseStyle: h.house_style ?? undefined,
            aiFailureNotes: h.ai_failure_notes,
            source: 'training' as const,
          };
        }),
      ...designFewShots,
      ...correctionFill,
    ];
    const result = await analyzePhoto(base64, mediaType, examples, {
      references,
      houseStyleHint,
    });
    return NextResponse.json({
      result,
      photoBase64: base64,
      photoMediaType: mediaType,
      fewShotCount: examples.length,
      fewShotBreakdown: {
        training: trainingHouses.length,
        examples: designFewShots.length,
        corrections: correctionFill.length,
        references: references.length,
      },
    });
  } catch (err) {
    console.error('Photo analysis error:', err);
    const message = err instanceof Error ? err.message : 'Failed to analyze photo';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
