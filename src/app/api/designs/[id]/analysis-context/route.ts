// POST /api/designs/[id]/analysis-context — persist the AI-analysis
// provenance on a design (#8 Stage A).
//
// The builder calls this right after an analyze lands (and after the eager
// design exists), with whichever pieces that flow produced:
//
//   { analysis?:           <raw PhotoAnalysisResult — opaque jsonb>,
//     satelliteBase64?:    <satellite image — Google pull or manual upload>,
//     satelliteMediaType?: 'image/jpeg' | ...,
//     satelliteFeetPerPixel?: number | null }
//
// Either half is optional: a manual photo upload has an analysis but no
// satellite; a manual satellite upload (#9) has a satellite but no analysis.
// Training-example capture (POST /api/training-examples) assembles entirely
// from what's stored here — no client state needed at capture time.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  getDesign,
  setDesignAnalysis,
  uploadDesignSatellite,
  isValidDesignId,
} from '@/lib/designs';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

const MAX_IMAGE_BASE64_CHARS = 14 * 1024 * 1024; // ~10MB binary, base64-inflated

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
      { status: 503 },
    );
  }
  const { id } = await params;
  if (!isValidDesignId(id)) {
    return NextResponse.json({ error: 'Invalid design id' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const analysis = body.analysis;
  const satelliteBase64 = body.satelliteBase64;
  const hasAnalysis = analysis != null && typeof analysis === 'object' && !Array.isArray(analysis);
  const hasSatellite = typeof satelliteBase64 === 'string' && satelliteBase64.length > 0;
  if (!hasAnalysis && !hasSatellite) {
    return NextResponse.json(
      { error: 'Nothing to store (provide analysis and/or satelliteBase64)' },
      { status: 400 },
    );
  }
  if (hasSatellite && (satelliteBase64 as string).length > MAX_IMAGE_BASE64_CHARS) {
    return NextResponse.json({ error: 'Satellite image too large — max 10MB' }, { status: 400 });
  }

  const row = await getDesign(id);
  if (!row) return NextResponse.json({ error: 'Design not found' }, { status: 404 });

  try {
    if (hasAnalysis) {
      const ok = await setDesignAnalysis(id, analysis as Record<string, unknown>);
      if (!ok) return NextResponse.json({ error: 'Failed to store the analysis' }, { status: 500 });
    }
    if (hasSatellite) {
      const mediaType =
        typeof body.satelliteMediaType === 'string' && body.satelliteMediaType.startsWith('image/')
          ? body.satelliteMediaType
          : 'image/jpeg';
      const fpp =
        typeof body.satelliteFeetPerPixel === 'number' && Number.isFinite(body.satelliteFeetPerPixel)
          ? body.satelliteFeetPerPixel
          : null;
      await uploadDesignSatellite(id, satelliteBase64 as string, mediaType, fpp);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to store analysis context';
    console.error('POST /api/designs/[id]/analysis-context error:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
