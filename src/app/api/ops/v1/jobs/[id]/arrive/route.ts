import { NextRequest, NextResponse } from 'next/server';

import { requireCrew } from '@/lib/auth/crewAuth';
import { getOpenShift } from '@/lib/shifts';
import { arriveAtJob, type EntryKind } from '@/lib/jobSegments';
import { isSupabaseServiceConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRY_KINDS: readonly EntryKind[] = ['install', 'rework', 'non_billable'];

/**
 * POST /api/ops/v1/jobs/{id}/arrive — open a job segment (Flow B).
 *
 * CREW-ONLY, and never dormant: this writes payroll data. The crew member id
 * comes from the authenticated session, NEVER from the body, so this is
 * "clock myself onto this job", not "clock anyone onto this job".
 *
 * The shift must already be open — arriving without a day clock would create job
 * time outside any paid envelope, which the hours rollup could not account for.
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

  let entryKind: EntryKind = 'install';
  try {
    const body = (await req.json().catch(() => ({}))) as { entryKind?: unknown };
    if (body.entryKind !== undefined) {
      if (!ENTRY_KINDS.includes(body.entryKind as EntryKind)) {
        return NextResponse.json(
          { error: `entryKind must be one of ${ENTRY_KINDS.join(', ')}` },
          { status: 400 },
        );
      }
      entryKind = body.entryKind as EntryKind;
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { crewMemberId } = auth.caller;

  const shift = await getOpenShift(crewMemberId);
  if (!shift) {
    return NextResponse.json(
      { error: 'You are not clocked in. Clock in before arriving at a job.' },
      { status: 409 },
    );
  }

  try {
    const segment = await arriveAtJob(shift.id, crewMemberId, jobId, 'pwa', entryKind);
    return NextResponse.json({ segment });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to arrive';
    // "still on job X; depart it before arriving at Y" is a state conflict the
    // caller can act on, not a server fault.
    const conflict = message.includes('still on job') || message.includes('already closed');
    console.error('POST /api/ops/v1/jobs/[id]/arrive:', message);
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 500 });
  }
}
