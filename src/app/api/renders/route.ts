import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured } from '@/lib/supabase';
import { rateLimitResponse } from '@/lib/rateLimit';
import { runRender, RenderError } from '@/lib/rendering/orchestrator';
import { listRenders } from '@/lib/rendering/storage';
import type { RenderRequest, RenderStyle } from '@/lib/rendering/types';

export const runtime = 'nodejs';
export const maxDuration = 120; // Gemini image generation can take 30-60s

const VALID_STYLES: RenderStyle[] = ['warm-white', 'multi', 'red-green'];

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }
  const items = await listRenders(100);
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }

  // Tight rate limit — each call can burn $0.20 and 60s of Gemini time.
  const rl = rateLimitResponse(req, { bucket: 'renders', limit: 5, windowMs: 60_000 });
  if (rl) return rl;

  let body: Partial<RenderRequest>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.photoBase64 || !body.photoMediaType) {
    return NextResponse.json({ error: 'photoBase64 and photoMediaType are required' }, { status: 400 });
  }
  if (!body.vision) {
    return NextResponse.json({ error: 'vision data is required' }, { status: 400 });
  }
  const style = (body.style ?? 'warm-white') as RenderStyle;
  if (!VALID_STYLES.includes(style)) {
    return NextResponse.json({ error: `style must be one of ${VALID_STYLES.join(', ')}` }, { status: 400 });
  }

  try {
    const render = await runRender({
      quoteId: body.quoteId,
      photoBase64: body.photoBase64,
      photoMediaType: body.photoMediaType,
      vision: {
        santasLines: body.vision.santasLines ?? [],
        gingerbreadLines: body.vision.gingerbreadLines ?? [],
        c9Lines: body.vision.c9Lines ?? [],
        miniLights: body.vision.miniLights ?? [],
        wreaths: body.vision.wreaths ?? [],
        spritzers: body.vision.spritzers ?? [],
        garland: body.vision.garland ?? [],
      },
      style,
      notes: body.notes,
    });
    return NextResponse.json({ render });
  } catch (err) {
    console.error('[api/renders POST] render failed:', err);
    if (err instanceof RenderError) {
      const status = err.code === 'budget' ? 402 : err.code === 'config' ? 503 : 500;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    const msg = err instanceof Error ? err.message : 'Unknown render error';
    const stack = err instanceof Error ? err.stack : undefined;
    return NextResponse.json({ error: msg, stack }, { status: 500 });
  }
}
