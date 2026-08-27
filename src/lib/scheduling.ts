import { getSupabaseServiceClient } from '@/lib/supabase';
import { readLaborPlan, type LaborPlanSource } from '@/lib/laborPlan';

/**
 * Scheduling and capacity (P4P Track A Phase 3).
 *
 * THE CAPACITY DERIVATION, stated because the plan insists it be stated:
 * Phase 1 computes JOB-level budgeted hours only. There is no per-person
 * estimate anywhere. So a person's load for a day is each assigned job's
 * budgeted hours divided across the crew assigned to THAT job on THAT day. A
 * job scheduled with nobody assigned is not zero load — it is UNASSIGNED load,
 * reported separately, because a day with 40 unassigned hours is not an empty
 * day.
 *
 * ⚠️ EVERY BUDGETED-HOURS VALUE IN PROD IS STILL A PLACEHOLDER. Capacity built
 * on it is placeholder too, and this module says so in its output rather than
 * presenting invented hours as a real day's load. That is the whole point of the
 * laborPlan guardrail, and scheduling is its first real consumer.
 */

export type Assignment = {
  id: string;
  jobId: string;
  crewMemberId: string;
  /** Calendar day in the business timezone, YYYY-MM-DD. */
  assignedDate: string;
};

export type ScheduledJob = {
  jobId: string;
  jobNumber: number | null;
  status: string;
  /** Budgeted hours for the WHOLE job, not per day. */
  budgetedHours: number | null;
  /** True when those hours came from placeholder production rates. */
  hoursArePlaceholder: boolean;
  /** Crew assigned to this job on the day in question. */
  crewMemberIds: string[];
};

