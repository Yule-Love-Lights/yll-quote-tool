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

// A hard character budget as well as a line cap: an address has no length
// limit in the database, so 40 lines is not by itself a guarantee (technical
// lens, PR #1129). Telegram's own limit is ~4096.
const MAX_CHARS = 3500;

/** Characters the message holds so far, newlines included. */
function charCount(lines: string[]): number {
  return lines.reduce((n, l) => n + l.length + 1, 0);
}

// Jobs nobody should drive to. They are shown rather than filtered out,
// because a job vanishing reads as an app fault to someone who was told
// yesterday to be there. Cancelling a job does NOT remove its assignment row,
// so without this flag a cancelled job reaches the crew looking ordinary
// (staff lens, PR #1129).
const CALLED_OFF: ReadonlySet<string> = new Set(['cancelled', 'done']);

/** "Friday, Aug 29" rather than a raw 2026-08-29: this is read on a phone by
 * someone who wants the day, not an ISO string. Parsed as a plain calendar
 * date (no timezone shift), because that is what job_assignments stores. */
function humanDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function jobLine(job: CrewDayJob): string {
  const number = job.jobNumber === null ? 'Job' : `#${job.jobNumber}`;
  const where = job.address?.trim() || 'address not on file';
  const flag =
    job.status && CALLED_OFF.has(job.status)
      ? job.status === 'cancelled'
        ? '  ← CANCELLED, do not go'
        : '  ← already finished, do not go'
      : '';
  return `${number} ${where}${flag}`;
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
  errors: string[] = [],
): string {
  const readFailed = errors.length > 0;
  const lines: string[] = [`Today's schedule, ${humanDate(date)}`];

  if (!groups.length && !unassigned.length) {
    // A failed read collapses the day to empty, and an all-clear on a busy
    // morning is the worst thing this message can do. Say which one this is.
    lines.push(
      '',
      readFailed
        ? 'Could not read the schedule this morning, so jobs may be missing from this list. Check the schedule in the app before heading out.'
        : 'Nothing on the schedule for today.',
    );
    return lines.join('\n');
  }

  let printed = 0;
  let dropped = 0;

  for (const group of groups) {
    lines.push('', `${group.crewName} — ${group.jobs.length} ${group.jobs.length === 1 ? 'job' : 'jobs'}`);
    for (const job of group.jobs) {
      const line = jobLine(job);
      if (printed >= MAX_JOB_LINES || charCount(lines) + line.length > MAX_CHARS) {
        dropped += 1;
        continue;
      }
      lines.push(line);
      printed += 1;
    }
  }

  if (unassigned.length) {
    lines.push('', `Nobody assigned yet — ${unassigned.length}`);
    for (const job of unassigned) {
      const line = jobLine(job);
      if (printed >= MAX_JOB_LINES || charCount(lines) + line.length > MAX_CHARS) {
        dropped += 1;
        continue;
      }
      lines.push(line);
      printed += 1;
    }
  }

  // Never silently truncate: a message that dropped rows says how many, so a
  // busy day reads as capped rather than as a short schedule.
  if (dropped) lines.push('', `…and ${dropped} more not shown.`);

  // Same rule as the empty case: a partial read must never read as a complete
  // day. It rides at the END so the jobs are seen first on a phone.
  if (readFailed) {
    lines.push(
      '',
      'Some details could not be read this morning, so this list may be incomplete. Check the schedule in the app.',
    );
  }

  return lines.join('\n');
}
