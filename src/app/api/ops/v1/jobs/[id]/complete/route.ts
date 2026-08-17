import { NextRequest, NextResponse } from 'next/server';

import { requireCrew } from '@/lib/auth/crewAuth';
import { getOpenShift } from '@/lib/shifts';
import { departFromJob, getOpenSegment } from '@/lib/jobSegments';
import { getJob, setJobStatus } from '@/lib/jobs';
import { canTransition } from '@/lib/jobStatus';
import { isSupabaseServiceConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/ops/v1/jobs/{id}/complete — depart the job AND mark it installed.
 *
 * NALDO'S RULING (2026-08-16): this sets `jobs.status = 'installed'` through the
 * EXISTING quote-tool machinery — `setJobStatus`, which guards against
 * `canTransition` — and introduces no new "Flow C operational completion"
 * concept or vocabulary. It matches exactly how the quote tool already moves a
 * job's status. Both `to_schedule -> installed` and `scheduled -> installed` are
 * already legal transitions, so nothing in the status model changes.
 *
 * ORDER MATTERS: the segment closes FIRST, then the status moves. If the status
 * move fails, the time is still recorded correctly (that is the payroll-critical
 * half) and the job simply stays un-installed for an operator to advance. The
 * reverse order could mark a job installed while losing the hours that prove it.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCrew();
  if ('response' in auth) return auth.response;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { id: jobId } = await params;
  if (!UUID_RE.test(jobId)) {
    return NextResponse.json({ error: 'Invalid job id' }, { status: 400 });
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
  if (open.jobId !== jobId) {
    return NextResponse.json(
      { error: `You are at job ${open.jobId}, not ${jobId}.` },
      { status: 409 },
    );
  }

  // 1. Close the segment with the completed reason. Payroll-critical half first.
  let segment;
  try {
    segment = await departFromJob(open.id, crewMemberId, 'completed', 'pwa');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to complete';
    console.error('POST /api/ops/v1/jobs/[id]/complete (depart):', message);
    const conflict = message.includes('already departed');
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 500 });
  }

  // 2. Advance the job to `installed` via the existing machinery. A job already
  // past `installed` is left alone rather than dragged backwards, and an illegal
  // transition (e.g. from `cancelled`) is reported without failing the clock-out
  // that already succeeded.
  const job = await getJob(jobId);
  if (!job) {
    return NextResponse.json(
      { segment, statusChanged: false, warning: 'Time recorded, but the job could not be loaded to update its status.' },
      { status: 200 },
    );
  }

  if (job.status === 'installed') {
    return NextResponse.json({ segment, statusChanged: false, status: job.status });
  }
  if (!canTransition(job.status, 'installed')) {
    return NextResponse.json({
      segment,
      statusChanged: false,
      status: job.status,
      warning: `Time recorded. The job is '${job.status}', which cannot move to 'installed'.`,
    });
  }

  const updated = await setJobStatus(jobId, 'installed');
  if (!updated) {
    return NextResponse.json({
      segment,
      statusChanged: false,
      status: job.status,
      warning: 'Time recorded, but the job status could not be updated.',
    });
  }

  return NextResponse.json({ segment, statusChanged: true, status: updated.status });
}