export type DayCapacity = {
  date: string;
  /** Hours per crew member for that day. */
  perCrew: Record<string, number>;
  /** Hours on jobs scheduled that day with NOBODY assigned. */
  unassignedHours: number;
  /** Jobs scheduled that day whose hours are unknown (no estimate computed). */
  jobsWithoutEstimate: number;
  /**
   * True when ANY contributing job used placeholder rates. The number is still
   * shown — it is the best planning shape available — but never as a real one.
   */
  anyPlaceholderHours: boolean;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * PURE capacity math, so the derivation is testable without a database.
 *
 * Rounding: hours are kept as floats here rather than forced to integers,
 * because this is a PLANNING figure, not a payout. Payout math lives in
 * jobSegments/shiftBreaks and stays in integer seconds. Mixing the two rounding
 * regimes is how a planning estimate quietly becomes a pay input.
 */
export function computeDayCapacity(date: string, jobs: ReadonlyArray<ScheduledJob>): DayCapacity {
  const perCrew: Record<string, number> = {};
  let unassignedHours = 0;
  let jobsWithoutEstimate = 0;
  let anyPlaceholderHours = false;

  for (const job of jobs) {
    if (job.budgetedHours === null) {
      // No estimate at all. Counted, not silently treated as zero: a day full of
      // unestimated jobs must not look like a free day.
      jobsWithoutEstimate += 1;
      continue;
    }
    if (job.hoursArePlaceholder) anyPlaceholderHours = true;

    if (job.crewMemberIds.length === 0) {
      unassignedHours += job.budgetedHours;
      continue;
    }
    const share = job.budgetedHours / job.crewMemberIds.length;
    for (const crewId of job.crewMemberIds) {
      perCrew[crewId] = (perCrew[crewId] ?? 0) + share;
    }
  }

  return { date, perCrew, unassignedHours, jobsWithoutEstimate, anyPlaceholderHours };
}

type AssignmentRow = {
  id: string;
  job_id: string;
  crew_member_id: string;
  assigned_date: string;
};

type JobRowForSchedule = {
  id: string;
  job_number: number | null;
  status: string;
  budgeted_hours: number | null;
  labor_revenue_cents: number | null;
  rates_are_placeholder: boolean;
};

/**
 * Row 356: a refusal the CALLER caused (unknown / inactive / office crew id),
 * as opposed to an infrastructure failure. The API route maps this to a 4xx
 * with the message verbatim, so a stale dropdown or a direct POST gets told
 * exactly why instead of a generic 500.
 */
export class AssignmentRefusedError extends Error {}

/**
 * Assign a crew member to a job for a day. Idempotent on the unique constraint.
 *
 * Row 356: the office/field boundary is enforced HERE, at the state change,
 * not only in `listActiveFieldCrew` feeding the dropdown — a direct POST, a
 * stale cached id, or a future integration must not be able to assign office
 * staff (or an inactive member) to a field job. The check-then-insert has a
 * benign TOCTOU window (someone deactivating the member mid-request), which
 * is fine: the guard exists to stop ids that are ALREADY wrong, and the FK
 * still guarantees the row references a real crew member.
 */
export async function assignCrewToJob(
  jobId: string,
  crewMemberId: string,
  assignedDate: string,
): Promise<Assignment | null> {
  if (!isCalendarDate(assignedDate)) {
    throw new Error(`assignCrewToJob: assignedDate must be YYYY-MM-DD, got ${assignedDate}`);
  }
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const { data: crewData, error: crewError } = await db
    .from('crew_members')
    .select('id, active, is_office')
    .eq('id', crewMemberId.trim())
    .maybeSingle();
  if (crewError) throw new Error(`assignCrewToJob: crew lookup: ${crewError.message}`);
  const crew = crewData as unknown as { id: string; active: boolean; is_office: boolean } | null;
  if (!crew) {
    throw new AssignmentRefusedError('Unknown crew member — refresh and pick from the current roster.');
  }
  if (crew.is_office) {
    // Same rule the dropdown enforces (listActiveFieldCrew): office staff are
    // operators, not installers, and must never land on a field job.
    throw new AssignmentRefusedError('Office staff cannot be assigned to field jobs.');
  }
  if (!crew.active) {
    throw new AssignmentRefusedError('That crew member is inactive and cannot be assigned.');
  }

  const { data, error } = await db
    .from('job_assignments')
    .insert({ job_id: jobId.trim(), crew_member_id: crewMemberId.trim(), assigned_date: assignedDate })
    .select('id, job_id, crew_member_id, assigned_date')
    .maybeSingle();

  if (error) {
    // Already assigned: return the existing row rather than erroring, so a
    // double-click on a calendar is harmless.
    if (error.code === '23505') {
      const { data: existing } = await db
        .from('job_assignments')
        .select('id, job_id, crew_member_id, assigned_date')
        .eq('job_id', jobId.trim())
        .eq('crew_member_id', crewMemberId.trim())
        .eq('assigned_date', assignedDate)
        .maybeSingle();
      const row = existing as unknown as AssignmentRow | null;
      return row
        ? {
            id: row.id,
            jobId: row.job_id,
            crewMemberId: row.crew_member_id,
            assignedDate: row.assigned_date,
          }
        : null;
    }
    throw new Error(`assignCrewToJob: ${error.message}`);
  }

  const row = data as unknown as AssignmentRow | null;
  return row
    ? {
        id: row.id,
        jobId: row.job_id,
        crewMemberId: row.crew_member_id,
        assignedDate: row.assigned_date,
      }
    : null;
}

/** Remove one assignment. Returns whether a row was actually removed. */
export async function unassignCrewFromJob(
  jobId: string,
  crewMemberId: string,
  assignedDate: string,
): Promise<boolean> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const { data, error } = await db
    .from('job_assignments')
    .delete()
    .eq('job_id', jobId.trim())
    .eq('crew_member_id', crewMemberId.trim())
    .eq('assigned_date', assignedDate)
    .select('id');

  if (error) throw new Error(`unassignCrewFromJob: ${error.message}`);
  return ((data as unknown as { id: string }[] | null) ?? []).length > 0;
}

/**
 * The schedule for a date range: which jobs are on which day, with whom, and the
 * resulting capacity.
 *
 * Both bounds are inclusive calendar dates in the business timezone.
 */
