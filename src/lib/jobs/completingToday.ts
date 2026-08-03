// src/lib/jobs/completingToday.ts
// PURE date + message-building for the "completing today" cron
// (src/app/api/jobs/completing-today/route.ts). No IO — the route runs the
// jobs.install_date query and passes rows in here. install_date isn't written
// by any feature yet (scheduling will start writing it later), so an empty day
// is normal, not an error: completingTodayMessage returns null to mean "send
// nothing" (a daily "all clear" would spam the chat forever until that lands).

export type CompletingTodayJob = {
  id: string;
  jobNumber: number | null;
  customerName: string | null;
  customerAddress: string | null;
};

/**
 * Today's date as YYYY-MM-DD in the America/New_York calendar (matches the
 * `jobs.install_date` DATE column). Takes an injectable clock for tests.
 */
export function nyDateString(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
}

/**
 * Jobs whose install_date is today's NY date, excluding 'done' and
 * 'cancelled'. The route queries by install_date at the DB level (cheap,
 * indexed) and runs this as the single source of truth for the status
 * inclusion rule, so it's covered by a plain unit test instead of only living
 * inside a Supabase query string. Generic so the route's richer row shape
 * (job number, customer ids, ...) survives filtering untouched.
 */
export function filterCompletingToday<T extends { installDate: string | null; status: string }>(
  jobs: T[],
  today: string,
): T[] {
  return jobs.filter((j) => j.installDate === today && j.status !== 'done' && j.status !== 'cancelled');
}

/**
 * The daily "completing today" ping text, or null when there's nothing to
 * send (the caller must not send anything in that case — see header).
 */
export function completingTodayMessage(jobs: CompletingTodayJob[], baseUrl: string): string | null {
  if (!jobs.length) return null;
  const lines = ['🔨 Jobs completing today'];
  lines.push(
    ...jobs.map((j) => {
      const who = j.customerName?.trim() || 'Customer';
      const addr = j.customerAddress?.trim();
      return `#${j.jobNumber ?? '—'} ${who}${addr ? ` — ${addr}` : ''}`;
    }),
  );
  lines.push(`Jobs → ${baseUrl}/admin/jobs`);
  return lines.join('\n');
}
