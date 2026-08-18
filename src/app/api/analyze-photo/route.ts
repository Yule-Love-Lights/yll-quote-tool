import { NextRequest, NextResponse } from 'next/server';
import { isClaudeConfigured } from '@/lib/claude';
import { rateLimitResponse } from '@/lib/rateLimit';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { runAnalyzeWithFewShot } from '@/lib/analyzeWithFewShot';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

// Mirrors analyzePhoto()'s validMediaTypes allowlist in photoAnalysis.ts. Checked
// here too, before the analyzer call, so an unsupported format (HEIC/AVIF/BMP/
// TIFF/etc) gets a clear 400 instead of falling into the outage fail-safe —
// analyzePhoto() throws "Unsupported image type", which runAnalyzeWithFewShot
// swallows into the generic "temporarily unavailable" message.
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

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
  if (!SUPPORTED_IMAGE_TYPES.includes(mediaType)) {
    return NextResponse.json(
      { error: 'Unsupported image format — convert to JPEG, PNG, GIF, or WEBP and try again' },
      { status: 400 },
    );
  }

  const houseStyleHint = (formData.get('houseStyle') as string | null)?.trim() || undefined;
  // #54: /training/new sends mode=completed so the analyzer RECORDS the finished
  // install instead of re-designing a bare house. Everything else defaults to design.
  const mode = formData.get('mode') === 'completed' ? 'completed' : 'design';

  const arrayBuffer = await file.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  // FAIL-SAFE (analyzer outage): if Claude is down we still return the uploaded
  // photo with result: null so the client loads it for manual design — the staff
  // already have this image, and a Claude outage must not block them.
  // Unified few-shot (#8 Stage B): similarity-ranked by the incoming house photo
  // when Voyage + embeddings are available, else recency.
  // #110 W5-014: shared with analyze-address/route.ts via runAnalyzeWithFewShot.
  const { result, analysisUnavailable, analysisError, fewShotCount, fewShotBreakdown } =
    await runAnalyzeWithFewShot(base64, mediaType, houseStyleHint, { mode }, '[api/analyze-photo]');

  // #190: this route only ever shows the model a STREET photo — no satellite
  // image is passed to analyzePhoto (see the `{ mode }` options above, vs.
  // analyze-address's `satellite: {...}`) — yet the model's output schema
  // always asks for satelliteSantasLines/satelliteGingerbreadLines and can
  // hallucinate coordinates for a satellite it never saw. Strip them here as
  // a server-side belt to the client-side guard in QuoteBuilder's
  // applyAnalysisResult (analysisSatellitePayload.ts): a street-only result
  // must never carry satellite lines, hallucinated or otherwise.
  const sanitizedResult = result
    ? { ...result, satelliteSantasLines: [], satelliteGingerbreadLines: [] }
    : result;

  return NextResponse.json({
    result: sanitizedResult,
    analysisUnavailable,
    analysisError,
    photoBase64: base64,
    photoMediaType: mediaType,
    fewShotCount,
    fewShotBreakdown,
  });
}
