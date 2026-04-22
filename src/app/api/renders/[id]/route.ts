import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured } from '@/lib/supabase';
import {
  approveRender,
  deleteRender,
  getRender,
  getSignedUrl,
  rejectRender,
} from '@/lib/rendering/storage';

export const runtime = 'nodejs';

// Returns the render row plus short-lived signed URLs for each artifact.
// Signed URLs are what the admin gallery displays — lets us keep the bucket
// private while still rendering in the browser.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }
  const { id } = await params;
  const render = await getRender(id);
  if (!render) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const urls: Record<string, string | null> = {
    source: render.source_path ? await getSignedUrl(render.source_path).catch(() => null) : null,
    composite: render.composite_path ? await getSignedUrl(render.composite_path).catch(() => null) : null,
    mask: render.mask_path ? await getSignedUrl(render.mask_path).catch(() => null) : null,
    final: render.final_path ? await getSignedUrl(render.final_path).catch(() => null) : null,
  };

  return NextResponse.json({ render, urls });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => null) as { action?: 'approve' | 'reject'; approver?: string; reason?: string } | null;
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  if (body.action === 'approve') {
    await approveRender(id, body.approver ?? 'internal');
    return NextResponse.json({ ok: true });
  }
  if (body.action === 'reject') {
    await rejectRender(id, body.reason ?? 'no reason given');
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: 'action must be "approve" or "reject"' }, { status: 400 });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }
  const { id } = await params;
  try {
    await deleteRender(id);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
