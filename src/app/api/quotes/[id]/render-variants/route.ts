// Batch-render every per-package variant for a quote in one call.
//
// Each customer-facing portal package (Santa's, Ridge, Minis, Wreaths,
// Spritzers, Garland) gets its own preview render here, plus a 'full'
// hero shot. Variants with no items in the supplied vision are skipped,
// not rendered as "house with zero lights."
//
// Caller hands over the same payload shape /api/renders POST takes —
// photoBase64, photoMediaType, vision, style. The model field on the body
// only affects the 'full' render (the hero); per-package variants always
// use RENDER_VARIANT_MODEL (defaults to flash2 for 50% Pro cost).
//
// Auth: ADMIN_SECRET header. This is admin-only — customers never trigger
// renders themselves. Rate-limited because each call can fire up to 7
// Gemini requests and ~$0.53 in spend.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { rateLimitResponse } from '@/lib/rateLimit';
import { renderAllVariants, RenderError } from '@/lib/rendering/orchestrator';
import { coerceVision } from '@/lib/rendering/adapter';
import type { RenderModel, RenderRequest, RenderStyle } from '@/lib/rendering/types';

export const runtime = 'nodejs';
// Worst case: 7 sequential Gemini renders if Pro queues throttle the
// concurrent pool. 30s/render * 7 = 210s; cap at the Vercel max.
export const maxDuration = 300;

const VALID_STYLES: RenderStyle[] = ['warm-white', 'multi', 'red-green'];
const VALID_MODELS: RenderModel[] = ['pro', 'flash2', 'flash'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 15 * 1024 * 1024;

function checkAdminSecret(req: NextRequest): NextResponse | null {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'ADMIN_SECRET not configured on server' }, { status: 503 });
  }
  const provided = req.headers.get('x-admin-secret');
  if (!provided || provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
      { status: 503 },
    );
  }

  const authFail = checkAdminSecret(req);
  if (authFail) return authFail;

  // Tighter than the per-render route — each batch call can fire 7 Gemini
  // requests, so even moderate spam runs up real money fast.
  const rl = rateLimitResponse(req, { bucket: 'render-variants', limit: 2, windowMs: 60_000 });
  if (rl) return rl;

  const { id: quoteId } = await params;
  if (!UUID_RE.test(quoteId)) {
    return NextResponse.json({ error: 'quoteId must be a valid UUID' }, { status: 400 });
  }

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
    return NextResponse.json(
      { error: 'photoBase64 and photoMediaType are required' },
      { status: 400 },
    );
  }
  if (body.photoBase64.length * 0.75 > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `photoBase64 too large (max ${MAX_BODY_BYTES} bytes decoded)` },
      { status: 413 },
    );
  }
  if (!body.vision) {
    return NextResponse.json({ error: 'vision data is required' }, { status: 400 });
  }
  const style = (body.style ?? 'warm-white') as RenderStyle;
  if (!VALID_STYLES.includes(style)) {
    return NextResponse.json(
      { error: `style must be one of ${VALID_STYLES.join(', ')}` },
      { status: 400 },
    );
  }
  const model = body.model as RenderModel | undefined;
  if (model !== undefined && !VALID_MODELS.includes(model)) {
    return NextResponse.json(
      { error: `model must be one of ${VALID_MODELS.join(', ')}` },
      { status: 400 },
    );
  }

  try {
    const outcomes = await renderAllVariants({
      quoteId,
      photoBase64: body.photoBase64,
      photoMediaType: body.photoMediaType,
      vision: coerceVision(body.vision),
      style,
      model, // only affects 'full' variant
      notes: body.notes,
      skipCache: body.skipCache === true,
    });

    // Top-level summary alongside the detail array — easy for the UI to
    // show "5 rendered, 1 cached, 1 skipped (no garland)" without grouping.
    const summary = {
      total: outcomes.length,
      rendered: outcomes.filter(o => o.status === 'rendered').length,
      cached: outcomes.filter(o => o.status === 'cached').length,
      skipped: outcomes.filter(o => o.status === 'skipped').length,
      failed: outcomes.filter(o => o.status === 'failed').length,
    };

    return NextResponse.json({ summary, outcomes });
  } catch (err) {
    console.error(`[api/quotes/${quoteId}/render-variants] failed:`, err);
    if (err instanceof RenderError) {
      const status = err.code === 'budget' ? 402 : err.code === 'config' ? 503 : 500;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    const msg = err instanceof Error ? err.message : 'Unknown render error';
    const includeStack = process.env.NODE_ENV !== 'production';
    const stack = includeStack && err instanceof Error ? err.stack : undefined;
    return NextResponse.json({ error: msg, ...(stack ? { stack } : {}) }, { status: 500 });
  }
}
