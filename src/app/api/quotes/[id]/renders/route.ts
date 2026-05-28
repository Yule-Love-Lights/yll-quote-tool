// All renders attached to a quote, grouped by variant.
//
//   GET    /api/quotes/[id]/renders   — list every variant + signed URLs.
//                                        Used by both the admin variant
//                                        grid and the customer portal.
//   PATCH  /api/quotes/[id]/renders   — admin-only batch action. Today
//                                        supports {"action": "approve-all"}
//                                        which approves every ready/rendering
//                                        render for this quote in one call.
//
// Public GET. The customer portal needs to fetch its own approved variants
// and render the images, so we don't gate this behind ADMIN_SECRET.
// However: only renders with status='approved' are returned to non-admin
// callers. Pass `?include=all` with a valid x-admin-secret header to see
// everything (used by the admin review grid).

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  approveAllForQuote,
  getRendersForQuote,
  getSignedUrl,
} from '@/lib/rendering/storage';
import type { RenderVariant, StoredRender } from '@/lib/rendering/types';

export const runtime = 'nodejs';

const APPROVERS = new Set(['naldo', 'jason', 'internal']);

function isAdmin(req: NextRequest): boolean {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) return false;
  const provided = req.headers.get('x-admin-secret');
  return Boolean(provided && provided === expected);
}

type VariantWithUrls = StoredRender & {
  urls: { final: string | null; composite: string | null; source: string | null };
};

async function attachUrls(render: StoredRender): Promise<VariantWithUrls> {
  // Each signed URL fetch is independent — parallel for snappy portal load.
  // Failures fall back to null so a missing artifact doesn't blow up the
  // whole quote page.
  const [final, composite, source] = await Promise.all([
    render.final_path ? getSignedUrl(render.final_path).catch(() => null) : Promise.resolve(null),
    render.composite_path ? getSignedUrl(render.composite_path).catch(() => null) : Promise.resolve(null),
    render.source_path ? getSignedUrl(render.source_path).catch(() => null) : Promise.resolve(null),
  ]);
  return { ...render, urls: { final, composite, source } };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
      { status: 503 },
    );
  }
  const { id: quoteId } = await params;
  const url = new URL(req.url);
  const includeAll = url.searchParams.get('include') === 'all' && isAdmin(req);

  try {
    const all = await getRendersForQuote(quoteId);
    const filtered = includeAll
      ? all
      : all.filter(r => r.status === 'approved');

    // De-dup by variant — a quote could have multiple historical renders
    // per variant (older rejected ones, plus a current ready/approved one).
    // Keep the most recent non-rejected per variant.
    const byVariant = new Map<RenderVariant, StoredRender>();
    for (const r of filtered) {
      // filtered list is already ordered created_at DESC by getRendersForQuote
      if (!byVariant.has(r.variant)) byVariant.set(r.variant, r);
    }

    const enriched = await Promise.all(
      Array.from(byVariant.values()).map(attachUrls),
    );

    return NextResponse.json({ renders: enriched });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Lookup failed';
    console.error(`[api/quotes/${quoteId}/renders GET] failed:`, err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
      { status: 503 },
    );
  }
  if (!isAdmin(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: quoteId } = await params;
  const body = await req.json().catch(() => null) as
    | { action?: 'approve-all'; approver?: string }
    | null;
  if (!body || body.action !== 'approve-all') {
    return NextResponse.json({ error: 'action must be "approve-all"' }, { status: 400 });
  }

  const approver = body.approver && APPROVERS.has(body.approver) ? body.approver : 'internal';

  try {
    const count = await approveAllForQuote(quoteId, approver);
    return NextResponse.json({ approved: count });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Approve failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
