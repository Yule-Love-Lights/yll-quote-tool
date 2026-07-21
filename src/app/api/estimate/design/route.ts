// Customer self-serve estimate — fetch the persisted design for the result
// screen's visual (ledger self-serve, Slice 3).
//
// GET /api/estimate/design?quoteId=<uuid>
//   { ready: true, scene, photoUrl, photoW, photoH }  — the design is persisted
//   { ready: false }                                  — not drawn yet. The main
//        /api/estimate handler persists the design in an after() task AFTER it
//        responds (so a slow render never delays the customer's price), so the
//        result screen polls this until the drawing lands.
//   { error } with 404 (flag off) / 400 (bad id) / 429 (rate limited)
//
// Read-only and flag-gated. Returns the SAME { scene, photoUrl } shape the portal
// hero already exposes for any quote by UUID (loadPortalQuote → PortalQuote.design),
// so this adds no new data surface — it just lets the pre-portal estimate screen
// show the customer the measured roofline they were priced on.

import { NextRequest, NextResponse } from 'next/server';
import { isSelfServeEstimateEnabled } from '@/lib/selfServe/estimateFlag';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { rateLimitResponse } from '@/lib/rateLimit';
import { getDesignByQuote, isValidDesignId } from '@/lib/designs';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  // Flag off → the whole feature is dark; match /api/estimate's 404.
  if (!isSelfServeEstimateEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Polled a handful of times per estimate; generous but bounded so it can't be
  // turned into a design-enumeration scan (quoteIds are UUIDs, so even a hit only
  // returns data the portal already exposes for that same UUID).
  const blocked = rateLimitResponse(req, { bucket: 'self-serve-estimate-design', limit: 30, windowMs: 60_000 });
  if (blocked) return blocked;

  const quoteId = req.nextUrl.searchParams.get('quoteId');
  if (!isValidDesignId(quoteId)) {
    return NextResponse.json({ error: 'quoteId is required' }, { status: 400 });
  }

  // Config missing → treat as "no visual yet" rather than a hard error; the
  // result screen just shows the range without a picture.
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ready: false }, { status: 200 });
  }

  const design = await getDesignByQuote(quoteId).catch((err) => {
    console.error('[api/estimate/design] lookup failed:', err instanceof Error ? err.message : 'error');
    return null;
  });
  if (!design) {
    // Not persisted yet (the after() task hasn't finished) or best-effort failed.
    return NextResponse.json({ ready: false }, { status: 200 });
  }

  return NextResponse.json(
    { ready: true, scene: design.scene, photoUrl: design.photoUrl, photoW: design.photoW, photoH: design.photoH },
    { status: 200 },
  );
}
