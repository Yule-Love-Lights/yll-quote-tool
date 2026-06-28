import { NextRequest, NextResponse } from 'next/server';
import { analyzePhoto, ANALYZER_UNAVAILABLE_MESSAGE } from '@/lib/photoAnalysis';
import { isClaudeConfigured } from '@/lib/claude';
import { assembleFewShot } from '@/lib/fewShot';
import { rateLimitResponse } from '@/lib/rateLimit';
import { requireOperator } from '@/lib/auth/supabaseServer';

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

  const arrayBuffer = await file.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  // FAIL-SAFE (analyzer outage): if Claude is down we still return the uploaded
  // photo with result: null so the client loads it for manual design — the staff
  // already have this image, and a Claude outage must not block them.
  // Unified few-shot (#8 Stage B): similarity-ranked by the incoming house photo
  // when Voyage + embeddings are available, else recency.
  let result: Awaited<ReturnType<typeof analyzePhoto>> | null = null;
  let analysisError: string | undefined;
  let fewShotCount = 0;
  let fewShotBreakdown: { ranking?: 'similarity' | 'recency' } | undefined;
  try {
    const { examples, references, biasNote, breakdown } = await assembleFewShot(
      houseStyleHint,
      { base64, mediaType },
    );
    result = await analyzePhoto(base64, mediaType, examples, {
      references,
      houseStyleHint,
      corpusBiasNote: biasNote,
    });
    fewShotCount = examples.length;
    fewShotBreakdown = breakdown;
  } catch (err) {
    console.error('analyze-photo: AI analysis failed — returning photo for manual design:', err);
    analysisError = ANALYZER_UNAVAILABLE_MESSAGE;
  }

  return NextResponse.json({
    result,
    analysisUnavailable: result === null,
    analysisError,
    photoBase64: base64,
    photoMediaType: mediaType,
    fewShotCount,
    fewShotBreakdown,
  });
}
