import { getSupabaseServiceClient } from '@/lib/supabase';
import { etDayKey } from '@/lib/dashboard/inbox/normalize';
import { getSchedule } from '@/lib/scheduling';
import { listActiveCrewMembers } from '@/lib/crewMembers';
import type { CrewDayJob } from '@/lib/crew/dayDigest';

/**
 * The IO half of the daily crew schedule notification.
 *
 * The who-is-on-what pairing comes from getSchedule(), the SAME function the
 * schedule page reads, so the message cannot drift from the page. Addresses and
 * customer names are looked up separately because the schedule shape carries
 * neither.
 *
 * Shaped one row per JOB with its crew listed (Naldo, 2026-09-04), which is
 * also why there is no double-counting to correct: a job appears once.
 */

/** The business-timezone calendar day, matching what job_assignments stores. */
export function businessToday(now: Date = new Date()): string {
  return etDayKey(now);
}

export type CrewDayData = {
  date: string;
  jobs: CrewDayJob[];
  errors: string[];
};

export async function getCrewDay(date: string): Promise<CrewDayData> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const { jobsByDate, errors } = await getSchedule(date, date);
  const scheduled = jobsByDate[date] ?? [];
  if (!scheduled.length) return { date, jobs: [], errors };

  const jobIds = scheduled.map((j) => j.jobId);
  const { data: jobRows, error: jobErr } = await db
    .from('jobs')
    .select('id, property_id, customer_id')
    .in('id', jobIds);
  if (jobErr) errors.push(`job lookup: ${jobErr.message}`);
  const rows =
    (jobRows as unknown as { id: string; property_id: string | null; customer_id: string | null }[] | null) ?? [];

  // Addresses. A job whose property or address is missing still appears; the
  // message says the address is not on file rather than dropping a job somebody
  // is expected at.
  const addressByJob = new Map<string, string | null>();
  const propertyIds = [...new Set(rows.map((r) => r.property_id).filter((v): v is string => !!v))];
  if (propertyIds.length) {
    const { data, error } = await db.from('properties').select('id, address').in('id', propertyIds);
    if (error) errors.push(`property lookup: ${error.message}`);
    const byId = new Map(((data as unknown as { id: string; address: string | null }[] | null) ?? []).map((p) => [p.id, p.address]));
    for (const r of rows) addressByJob.set(r.id, r.property_id ? (byId.get(r.property_id) ?? null) : null);
  }

  // Whose house it is.
  const nameByJob = new Map<string, string | null>();
  const customerIds = [...new Set(rows.map((r) => r.customer_id).filter((v): v is string => !!v))];
  if (customerIds.length) {
    const { data, error } = await db.from('customers').select('id, name').in('id', customerIds);
    if (error) errors.push(`customer lookup: ${error.message}`);
    const byId = new Map(((data as unknown as { id: string; name: string | null }[] | null) ?? []).map((c) => [c.id, c.name]));
    for (const r of rows) nameByJob.set(r.id, r.customer_id ? (byId.get(r.customer_id) ?? null) : null);
  }

  let crewNames = new Map<string, string>();
  try {
    crewNames = new Map((await listActiveCrewMembers()).map((c) => [c.id, c.displayName]));
  } catch (err) {
    errors.push(`crew lookup: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A missing name is either a deactivated crew member or a FAILED roster read.
  // Either way the id keeps two unnamed people apart, which a single shared
  // placeholder would not.
  const crewLabel = (id: string): string => crewNames.get(id) ?? `Crew ${id.slice(0, 8)}`;

  const jobs: CrewDayJob[] = scheduled
    .map((j) => ({
      jobNumber: j.jobNumber,
      customerName: nameByJob.get(j.jobId) ?? null,
      address: addressByJob.get(j.jobId) ?? null,
      status: j.status,
      // Sorted so the same job reads the same way every morning.
      crew: j.crewMemberIds.map(crewLabel).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => (a.jobNumber ?? Number.MAX_SAFE_INTEGER) - (b.jobNumber ?? Number.MAX_SAFE_INTEGER));

  return { date, jobs, errors };
}
