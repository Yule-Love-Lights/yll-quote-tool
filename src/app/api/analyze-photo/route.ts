import { NextRequest, NextResponse } from 'next/server';
import { isClaudeConfigured } from '@/lib/claude';
import { rateLimitResponse } from '@/lib/rateLimit';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { runAnalyzeWithFewShot } from '@/lib/analyzeWithFewShot';
import { analyzePermanentPhoto } from '@/lib/permanent/photoAnalysis';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
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
  // #54: /training/new sends mode=completed so the analyzer RECORDS the finished
  // install instead of re-designing a bare house. Everything else defaults to design.
  const mode = formData.get('mode') === 'completed' ? 'completed' : 'design';

  const arrayBuffer = await file.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  // #88: a permanent quote runs the PERMANENT analyzer (roofline gutter line on
  // all sides, no ridges/peaks, gap detection), not the holiday one. A manual
  // upload has no satellite, so only the front is reliably measured; the operator
  // enters left/right/back off the satellite tab. FAIL-SAFE mirrors below.
  if (formData.get('serviceType') === 'permanent') {
    let permanentResult = null;
    let permanentError: string | undefined;
    try {
      permanentResult = await analyzePermanentPhoto(base64, mediaType);
    } catch (err) {
      console.error('[api/analyze-photo] permanent analysis failed:', err);
      permanentError = 'The permanent auto-measure is temporarily unavailable. Your photo is loaded; measure the roofline manually.';
    }
    return NextResponse.json({
      result: null,
      permanentResult,
      permanentImageryOnly: permanentResult == null,
      analysisError: permanentError,
      photoBase64: base64,
      photoMediaType: mediaType,
    });
  }

  // FAIL-SAFE (analyzer outage): if Claude is down we still return the uploaded
  // photo with result: null so the client loads it for manual design — the staff
  // already have this image, and a Claude outage must not block them.
  // Unified few-shot (#8 Stage B): similarity-ranked by the incoming house photo
  // when Voyage + embeddings are available, else recency.
  // #110 W5-014: shared with analyze-address/route.ts via runAnalyzeWithFewShot.
  const { result, analysisUnavailable, analysisError, fewShotCount, fewShotBreakdown } =
    await runAnalyzeWithFewShot(base64, mediaType, houseStyleHint, { mode }, '[api/analyze-photo]');

  return NextResponse.json({
    result,
    analysisUnavailable,
    analysisError,
    photoBase64: base64,
    photoMediaType: mediaType,
    fewShotCount,
    fewShotBreakdown,
  });
}
