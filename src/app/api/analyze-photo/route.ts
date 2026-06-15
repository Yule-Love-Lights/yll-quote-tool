import { NextRequest, NextResponse } from 'next/server';
import { analyzePhoto } from '@/lib/photoAnalysis';
import { isClaudeConfigured } from '@/lib/claude';
import { assembleFewShot } from '@/lib/fewShot';
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
    // Unified few-shot (#8 Stage B): similarity-ranked by the incoming house
    // photo when Voyage + embeddings are available, else recency. One shared
    // assembler for both analyze routes.
    const { examples, references, breakdown } = await assembleFewShot(
      houseStyleHint,
      { base64, mediaType },
    );
    const result = await analyzePhoto(base64, mediaType, examples, {
      references,
      houseStyleHint,
    });
    return NextResponse.json({
      result,
      photoBase64: base64,
      photoMediaType: mediaType,
      fewShotCount: examples.length,
      fewShotBreakdown: breakdown,
    });
  } catch (err) {
    console.error('Photo analysis error:', err);
    const message = err instanceof Error ? err.message : 'Failed to analyze photo';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
