// Customer self-serve estimate — featured real-job designs for the landing gallery
// (ledger self-serve, S48, "reference the completed jobs").
//
// GET /api/estimate/samples
//   { samples: [{ scene, photoUrl, photoW, photoH }, ...] }  — recent REAL booked/
//     approved designs, rendered client-side via the same DesignCanvas as the portal.
//   { error } with 404 (flag off) / 429 (rate limited)
//
// Flag-gated + rate-limited. The payload is the house render only (no PII); the same
// render is already public on each quote's own portal by UUID.

import { NextRequest, NextResponse } from 'next/server';
import { isSelfServeEstimateEnabled } from '@/lib/selfServe/estimateFlag';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { rateLimitResponse } from '@/lib/rateLimit';
import { listSampleDesigns } from '@/lib/designs';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isSelfServeEstimateEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const blocked = rateLimitResponse(req, { bucket: 'self-serve-estimate-samples', limit: 30, windowMs: 60_000 });
  if (blocked) return blocked;

  // No config → no gallery (never an error; the landing just omits it).
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ samples: [] }, { status: 200 });
  }

  const samples = await listSampleDesigns(6).catch((err) => {
    console.error('[api/estimate/samples] lookup failed:', err instanceof Error ? err.message : 'error');
    return [];
  });
  return NextResponse.json({ samples }, { status: 200 });
}
