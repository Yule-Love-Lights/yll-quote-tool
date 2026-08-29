import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { earningsSummary } from '@/lib/advertising/placements';
import { listAdvertisingWorkers } from '@/lib/advertising/workers';

export const runtime = 'nodejs';

/**
 * GET /api/admin/advertising/earnings — the owner's pay view: every worker's
 * pending estimate and accepted earned cents (total + ET day/week buckets),
 * with names attached. Estimates are clearly estimates (current rate);
 * earned is the stamped history and never moves with rate changes.
 */
export async function GET() {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const [summaries, workers] = await Promise.all([
    earningsSummary(),
    listAdvertisingWorkers({ includeInactive: true }),
  ]);
  const nameById = new Map(workers.map((w) => [w.id, w.displayName]));

  return NextResponse.json({
    workers: summaries.map((s) => ({
      ...s,
      displayName: nameById.get(s.workerId) ?? '(unknown worker)',
    })),
  });
}
