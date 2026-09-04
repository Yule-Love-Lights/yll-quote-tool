// PURE message-building for the daily crew schedule notification
// (src/app/api/ops/crew-day-digest/route.ts). No IO: the route reads the day
// through getSchedule() -- the SAME function the schedule page reads -- and
// passes the shaped jobs in here, so the message and the page can never
// disagree about who is where.
//
// One block per JOB, with everyone on it underneath (Naldo, 2026-09-04). The
// first cut grouped by crew member, which repeated a shared job once per
// person; three people on one job produced three near-identical blocks.
//
// Deliberately money-free, like the My Day surface: no rate, no hours, no pay.
// This goes to a crew-facing chat, and hours on a job are an office number.

export type CrewDayJob = {
  jobNumber: number | null;
  customerName: string | null;
  address: string | null;
  status: string | null;
  /** Everyone assigned to this job today, in a stable order. */
  crew: string[];
};

// Telegram rejects a message over ~4096 characters. The budget covers the
// WHOLE message: the trailing warning and the "and N more" footer are reserved
// before any job block is placed.
const MAX_CHARS = 3500;
const FOOTER_RESERVE = 40;

// Jobs nobody should drive to. Shown rather than filtered out, because a job
// vanishing reads as an app fault to someone told yesterday to be there.
// Cancelling a job does NOT remove its assignment row.
const CALLED_OFF: ReadonlySet<string> = new Set(['cancelled', 'done']);

/** "Friday, Sep 4" rather than a raw 2026-09-04: this is read on a phone.
 * Parsed as a plain calendar date, which is what job_assignments stores. */
function humanDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function headline(job: CrewDayJob): string {
  const number = job.jobNumber === null ? 'Job' : `#${job.jobNumber}`;
  // Customer then address, comma separated, with the customer simply absent
  // when there is none rather than leaving a gap or a stray comma.
  const where = [job.customerName?.trim() || null, job.address?.trim() || 'address not on file']
    .filter((part): part is string => !!part)
    .join(', ');
  const flag =
    job.status && CALLED_OFF.has(job.status)
      ? job.status === 'cancelled'
        ? '  <- CANCELLED, do not go'
        : '  <- already finished, do not go'
      : '';
  return `${number} ${where}${flag}`;
}

/** Characters the message holds so far, newlines included. */
function charCount(lines: string[]): number {
  return lines.reduce((n, l) => n + l.length + 1, 0);
}

/**
 * The day's schedule as one message: each job once, with its crew underneath.
 * A quiet day still sends a one-line all-clear, so silence always means the
 * cron failed rather than "nothing today".
 */
export function crewDayDigestMessage(
  date: string,
  jobs: CrewDayJob[],
  errors: string[] = [],
): string {
  const readFailed = errors.length > 0;
  const header = `Today's schedule, ${humanDate(date)}`;

  if (!jobs.length) {
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
  const budget = MAX_CHARS - warning.length - FOOTER_RESERVE;

  const lines: string[] = [header];
  let dropped = 0;

  for (const job of jobs) {
    const block = [headline(job), ...(job.crew.length ? job.crew : ['Nobody assigned yet'])];
    // A block is placed whole or not at all: half a job, with some of its crew
    // missing, would read as the full crew for that job.
    if (charCount([...lines, '', ...block]) > budget) {
      dropped += 1;
      continue;
    }
    lines.push('', ...block);
  }

  if (dropped) lines.push('', `...and ${dropped} more not shown.`);

  return lines.join('\n') + warning;
}
