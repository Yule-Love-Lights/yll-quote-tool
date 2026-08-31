import { getSupabaseServiceClient } from '@/lib/supabase';
import { etDayKey } from '@/lib/dashboard/inbox/normalize';
import { getSchedule } from '@/lib/scheduling';
import { listActiveCrewMembers } from '@/lib/crewMembers';
import type { CrewDayGroup, CrewDayJob } from '@/lib/crew/dayDigest';

/**
 * The IO half of the daily crew schedule notification.
 *
 * The who-is-on-what pairing comes from getSchedule(), the SAME function the
 * schedule page reads, so the message cannot drift from the page. Addresses are
 * looked up separately because the schedule shape does not carry them.
 */

/** The business-timezone calendar day, matching what job_assignments stores. */
export function businessToday(now: Date = new Date()): string {
  return etDayKey(now);
}

export type CrewDayData = {
  date: string;
  groups: CrewDayGroup[];
  unassigned: CrewDayJob[];
  errors: string[];
};

export async function getCrewDay(date: string): Promise<CrewDayData> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const { jobsByDate, errors } = await getSchedule(date, date);
  const scheduled = jobsByDate[date] ?? [];
  if (!scheduled.length) return { date, groups: [], unassigned: [], errors };

  // Addresses, via each job's property. A job whose property or address is
  // missing still appears; the message says the address is not on file rather
  // than dropping a job somebody is expected at.
  const jobIds = scheduled.map((j) => j.jobId);
  const addressByJob = new Map<string, string | null>();
  const { data: jobRows, error: jobErr } = await db
    .from('jobs')
    .select('id, property_id')
    .in('id', jobIds);
  if (jobErr) errors.push(`job lookup: ${jobErr.message}`);

  const rows = (jobRows as unknown as { id: string; property_id: string | null }[] | null) ?? [];
  const propertyIds = [...new Set(rows.map((r) => r.property_id).filter((v): v is string => !!v))];
  if (propertyIds.length) {
    const { data: props, error: propErr } = await db
      .from('properties')
      .select('id, address')
      .in('id', propertyIds);
    if (propErr) errors.push(`property lookup: ${propErr.message}`);
    const addressById = new Map(
      ((props as unknown as { id: string; address: string | null }[] | null) ?? []).map((p) => [p.id, p.address]),
    );
    for (const r of rows) {
      addressByJob.set(r.id, r.property_id ? (addressById.get(r.property_id) ?? null) : null);
    }
  }

  let crewNames = new Map<string, string>();
  try {
    crewNames = new Map((await listActiveCrewMembers()).map((c) => [c.id, c.displayName]));
  } catch (err) {
    errors.push(`crew lookup: ${err instanceof Error ? err.message : String(err)}`);
  }

  const asJob = (j: (typeof scheduled)[number]): CrewDayJob => ({
    jobNumber: j.jobNumber,
    address: addressByJob.get(j.jobId) ?? null,
    status: j.status,
  });

  const byCrew = new Map<string, CrewDayJob[]>();
  const unassigned: CrewDayJob[] = [];
  for (const j of scheduled) {
    if (!j.crewMemberIds.length) {
      unassigned.push(asJob(j));
      continue;
    }
    for (const crewId of j.crewMemberIds) {
      const list = byCrew.get(crewId) ?? [];
      list.push(asJob(j));
      byCrew.set(crewId, list);
    }
  }

  const groups: CrewDayGroup[] = [...byCrew.entries()]
    // A crew member missing from the roster read still gets their jobs listed
    // under a placeholder: losing a name must never lose a job.
    .map(([crewId, jobs]) => ({ crewName: crewNames.get(crewId) ?? 'Unnamed crew member', jobs }))
    .sort((a, b) => a.crewName.localeCompare(b.crewName));

  return { date, groups, unassigned, errors };
}
