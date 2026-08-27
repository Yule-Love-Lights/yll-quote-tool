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
// Read-only and flag-gated. Returns the same { scene, photoUrl } shape as the
// portal hero while the house view is visible. A staff-hidden house view stays
// hidden here too, so this public poller never bypasses the portal control.

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

  // Readiness is CONTENT, not existence. createDesign (designs.ts, W2-030) INSERTs
  // the row with an EMPTY scene, then uploads the photo, then seeds the roofline —
  // three SEPARATE commits. A poll landing mid-sequence sees a row whose scene is
  // still {items:[]}; returning ready:true then would latch the client onto a
  // blank canvas forever (its scene object is truthy even when empty). So only
  // report ready once the photo AND the seeded roofline are both present; until
  // then keep the client polling (or, if the seed truly failed, poll out to no
  // visual — never a blank one).
  const scene = design?.scene;
  const seeded =
    design?.portalShowStreetView === true &&
    !!design.photoUrl &&
    Array.isArray(scene?.items) &&
    scene.items.length > 0;
  if (!design || !seeded) {
    return NextResponse.json({ ready: false }, { status: 200 });
  }

  return NextResponse.json(
    { ready: true, scene, photoUrl: design.photoUrl, photoW: design.photoW, photoH: design.photoH },
    { status: 200 },
  );
}
