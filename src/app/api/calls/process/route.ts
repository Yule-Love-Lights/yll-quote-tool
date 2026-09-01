// POST /api/calls/process — process the next batch of pending call
// recordings on demand (the /admin/calls page's "Process next batch"
// button), mirroring the bounded-batch-per-invocation chunking pattern the
// cron route uses (calls_merge_plan_2026-08.md slice S2). Operator-only: a
// human is already signed in when they click it.

import { NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { processPendingRecordings } from '@/lib/calls/pipeline';
import { RECORDING_BATCH_SIZE } from '@/lib/calls/sync';
import { isMissingTableError } from '@/lib/calls/errors';

export const runtime = 'nodejs';

export async function POST() {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ configured: false, reason: 'Supabase not configured.' });
  }

  const supabase = getSupabaseServiceClient()!;

  try {
    const result = await processPendingRecordings(supabase, RECORDING_BATCH_SIZE);
    return NextResponse.json({ configured: true, migrated: true, ...result });
  } catch (err) {
    if (isMissingTableError(err)) {
      return NextResponse.json({ configured: true, migrated: false, reason: 'Run migrations/2026-08-29-call-ingest.sql first.' });
    }
    console.error('Process calls batch failed:', err);
    return NextResponse.json({ configured: true, error: 'Could not process the batch.' }, { status: 500 });
  }
}
