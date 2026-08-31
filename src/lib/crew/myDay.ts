import { getSupabaseServiceClient } from '@/lib/supabase';
import { etDayKey } from '@/lib/dashboard/inbox/normalize';

/**
 * My Day: what one crew member is assigned to today.
 *
 * Read-only, and deliberately money-free (workstream C constraint): the shape
 * below has no rate, no hours and no pay field, so no later edit can leak
 * payroll onto a surface the whole crew can open on a phone.
 *
 * "Today" is a BUSINESS-timezone calendar day, matching `job_assignments`,
 * which stores a DATE for exactly that reason.
 */

export type MyDayAssignmentRow = { id: string; job_id: string; assigned_date: string };
export type MyDayJobRow = { id: string; job_number: number | null; status: string | null; property_id: string | null };
export type MyDayPropertyRow = { id: string; address: string | null };

export type MyDayItem = {
  assignmentId: string;
  jobId: string;
  jobNumber: number | null;
  status: string | null;
  address: string | null;
};

/** PURE: join the three reads into the crew member's list for the day. */
export function shapeMyDay(
  assignments: ReadonlyArray<MyDayAssignmentRow>,
  jobs: ReadonlyArray<MyDayJobRow>,
  properties: ReadonlyArray<MyDayPropertyRow>,
): MyDayItem[] {
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const addressById = new Map(properties.map((p) => [p.id, p.address]));

  const items: MyDayItem[] = [];
  for (const a of assignments) {
    const j = jobById.get(a.job_id);
    if (!j) continue; // an assignment with no job row is a broken read, not a stop
    items.push({
      assignmentId: a.id,
      jobId: j.id,
      jobNumber: j.job_number,
      status: j.status,
      address: j.property_id ? (addressById.get(j.property_id) ?? null) : null,
    });
  }
  return items.sort((x, y) => (x.jobNumber ?? 0) - (y.jobNumber ?? 0));
}

/** The business-timezone calendar day, the same key `job_assignments` stores. */
export function businessToday(now: Date = new Date()): string {
  return etDayKey(now);
}

/** Today's assignments for one crew member. Returns [] when nothing is
 * scheduled, and throws only on a real read failure. */
export async function getMyDay(crewMemberId: string, date: string): Promise<MyDayItem[]> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const { data: assignmentData, error: assignmentError } = await db
    .from('job_assignments')
    .select('id, job_id, assigned_date')
    .eq('crew_member_id', crewMemberId)
    .eq('assigned_date', date);
  if (assignmentError) throw new Error(`getMyDay assignments: ${assignmentError.message}`);

  const assignments = (assignmentData as unknown as MyDayAssignmentRow[] | null) ?? [];
  if (!assignments.length) return [];

  const jobIds = [...new Set(assignments.map((a) => a.job_id))];
  const { data: jobData, error: jobError } = await db
    .from('jobs')
    .select('id, job_number, status, property_id')
    .in('id', jobIds);
  if (jobError) throw new Error(`getMyDay jobs: ${jobError.message}`);
  const jobs = (jobData as unknown as MyDayJobRow[] | null) ?? [];

  const propertyIds = [...new Set(jobs.map((j) => j.property_id).filter((v): v is string => !!v))];
  let properties: MyDayPropertyRow[] = [];
  if (propertyIds.length) {
    const { data: propData, error: propError } = await db
      .from('properties')
      .select('id, address')
      .in('id', propertyIds);
    if (propError) throw new Error(`getMyDay properties: ${propError.message}`);
    properties = (propData as unknown as MyDayPropertyRow[] | null) ?? [];
  }

  return shapeMyDay(assignments, jobs, properties);
}
