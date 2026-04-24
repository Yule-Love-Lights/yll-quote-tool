import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { rateLimitResponse } from '@/lib/rateLimit';
import { runRender, RenderError } from '@/lib/rendering/orchestrator';
import { deleteRender, listRenders } from '@/lib/rendering/storage';
import { coerceVision } from '@/lib/rendering/adapter';
import type { RenderModel, RenderRequest, RenderStyle } from '@/lib/rendering/types';

export const runtime = 'nodejs';
export const maxDuration = 120; // Gemini image generation can take 30-60s

const VALID_STYLES: RenderStyle[] = ['warm-white', 'multi', 'red-green'];
const VALID_MODELS: RenderModel[] = ['pro', 'flash2', 'flash'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cap the POST body. A daytime JPEG from a phone runs ~2–5MB; base64 inflates
// by ~33%, plus vision JSON. 15MB leaves headroom without letting an attacker
// OOM the serverless function. See REVIEW H4.
const MAX_BODY_BYTES = 15 * 1024 * 1024;

export async function GET() {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }
  const items = await listRenders(500);
  return NextResponse.json({ items });
}

// Bulk delete endpoint. Protected by the same ADMIN_SECRET the per-render
// DELETE uses. Iterates listRenders and deletes each one (storage + row).
// Used by the admin gallery's "Delete all" button to purge bad test renders.
export async function DELETE(req: NextRequest) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'ADMIN_SECRET not configured on server' }, { status: 503 });
  }
  const provided = req.headers.get('x-admin-secret');
  if (!provided || provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const items = await listRenders(1000);
  const errors: { id: string; error: string }[] = [];
  let deleted = 0;
  for (const r of items) {
    try {
      await deleteRender(r.id);
      deleted += 1;
    } catch (err) {
      errors.push({ id: r.id, error: err instanceof Error ? err.message : 'unknown' });
    }
  }
  return NextResponse.json({ deleted, errors });
}

export async function POST(req: NextRequest) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }

  // Tight rate limit — each call can burn $0.20 and 60s of Gemini time.
  const rl = rateLimitResponse(req, { bucket: 'renders', limit: 5, windowMs: 60_000 });
  if (rl) return rl;

  const declaredLen = Number(req.headers.get('content-length') ?? 0);
  if (declaredLen > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `Payload too large (max ${MAX_BODY_BYTES} bytes)` },
      { status: 413 },
    );
  }

  let body: Partial<RenderRequest>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.photoBase64 || !body.photoMediaType) {
    return NextResponse.json({ error: 'photoBase64 and photoMediaType are required' }, { status: 400 });
  }
  // Sanity check after decoding — base64 body present but claimed over the
  // cap (chunked transfer, missing content-length, etc.).
  if (body.photoBase64.length * 0.75 > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `photoBase64 too large (max ${MAX_BODY_BYTES} bytes decoded)` },
      { status: 413 },
    );
  }
  if (!body.vision) {
    return NextResponse.json({ error: 'vision data is required' }, { status: 400 });
  }
  if (body.quoteId && !UUID_RE.test(body.quoteId)) {
    return NextResponse.json({ error: 'quoteId must be a valid UUID' }, { status: 400 });
  }
  const style = (body.style ?? 'warm-white') as RenderStyle;
  if (!VALID_STYLES.includes(style)) {
    return NextResponse.json({ error: `style must be one of ${VALID_STYLES.join(', ')}` }, { status: 400 });
  }
  // model is optional — orchestrator falls back to RENDER_MODEL env var, then 'pro'.
  const model = body.model as RenderModel | undefined;
  if (model !== undefined && !VALID_MODELS.includes(model)) {
    return NextResponse.json({ error: `model must be one of ${VALID_MODELS.join(', ')}` }, { status: 400 });
  }

  try {
    const render = await runRender({
      quoteId: body.quoteId,
      photoBase64: body.photoBase64,
      photoMediaType: body.photoMediaType,
      vision: coerceVision(body.vision),
      style,
      model,
      notes: body.notes,
      skipCache: body.skipCache === true,
    });
    return NextResponse.json({ render });
  } catch (err) {
    console.error('[api/renders POST] render failed:', err);
    if (err instanceof RenderError) {
      const status = err.code === 'budget' ? 402 : err.code === 'config' ? 503 : 500;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    const msg = err instanceof Error ? err.message : 'Unknown render error';
    // Only leak stack traces in dev — they disclose internal paths.
    const includeStack = process.env.NODE_ENV !== 'production';
    const stack = includeStack && err instanceof Error ? err.stack : undefined;
    return NextResponse.json({ error: msg, ...(stack ? { stack } : {}) }, { status: 500 });
  }
}
