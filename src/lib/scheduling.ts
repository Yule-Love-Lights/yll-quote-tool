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

  // NALDO'S RULE, 2026-08-27: a job cannot go on the schedule unless its
  // property has verified coordinates. This is what makes the GPS timeline
  // trustworthy by construction — a scheduled job can always be watched, so a
  // missing timeline can never be mistaken for a crew that did not show up.
  // The fix path is the geocode fix-list: correct the address there and it
  // verifies on save. Enforced HERE at the write, per the row-356 precedent:
  // a dropdown filter alone would not stop a direct POST or a stale id.
  const { data: jobData, error: jobError } = await db
    .from('jobs')
    .select('id, property_id')
    .eq('id', jobId.trim())
    .maybeSingle();
  if (jobError) throw new Error(`assignCrewToJob: job lookup: ${jobError.message}`);
  const job = jobData as unknown as { id: string; property_id: string | null } | null;
  if (!job) throw new AssignmentRefusedError('Unknown job.');
  if (!job.property_id) {
    throw new AssignmentRefusedError(
      'This job has no property linked, so it cannot be scheduled until it does.',
    );
  }
  const { data: propData, error: propError } = await db
    .from('properties')
    .select('id, lat, lng')
    .eq('id', job.property_id)
    .maybeSingle();
  if (propError) throw new Error(`assignCrewToJob: property lookup: ${propError.message}`);
  const prop = propData as unknown as { id: string; lat: number | null; lng: number | null } | null;
  if (!prop || prop.lat == null || prop.lng == null) {
    throw new AssignmentRefusedError(
      'This property has no verified coordinates yet. Fix its address on the geocoding page, then schedule it.',
    );
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
  jobs: Array<{
    jobId: string;
    jobNumber: number | null;
    status: string;
    budgetedHours: number | null;
    hoursArePlaceholder: boolean;
    /** Whose job it is, so the list can be searched by eye. Null when the job
     * has no linked customer or the lookup failed. */
    customerName: string | null;
    /** Where it is, same reason. */
    address: string | null;
  }>;
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
    .select('id, job_number, status, budgeted_hours, labor_revenue_cents, rates_are_placeholder, customer_id, property_id')
    .not('status', 'in', '(done,cancelled)');
  if (jobError) return { jobs: [], errors: [`job scan: ${jobError.message}`] };

  // Who and where, so a staffer can find "the Smith job" by eye instead of
  // detouring to /admin/jobs for its number first (staff lens, PR #1210). A
  // failed lookup leaves the field null and lands in errors; it never drops a
  // job from the list.
  const errors: string[] = [];
  const rows = (jobData as unknown as Array<JobRowForSchedule & { customer_id: string | null; property_id: string | null }> | null) ?? [];
  const open = rows.filter((j) => !assigned.has(j.id));

  const customerIds = [...new Set(open.map((j) => j.customer_id).filter((v): v is string => !!v))];
  const nameById = new Map<string, string | null>();
  if (customerIds.length) {
    const { data, error } = await db.from('customers').select('id, name').in('id', customerIds);
    if (error) errors.push(`customer lookup: ${error.message}`);
    for (const c of ((data as unknown as { id: string; name: string | null }[] | null) ?? [])) nameById.set(c.id, c.name);
  }

  const propertyIds = [...new Set(open.map((j) => j.property_id).filter((v): v is string => !!v))];
  const addressById = new Map<string, string | null>();
  if (propertyIds.length) {
    const { data, error } = await db.from('properties').select('id, address').in('id', propertyIds);
    if (error) errors.push(`property lookup: ${error.message}`);
    for (const p of ((data as unknown as { id: string; address: string | null }[] | null) ?? [])) addressById.set(p.id, p.address);
  }

  const jobs = open
    // NEWEST first. The page truncates this list, and unordered it put a job
    // created minutes ago at position 41 of 43, past the cut, with nothing on
    // screen saying more existed (Naldo hit exactly this with job #1069,
    // 2026-09-04). A job with no number sorts last rather than to the top,
    // where a null would otherwise win the comparison.
    .sort((a, b) => {
      // Explicit null handling rather than an -Infinity trick: with BOTH
      // numbers null that subtraction is NaN, which is not a valid comparator
      // return. V8 happens to keep those rows in stable order, but relying on
      // that is a tradeoff nobody should have to rediscover (technical lens).
      const an = a.job_number;
      const bn = b.job_number;
      if (an == null && bn == null) return 0;
      if (an == null) return 1;
      if (bn == null) return -1;
      return bn - an;
    })
    .map((j) => {
      const plan = readLaborPlan(j as unknown as LaborPlanSource);
      return {
        jobId: j.id,
        jobNumber: j.job_number,
        status: j.status,
        budgetedHours: plan.status === 'none' ? null : plan.budgetedHours,
        hoursArePlaceholder: plan.status === 'placeholder',
        customerName: j.customer_id ? (nameById.get(j.customer_id) ?? null) : null,
        address: j.property_id ? (addressById.get(j.property_id) ?? null) : null,
      };
    });

  return { jobs, errors };
}

