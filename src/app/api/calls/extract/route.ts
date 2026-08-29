// POST /api/calls/extract — run one commitment-extraction batch on demand
// (the /admin/calls page's "Extract commitments" button), mirroring the
// bounded-batch-per-invocation chunking pattern /api/calls/process already
// uses (calls_merge_plan_2026-08.md slice S6). Operator-only: a human is
// already signed in when they click it.

import { NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { isClaudeConfigured } from '@/lib/claude';
import { backfillCommitments, COMMITMENT_EXTRACTION_BATCH_SIZE } from '@/lib/commitments/backfill';
import { isCommitmentsSchemaUnavailable } from '@/lib/commitments/errors';

export const runtime = 'nodejs';
// Up to COMMITMENT_EXTRACTION_BATCH_SIZE (6) transcripts, each one Haiku
// call plus a DB RPC -- matches this repo's other bounded-fan-out routes
// (src/app/api/referrals/sweep/route.ts's own maxDuration=60 note), not the
// copilot's own cron (which used 300 for a much larger backfill window).
export const maxDuration = 60;

export async function POST() {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ configured: false, reason: 'Supabase not configured.' });
  }
  if (!isClaudeConfigured()) {
    return NextResponse.json({ configured: false, reason: 'Claude not configured.' });
  }

  const supabase = getSupabaseServiceClient()!;

  try {
    const result = await backfillCommitments(supabase, COMMITMENT_EXTRACTION_BATCH_SIZE);
    return NextResponse.json({ configured: true, migrated: true, ...result });
  } catch (err) {
    if (isCommitmentsSchemaUnavailable(err)) {
      return NextResponse.json({
        configured: true,
        migrated: false,
        reason: 'Run migrations/2026-08-29-call-commitments.sql first.',
      });
    }
    console.error('Extract commitments batch failed:', err);
    return NextResponse.json({ configured: true, error: 'Could not extract commitments.' }, { status: 500 });
  }
}
