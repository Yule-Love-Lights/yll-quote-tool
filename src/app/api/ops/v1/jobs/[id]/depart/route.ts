import { NextRequest, NextResponse } from 'next/server';

import { requireCrew } from '@/lib/auth/crewAuth';
import { getOpenShift } from '@/lib/shifts';
import {
  STOPPAGE_REASONS,
  departFromJob,
  getOpenSegment,
  type StoppageReason,
} from '@/lib/jobSegments';
import { isSupabaseServiceConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/ops/v1/jobs/{id}/depart — close the open job segment (Flow B).
 *
 * `stoppageReason` is REQUIRED in the body, with no default. It ships from day
 * one and cannot be backfilled: nobody will remember which Tuesday it rained,
 * and a defaulted `completed` would mark a rained-out job as finished and poison
 * the budgeted-hours learning signal the whole P4P engine trains on.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCrew();
  if ('response' in auth) return auth.response;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { id: jobId } = await params;
  if (!UUID_RE.test(jobId)) {
    return NextResponse.json({ error: 'Invalid job id' }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as { stoppageReason?: unknown } | null;
  const reason = body?.stoppageReason;
  if (!STOPPAGE_REASONS.includes(reason as StoppageReason)) {
    return NextResponse.json(
      { error: `stoppageReason is required and must be one of ${STOPPAGE_REASONS.join(', ')}` },
      { status: 400 },
    );
  }

  const { crewMemberId } = auth.caller;

  const shift = await getOpenShift(crewMemberId);
  if (!shift) {
    return NextResponse.json({ error: 'You are not clocked in.' }, { status: 409 });
  }

  const open = await getOpenSegment(shift.id);
  if (!open) {
    return NextResponse.json({ error: 'You are not currently at a job.' }, { status: 409 });
  }
  // Depart names the job in the URL, so refuse a mismatch rather than closing
  // whatever happens to be open: a crew member who thinks they are leaving job B
  // must not silently close job A's segment.
  if (open.jobId !== jobId) {
    return NextResponse.json(
      { error: `You are at job ${open.jobId}, not ${jobId}.` },
      { status: 409 },
    );
  }

  try {
    const segment = await departFromJob(
      open.id,
      crewMemberId,
      reason as StoppageReason,
      'pwa',
    );
    return NextResponse.json({ segment });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to depart';
    console.error('POST /api/ops/v1/jobs/[id]/depart:', message);
    const conflict = message.includes('already departed');
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 500 });
  }
}
