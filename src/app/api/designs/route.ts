// Design collection endpoint (design-tool integration, Path B — task #27).
//
//   POST /api/designs — create a new design. Optional body:
//       { quoteId?, photoBase64?, photoMediaType?, seedLines? }
//     Used by the builder when the Street View photo is pulled: it creates the
//     design (independent of any saved quote) and seeds the base photo so the
//     editor opens on the customer's house. `seedLines` (#33) carries the
//     builder's normalized roofline polylines — they become pre-tagged C9
//     strands so the portal picture-toggle works without manual tagging.
//     A design may be created before a quote exists; the quote link is set
//     later via PUT /api/designs/[id].

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { createDesign, getDesignWithPhoto, isValidDesignId } from '@/lib/designs';
import { sanitizeSeedLines } from '@/lib/design/seedRoofline';
import { sanitizeAnalysisSeed } from '@/lib/design/seedFromAnalysis';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
      { status: 503 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // No body / invalid JSON is fine — create a blank design.
  }

  const quoteId = body.quoteId;
  if (quoteId !== undefined && quoteId !== null && !isValidDesignId(quoteId)) {
    return NextResponse.json({ error: 'Invalid quoteId' }, { status: 400 });
  }
  const photoBase64 = typeof body.photoBase64 === 'string' ? body.photoBase64 : null;
  const photoMediaType = typeof body.photoMediaType === 'string' ? body.photoMediaType : null;

  try {
    const created = await createDesign({
      quoteId: (quoteId as string | undefined) ?? null,
      photoBase64,
      photoMediaType,
      seedLines: sanitizeSeedLines(body.seedLines),
      // Full bridge auto-design payload (#35 Phase 2): roofline lines +
      // per-unit detections — the design opens already designed.
      seedAnalysis: sanitizeAnalysisSeed(body.seedAnalysis),
    });
    if (!created) {
      return NextResponse.json({ error: 'Failed to create design' }, { status: 500 });
    }
    const design = await getDesignWithPhoto(created.id);
    // #90: garland runs seeded with no scale → the builder warns staff to set
    // their section counts before quoting.
    return NextResponse.json({ design, garlandSectionsUnestimated: created.garlandSectionsUnestimated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create design';
    console.error('POST /api/designs error:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
