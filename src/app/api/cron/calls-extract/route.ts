// GET /api/cron/calls-extract — the commitment-extraction cron
// (calls_merge_plan_2026-08.md slice S6, decision 5): runs one batch of
// backfillCommitments against the newest never-attempted (or oldest-retry)
// call_transcripts rows. Same shape as /api/cron/calls-sync: GET only
// (Vercel Cron only ever issues GET), allowlisted in operatorGate.ts (a
// cron request carries no operator session), CRON_SECRET-guarded via
// cronDenial.
//
// CALLS_EXTRACT_ENABLED is a SEPARATE off-by-default kill switch (decision
// 5: "each pipeline gets its own enable flag, default off, so a valid
// deploy runs nothing until Naldo turns each timer on explicitly").
// Registered in vercel.json by this PR, but left unset, so a merge
// activates the schedule while the route itself keeps no-oping until Naldo
// sets the flag.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { isClaudeConfigured } from '@/lib/claude';
import { backfillCommitments, COMMITMENT_EXTRACTION_BATCH_SIZE } from '@/lib/commitments/backfill';
import { isCommitmentsSchemaUnavailable } from '@/lib/commitments/errors';
import { cronDenial } from '@/lib/auth/cronAuth';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = cronDenial(req.headers.get('authorization'));
  if (denied) return denied;

  if (process.env.CALLS_EXTRACT_ENABLED !== 'true') {
    return NextResponse.json({ ran: false, reason: 'CALLS_EXTRACT_ENABLED is not set.' });
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ran: false, reason: 'Supabase not configured.' });
  }
  if (!isClaudeConfigured()) {
    return NextResponse.json({ ran: false, reason: 'Claude not configured.' });
  }

  const supabase = getSupabaseServiceClient()!;

  try {
    const result = await backfillCommitments(supabase, COMMITMENT_EXTRACTION_BATCH_SIZE);
    return NextResponse.json({ ran: true, ...result });
  } catch (err) {
    if (isCommitmentsSchemaUnavailable(err)) {
      return NextResponse.json({
        ran: false,
        migrated: false,
        reason: 'Run migrations/2026-08-29-call-commitments.sql first.',
      });
    }
    console.error('Cron calls-extract failed:', err);
    return NextResponse.json({ ran: false, error: 'Extraction failed.' }, { status: 500 });
  }
}
