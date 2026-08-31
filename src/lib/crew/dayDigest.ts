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
  const header = `Today's schedule, ${humanDate(date)}`;

  if (!groups.length && !unassigned.length) {
    // A failed read collapses the day to empty, and an all-clear on a busy
    // morning is the worst thing this message can do. Say which one this is.
    return [
      header,
      '',
      readFailed
        ? 'Could not read the schedule this morning, so jobs may be missing from this list. Check the schedule in the app before heading out.'
        : 'Nothing on the schedule for today.',
    ].join('\n');
  }

  const warning = readFailed
    ? '\n\nSome details could not be read this morning, so this list may be incomplete. Check the schedule in the app.'
    : '';

  // The budget covers the WHOLE message, not just the job lines: the trailing
  // warning and the "…and N more" footer are reserved BEFORE any line is
  // placed, and every section heading is counted as it is added. The earlier
  // cut gated job lines only, so its own "hard character budget" comment
  // promised more than it delivered (delta-verify, PR #1129).
  const FOOTER_RESERVE = 40;
  const budget = MAX_CHARS - warning.length - FOOTER_RESERVE;

  const lines: string[] = [header];
  let printed = 0;
  let dropped = 0;

  const fits = (line: string): boolean =>
    printed < MAX_JOB_LINES && charCount(lines) + line.length <= budget;

  const section = (title: (shown: number, total: number) => string, jobs: CrewDayJob[]): void => {
    const rendered: string[] = [];
    for (const job of jobs) {
      const line = jobLine(job);
      // Count the heading too, so a section cannot be opened that leaves no
      // room for its own jobs.
      if (!fits(line) || charCount([...lines, title(rendered.length, jobs.length), ...rendered]) + line.length > budget) {
        dropped += 1;
        continue;
      }
      rendered.push(line);
      printed += 1;
    }
    if (!rendered.length) return;
    lines.push('', title(rendered.length, jobs.length), ...rendered);
  };

  for (const group of groups) {
    // A header claiming five jobs above three printed lines reads as a whole
    // day. When the cap bites, the heading says how many are actually shown.
    section(
      (shown, total) =>
        `${group.crewName} — ${total} ${total === 1 ? 'job' : 'jobs'}${shown < total ? ` (${shown} shown)` : ''}`,
      group.jobs,
    );
  }

  section(
    (shown, total) => `Nobody assigned yet — ${total}${shown < total ? ` (${shown} shown)` : ''}`,
    unassigned,
  );

  // Never silently truncate: a message that dropped rows says how many, so a
  // busy day reads as capped rather than as a short schedule.
  if (dropped) lines.push('', `…and ${dropped} more not shown.`);

  // Same rule as the empty case: a partial read must never read as a complete
  // day. It rides at the END so the jobs are seen first on a phone.
  return lines.join('\n') + warning;
}
