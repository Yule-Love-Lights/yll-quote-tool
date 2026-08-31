// PURE message-building for the daily crew schedule notification
// (src/app/api/ops/crew-day-digest/route.ts). No IO: the route reads the day
// through getSchedule() — the SAME function the schedule page uses — and passes
// the shaped groups in here, so the message and the page can never disagree
// about who is where.
//
// Deliberately money-free, like the My Day surface: no rate, no hours, no pay.
// This goes to a crew-facing chat, and hours on a job are an office number.

export type CrewDayJob = {
  jobNumber: number | null;
  address: string | null;
  status: string | null;
};

export type CrewDayGroup = {
  crewName: string;
  jobs: CrewDayJob[];
};

// Telegram rejects a message over ~4096 characters. Job lines here run well
// under 100 characters, so 40 of them stays clear of the limit with room for
// the headers (the same cap the inventory prep digest uses, same reason).
const MAX_JOB_LINES = 40;

function jobLine(job: CrewDayJob): string {
  const number = job.jobNumber === null ? 'Job' : `#${job.jobNumber}`;
  const where = job.address?.trim() || 'address not on file';
  return `${number} ${where}`;
}

/**
 * The day's schedule as one message: each crew member with their jobs, then
 * anything nobody is on yet. A quiet day still sends a one-line all-clear, so
 * silence always means the cron failed rather than "nothing today".
 */
export function crewDayDigestMessage(
  date: string,
  groups: CrewDayGroup[],
  unassigned: CrewDayJob[],
): string {
  const lines: string[] = [`Today's schedule — ${date}`];

  if (!groups.length && !unassigned.length) {
    lines.push('', 'Nothing on the schedule for today.');
    return lines.join('\n');
  }

  let printed = 0;
  let dropped = 0;

  for (const group of groups) {
    lines.push('', `${group.crewName} — ${group.jobs.length} ${group.jobs.length === 1 ? 'job' : 'jobs'}`);
    for (const job of group.jobs) {
      if (printed >= MAX_JOB_LINES) {
        dropped += 1;
        continue;
      }
      lines.push(jobLine(job));
      printed += 1;
    }
  }

  if (unassigned.length) {
    lines.push('', `Nobody assigned yet — ${unassigned.length}`);
    for (const job of unassigned) {
      if (printed >= MAX_JOB_LINES) {
        dropped += 1;
        continue;
      }
      lines.push(jobLine(job));
      printed += 1;
    }
  }

  // Never silently truncate: a message that dropped rows says how many, so a
  // busy day reads as capped rather than as a short schedule.
  if (dropped) lines.push('', `…and ${dropped} more not shown.`);

  return lines.join('\n');
}
