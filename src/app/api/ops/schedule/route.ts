import { NextRequest, NextResponse } from 'next/server';

import { requireOperator } from '@/lib/auth/supabaseServer';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  assignCrewToJob,
  getSchedule,
  isCalendarDate,
  listUnscheduledJobs,
  unassignCrewFromJob,
} from '@/lib/scheduling';

export const runtime = 'nodejs';

/**
 * Scheduling (P4P Phase 3). OPERATOR-only: the office schedules, crew do not.
 * Deliberately outside /api/ops/v1, which is the crew-confined namespace.
 *
 *   GET    ?from=YYYY-MM-DD&to=YYYY-MM-DD  → the schedule + per-day capacity
 *   GET    ?unscheduled=YYYY-MM-DD         → jobs still needing a date
 *   POST   { jobId, crewMemberId, date }   → assign (idempotent)
 *   DELETE { jobId, crewMemberId, date }   → unassign
 */
export async function GET(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const params = req.nextUrl.searchParams;

  const unscheduledFrom = params.get('unscheduled');
  if (unscheduledFrom !== null) {
    if (!isCalendarDate(unscheduledFrom)) {
      return NextResponse.json({ error: 'unscheduled must be YYYY-MM-DD' }, { status: 400 });
    }
    const { jobs, errors } = await listUnscheduledJobs(unscheduledFrom);
    if (errors.length) console.error('schedule/unscheduled:', errors.join(' | '));
    return NextResponse.json({ jobs, errors });
  }

  const from = params.get('from');
  const to = params.get('to');
  if (!from || !to || !isCalendarDate(from) || !isCalendarDate(to)) {
    return NextResponse.json({ error: 'from and to must be YYYY-MM-DD' }, { status: 400 });
  }
  if (from > to) {
    return NextResponse.json({ error: 'from must not be after to' }, { status: 400 });
  }

  const { days, jobsByDate, errors } = await getSchedule(from, to);
  if (errors.length) console.error('schedule:', errors.join(' | '));

  return NextResponse.json({
    from,
    to,
    days,
    jobsByDate,
    // Surfaced, not swallowed: a partial read returning an empty schedule would
    // read as "nothing is booked", which is the opposite of true.
    errors,
  });
}

type Body = { jobId?: unknown; crewMemberId?: unknown; date?: unknown };

function readBody(body: Body | null) {
  const jobId = String(body?.jobId ?? '').trim();
  const crewMemberId = String(body?.crewMemberId ?? '').trim();
  const date = String(body?.date ?? '').trim();
  if (!jobId || !crewMemberId) return { error: 'jobId and crewMemberId are required' } as const;
  if (!isCalendarDate(date)) return { error: 'date must be YYYY-MM-DD' } as const;
  return { jobId, crewMemberId, date } as const;
}

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const parsed = readBody((await req.json().catch(() => null)) as Body | null);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const assignment = await assignCrewToJob(parsed.jobId, parsed.crewMemberId, parsed.date);
    return NextResponse.json({ assignment });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to assign';
    console.error('POST /api/ops/schedule:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const parsed = readBody((await req.json().catch(() => null)) as Body | null);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const removed = await unassignCrewFromJob(parsed.jobId, parsed.crewMemberId, parsed.date);
    return NextResponse.json({ removed });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to unassign';
    console.error('DELETE /api/ops/schedule:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