export async function getSchedule(
  fromDate: string,
  toDate: string,
): Promise<{ days: DayCapacity[]; jobsByDate: Record<string, ScheduledJob[]>; errors: string[] }> {
  const errors: string[] = [];
  if (!isCalendarDate(fromDate) || !isCalendarDate(toDate)) {
    return { days: [], jobsByDate: {}, errors: ['Dates must be YYYY-MM-DD'] };
  }

  const db = getSupabaseServiceClient();
  if (!db) return { days: [], jobsByDate: {}, errors: ['Supabase service role not configured'] };

  const { data: assignmentData, error: assignmentError } = await db
    .from('job_assignments')
    .select('id, job_id, crew_member_id, assigned_date')
    .gte('assigned_date', fromDate)
    .lte('assigned_date', toDate);

  if (assignmentError) {
    return { days: [], jobsByDate: {}, errors: [`assignment scan: ${assignmentError.message}`] };
  }

  const assignments = (assignmentData as unknown as AssignmentRow[] | null) ?? [];
  const jobIds = [...new Set(assignments.map((a) => a.job_id))];

  const jobs = new Map<string, JobRowForSchedule>();
  if (jobIds.length) {
    const { data: jobData, error: jobError } = await db
      .from('jobs')
      .select('id, job_number, status, budgeted_hours, labor_revenue_cents, rates_are_placeholder')
      .in('id', jobIds);
    if (jobError) errors.push(`job lookup: ${jobError.message}`);
    for (const j of (jobData as unknown as JobRowForSchedule[] | null) ?? []) jobs.set(j.id, j);
  }

  // Group by date, then by job.
  const jobsByDate: Record<string, ScheduledJob[]> = {};
  const byDateJob = new Map<string, Map<string, string[]>>();
  for (const a of assignments) {
    if (!byDateJob.has(a.assigned_date)) byDateJob.set(a.assigned_date, new Map());
    const forDate = byDateJob.get(a.assigned_date)!;
    forDate.set(a.job_id, [...(forDate.get(a.job_id) ?? []), a.crew_member_id]);
  }

  for (const [date, forDate] of byDateJob) {
    const list: ScheduledJob[] = [];
    for (const [jobId, crewMemberIds] of forDate) {
      const job = jobs.get(jobId);
      // The guardrail in action: hours are read through readLaborPlan, so a
      // placeholder figure arrives tagged rather than bare.
      const plan = job
        ? readLaborPlan(job as unknown as LaborPlanSource)
        : ({ status: 'none' } as const);
      list.push({
        jobId,
        jobNumber: job?.job_number ?? null,
        status: job?.status ?? 'unknown',
        budgetedHours: plan.status === 'none' ? null : plan.budgetedHours,
        hoursArePlaceholder: plan.status === 'placeholder',
        crewMemberIds,
      });
    }
    jobsByDate[date] = list;
  }

  const days = Object.keys(jobsByDate)
    .sort()
    .map((date) => computeDayCapacity(date, jobsByDate[date]!));

  return { days, jobsByDate, errors };
}

/**
 * Jobs that need scheduling: not cancelled, not done, and with no assignment on
 * or after `fromDate`. This is the "unscheduled work" list the plan calls for.
 */
export async function listUnscheduledJobs(fromDate: string): Promise<{
  jobs: Array<{ jobId: string; jobNumber: number | null; status: string; budgetedHours: number | null; hoursArePlaceholder: boolean }>;
  errors: string[];
}> {
  const db = getSupabaseServiceClient();
  if (!db) return { jobs: [], errors: ['Supabase service role not configured'] };

  const { data: assignedData, error: assignedError } = await db
    .from('job_assignments')
    .select('job_id')
    .gte('assigned_date', fromDate);
  if (assignedError) return { jobs: [], errors: [`assignment scan: ${assignedError.message}`] };

  const assigned = new Set(
    ((assignedData as unknown as { job_id: string }[] | null) ?? []).map((r) => r.job_id),
  );

  const { data: jobData, error: jobError } = await db
    .from('jobs')
    .select('id, job_number, status, budgeted_hours, labor_revenue_cents, rates_are_placeholder')
    .not('status', 'in', '(done,cancelled)');
  if (jobError) return { jobs: [], errors: [`job scan: ${jobError.message}`] };

  const jobs = ((jobData as unknown as JobRowForSchedule[] | null) ?? [])
    .filter((j) => !assigned.has(j.id))
    .map((j) => {
      const plan = readLaborPlan(j as unknown as LaborPlanSource);
      return {
        jobId: j.id,
        jobNumber: j.job_number,
        status: j.status,
        budgetedHours: plan.status === 'none' ? null : plan.budgetedHours,
        hoursArePlaceholder: plan.status === 'placeholder',
      };
    });

  return { jobs, errors: [] };
}
