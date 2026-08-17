import { getSupabaseServiceClient } from '@/lib/supabase';
import { etDayKey } from '@/lib/dashboard/inbox/normalize';
import { closeOpenBreakForShift } from '@/lib/shiftBreaks';
import { closeOpenSegmentForShift } from '@/lib/jobSegments';

/**
 * Midnight auto-close for forgotten days (contract section 4).
 *
 * "Midnight (America/New_York) auto-closes forgotten days AND is independent of
 * the Hub's Placement Run midnight reconciliation."
 *
 * WHY IT EXISTS: with manual punches authoritative for pay, a forgotten
 * clock-out means an open shift keeps accruing paid time indefinitely. And
 * because `shifts` allows exactly ONE open row per person, a forgotten clock-out
 * also blocks the next day's clock-in — the crew member cannot start work. So
 * this is both a pay-correctness and an availability problem.
 *
 * THREE RULES IT FOLLOWS:
 *
 * 1. BUSINESS TIMEZONE, never UTC. The day boundary is ET. This repo has already
 *    been bitten by a UTC-vs-ET day window landing on the wrong calendar day.
 * 2. IDEMPOTENT. Every write is guarded on the row still being open, so a second
 *    run closes nothing twice and cannot move a recorded time. Safe to retry and
 *    safe if the cron double-fires.
 * 3. FLAGS RATHER THAN TIDIES. Everything it closes is marked machine-closed
 *    (`close_source: 'system'`, plus `auto_closed` on breaks and segments) so a
 *    forgotten clock-out surfaces for review instead of looking like a normal
 *    day. An auto-closed day is a REVIEW state, not a correct one.
 */

const ET_TIME_ZONE = 'America/New_York';

/** The ET UTC offset, in minutes, in effect at `instant`. */
function etOffsetMinutes(instant: Date): number {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TIME_ZONE,
    timeZoneName: 'longOffset',
  })
    .formatToParts(instant)
    .find((p) => p.type === 'timeZoneName')?.value;

  // "GMT-04:00" / "GMT-5" / "GMT"
  const parsed = (name ?? '').match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!parsed) return 0;
  const sign = parsed[1] === '-' ? -1 : 1;
  return sign * (Number(parsed[2]) * 60 + Number(parsed[3] ?? 0));
}

function addDays(dayKey: string, days: number): string {
  const [y, mo, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, mo! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * The instant of ET midnight that ENDS the ET day containing `instant` — that is,
 * 00:00 ET on the following calendar day.
 *
 * DST is handled by probing the offset at NOON of the target day rather than at
 * midnight itself. A spring-forward transition happens at 02:00 local, so noon is
 * safely past it and yields the offset that actually applies to that day;
 * probing at the boundary can land inside the discontinuity.
 */
export function etMidnightAfter(instant: Date): Date {
  const nextDay = addDays(etDayKey(instant), 1);
  const noonProbe = new Date(`${nextDay}T12:00:00Z`);
  const offset = etOffsetMinutes(noonProbe);

  // Midnight ET expressed as UTC = 00:00 on that date minus the ET offset.
  return new Date(Date.parse(`${nextDay}T00:00:00Z`) - offset * 60_000);
}

/** True when `clockInAt` falls on an ET calendar day EARLIER than `now`'s. */
export function isStaleForEtDay(clockInAt: string, now: Date): boolean {
  const opened = new Date(clockInAt);
  // An unparseable timestamp is itself a data problem worth surfacing, so treat
  // it as stale rather than leaving the row open forever.
  if (Number.isNaN(opened.getTime())) return true;
  return etDayKey(opened) < etDayKey(now);
}

export type MidnightCloseResult = {
  scanned: number;
  shiftsClosed: number;
  breaksClosed: number;
  segmentsClosed: number;
  /** Shift ids closed, so the caller can log or digest them for review. */
  closedShiftIds: string[];
  errors: string[];
};

type OpenShiftRow = {
  id: string;
  crew_member_id: string;
  clock_in_at: string;
};

/**
 * Close every shift left open from a previous ET day, plus any break or job
 * segment still open under it.
 *
 * Closes at the ET midnight that ENDED that shift's own day, not at "now". A
 * shift forgotten three days ago must not be credited with three days of pay —
 * the ceiling is the end of the day it belonged to. That is the entire point.
 */
export async function closeForgottenDays(now: Date = new Date()): Promise<MidnightCloseResult> {
  const result: MidnightCloseResult = {
    scanned: 0,
    shiftsClosed: 0,
    breaksClosed: 0,
    segmentsClosed: 0,
    closedShiftIds: [],
    errors: [],
  };

  const db = getSupabaseServiceClient();
  if (!db) {
    result.errors.push('Supabase service role not configured');
    return result;
  }

  const { data, error } = await db
    .from('shifts')
    .select('id, crew_member_id, clock_in_at')
    .is('clock_out_at', null);

  if (error) {
    result.errors.push(`open-shift scan failed: ${error.message}`);
    return result;
  }

  const open = ((data as unknown as OpenShiftRow[] | null) ?? []).filter((row) =>
    isStaleForEtDay(row.clock_in_at, now),
  );
  result.scanned = open.length;

  for (const shift of open) {
    const closeAt = etMidnightAfter(new Date(shift.clock_in_at)).toISOString();

    // Children first: a break or segment must never outlive its shift. Each write
    // is guarded on still being open, so re-running is safe.
    try {
      if (await closeOpenBreakForShift(shift.id, closeAt, 'system')) result.breaksClosed += 1;
    } catch (e) {
      result.errors.push(`shift ${shift.id}: break close failed: ${String(e)}`);
    }
    try {
      if (await closeOpenSegmentForShift(shift.id, closeAt, 'system')) result.segmentsClosed += 1;
    } catch (e) {
      result.errors.push(`shift ${shift.id}: segment close failed: ${String(e)}`);
    }

    // `close_source: 'system'` IS the review flag: a day nobody clocked out of.
    const { data: closed, error: closeError } = await db
      .from('shifts')
      .update({ clock_out_at: closeAt, close_source: 'system' })
      .eq('id', shift.id)
      .is('clock_out_at', null)
      .select('id')
      .maybeSingle();

    if (closeError) {
      result.errors.push(`shift ${shift.id}: close failed: ${closeError.message}`);
      continue;
    }
    if (closed) {
      result.shiftsClosed += 1;
      result.closedShiftIds.push(shift.id);
    }
  }

  return result;
}
