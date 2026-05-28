import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  approveRender,
  deleteRender,
  getRender,
  getSignedUrl,
  rejectRender,
} from '@/lib/rendering/storage';

export const runtime = 'nodejs';

// Operations that mutate a render (approve, reject, delete) require a
// shared secret header. Admin UI stores it in sessionStorage once and
// replays it on every mutating request. Without this, anyone who knows
// the deployment URL can wipe the gallery (see REVIEW C3).
function checkAdminSecret(req: NextRequest): NextResponse | null {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'ADMIN_SECRET not configured on server' },
      { status: 503 },
    );
  }
  const provided = req.headers.get('x-admin-secret');
  if (!provided || provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

// Whitelist approvers so the audit trail can't be spoofed by a client
// passing arbitrary strings (see REVIEW H7). Expand when new staff join.
const APPROVERS = new Set(['naldo', 'jason', 'internal']);

// Returns the render row plus short-lived signed URLs for each artifact.
// Signed URLs are what the admin gallery displays — lets us keep the bucket
// private while still rendering in the browser.
//
// The whole body is wrapped so we ALWAYS return JSON. Without the wrapper,
// any throw (Supabase row error, RLS reject, malformed jsonb) bubbles up
// and Next.js serves the default HTML 500 page — which the calling
// frontend (/quote/new, /admin/renders) tries to JSON.parse, blowing up
// with "Unexpected token '<'" and hiding the real error.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }
  const { id } = await params;

  // Step-by-step with phase tagging so the next failure points at the
  // exact line that died — saves a round-trip through the dev server log.
  // Stack trace + phase are included in the response in non-prod only.
  let phase: 'getRender' | 'sign-source' | 'sign-composite' | 'sign-mask' | 'sign-final' | 'serialize' = 'getRender';
  try {
    const render = await getRender(id);
    if (!render) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    phase = 'sign-source';
    const sourceUrl = render.source_path ? await getSignedUrl(render.source_path).catch(() => null) : null;
    phase = 'sign-composite';
    const compositeUrl = render.composite_path ? await getSignedUrl(render.composite_path).catch(() => null) : null;
    phase = 'sign-mask';
    const maskUrl = render.mask_path ? await getSignedUrl(render.mask_path).catch(() => null) : null;
    phase = 'sign-final';
    const finalUrl = render.final_path ? await getSignedUrl(render.final_path).catch(() => null) : null;

    phase = 'serialize';
    const urls = { source: sourceUrl, composite: compositeUrl, mask: maskUrl, final: finalUrl };
    return NextResponse.json({ render, urls });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    const stack = process.env.NODE_ENV !== 'production' && err instanceof Error ? err.stack : undefined;
    console.error(`[api/renders/${id}] GET failed at phase=${phase}:`, err);
    return NextResponse.json(
      { error: `Render fetch failed at phase=${phase}: ${msg}`, phase, ...(stack ? { stack } : {}) },
      { status: 500 },
    );
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }
  const authFail = checkAdminSecret(req);
  if (authFail) return authFail;

  const { id } = await params;
  const body = await req.json().catch(() => null) as { action?: 'approve' | 'reject'; approver?: string; reason?: string } | null;
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  if (body.action === 'approve') {
    const approver = body.approver && APPROVERS.has(body.approver) ? body.approver : 'internal';
    await approveRender(id, approver);
    return NextResponse.json({ ok: true });
  }
  if (body.action === 'reject') {
    await rejectRender(id, body.reason ?? 'no reason given');
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: 'action must be "approve" or "reject"' }, { status: 400 });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }
  const authFail = checkAdminSecret(req);
  if (authFail) return authFail;

  const { id } = await params;
  try {
    await deleteRender(id);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