/**
 * Pre-archive check for a property. The geocode fix-list's Archive button asks
 * before hiding a property: an archived property leaves the fix-list, and the
 * fix-list is the ONLY path to ever giving that property coordinates — so
 * archiving one with a job would make the job permanently unschedulable and
 * invisible (Naldo hit exactly this shape with job #1045).
 *
 * OWNERSHIP IS PART OF THE CHECK, not an afterthought: the property must
 * belong to the given customer, or the answer is 'not-found' — the same opaque
 * result a mismatched pair got before this guard existed. Answering the jobs
 * question for a property the caller did not name correctly would let any
 * operator probe whether a foreign property id has jobs (the 409-vs-404
 * oracle a review lens caught on the first cut of this guard).
 *
 * JOBS ARE NOT THE ONLY DOOR (admin lens on PR #1054): a LIVE-pipeline quote
 * (sent, viewed, approved, booked) converts into a job when the deposit lands,
 * and createJobFromQuote copies property_id off the quote with no archived
 * check — so archiving such a property strands the FUTURE job the same way.
 * Draft, abandoned, and dead quotes do not block: those are exactly the
 * import-garbage rows the Archive button exists for. Measured 2026-08-28: the
 * fix-list's properties carried 6 booked / 3 viewed / 2 sent live quotes
 * beside 4 draft / 1 abandoned.
 *
 * Fails SAFE: any lookup error reports 'blocked' (refuses the archive).
 * Refusing an archive is a retry; hiding a real job is not.
 */
export async function propertyArchiveBlock(
  customerId: string,
  propertyId: string,
): Promise<'not-found' | 'has-jobs' | 'has-live-quote' | 'clear'> {
  const db = getSupabaseServiceClient();
  if (!db) return 'has-jobs';
  const { data: propData, error: propError } = await db
    .from('properties')
    .select('id')
    .eq('id', propertyId)
    .eq('customer_id', customerId)
    .maybeSingle();
  if (propError) {
    console.error('propertyArchiveBlock: property lookup failed:', propError.message);
    return 'has-jobs';
  }
  if (!propData) return 'not-found';
  const { data: jobData, error: jobError } = await db
    .from('jobs')
    .select('id')
    .eq('property_id', propertyId)
    .limit(1);
  if (jobError) {
    console.error('propertyArchiveBlock: jobs lookup failed:', jobError.message);
    return 'has-jobs';
  }
  if (((jobData as unknown as { id: string }[] | null) ?? []).length > 0) return 'has-jobs';
  const { data: quoteData, error: quoteError } = await db
    .from('quotes')
    .select('id')
    .eq('property_id', propertyId)
    .in('status', ['sent', 'viewed', 'approved', 'booked'])
    .limit(1);
  if (quoteError) {
    console.error('propertyArchiveBlock: quotes lookup failed:', quoteError.message);
    return 'has-live-quote';
  }
  if (((quoteData as unknown as { id: string }[] | null) ?? []).length > 0) return 'has-live-quote';
  return 'clear';
}
