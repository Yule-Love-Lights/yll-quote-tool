import { getSupabaseServiceClient } from '@/lib/supabase';
import { etDayKey } from '@/lib/dashboard/inbox/normalize';

/**
 * The time-exception queue (ledger row 278, contract section 5).
 *
 * The contract lists exceptions the QT owes an operator: forgotten clock-out,
 * open break at clock-out, open job segment at clock-out. Until now nothing
 * surfaced any of them, which let two specific defects sit unseen forever:
 *
 *  1. TOCTOU on open — `startBreak` / `arriveAtJob` check "is the shift still
 *     open" with a plain SELECT, so a row inserted microseconds after a
 *     concurrent `clockOut` is orphaned open. Nothing will ever close it,
 *     because every closer requires an OPEN shift.
 *  2. Failed auto-close — `clockOut` closes a running break/segment
 *     best-effort and only logs on failure, so a hiccup leaves the child open
 *     with `auto_closed` still false.
 *
 * NEITHER CORRUPTS PAY. Open breaks and segments clip to the shift's recorded
 * clock-out in the money math, so the numbers self-heal. What breaks is
 * VISIBILITY: `getOpenBreak` reports "still on break" indefinitely and nobody is
 * told. This module is the telling.
 *
 * READ-ONLY BY DESIGN. It reports; it closes nothing. Manual punches are
 * authoritative for pay (F3), so inventing an end time here would be exactly
 * wrong. The midnight auto-close already handles the legitimate day-boundary
 * case; anything surfacing past that needs a human deciding what happened.
 */

export type TimeExceptionType =
  | 'open_break_on_closed_shift'
  | 'open_segment_on_closed_shift'
  | 'forgotten_clock_out'
  | 'stale_open_segment';

export type TimeException = {
  type: TimeExceptionType;
  shiftId: string;
  crewMemberId: string;
  /** The break or segment id, when the exception is about a child row. */
  rowId: string | null;
  openedAt: string;
  /** Plain English, aimed at whoever has to fix it. */
  detail: string;
};

type ShiftRow = {
  id: string;
  crew_member_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
};

/** Default idle gap before an OPEN segment on an OPEN shift looks like a missed tap. */
export const DEFAULT_STALE_SEGMENT_HOURS = 12;

export type ShiftInput = {
  id: string;
  crewMemberId: string;
  clockInAt: string;
  clockOutAt: string | null;
};
export type OpenBreakInput = {
  id: string;
  shiftId: string;
  crewMemberId: string;
  startedAt: string;
};
export type OpenSegmentInput = {
  id: string;
  shiftId: string;
  crewMemberId: string;
  arrivedAt: string;
};

/**
 * PURE classifier, so the rules are testable without a database.
 *
 * `now` is a parameter rather than read from the clock: "stale" is relative, and
 * a test that cannot control the clock cannot pin the boundary.
 */
export function classifyTimeExceptions(input: {
  shifts: ReadonlyArray<ShiftInput>;
  openBreaks: ReadonlyArray<OpenBreakInput>;
  openSegments: ReadonlyArray<OpenSegmentInput>;
  now: Date;
  staleSegmentHours?: number;
}): TimeException[] {
  const { shifts, openBreaks, openSegments, now } = input;
  const staleMs = (input.staleSegmentHours ?? DEFAULT_STALE_SEGMENT_HOURS) * 3600 * 1000;
  const byId = new Map(shifts.map((s) => [s.id, s]));
  const out: TimeException[] = [];

  // 1 + 2. A child row still open under a CLOSED shift: the orphan case. No code
  // path will ever close it, because every closer requires an open shift.
  for (const b of openBreaks) {
    const shift = byId.get(b.shiftId);
    if (shift && shift.clockOutAt !== null) {
      out.push({
        type: 'open_break_on_closed_shift',
        shiftId: shift.id,
        crewMemberId: b.crewMemberId,
        rowId: b.id,
        openedAt: b.startedAt,
        detail:
          'A break is still open on a shift that already clocked out. Pay is unaffected, because ' +
          'break time clips to the clock-out, but the record says they never came back from break.',
      });
    }
  }
  for (const s of openSegments) {
    const shift = byId.get(s.shiftId);
    if (shift && shift.clockOutAt !== null) {
      out.push({
        type: 'open_segment_on_closed_shift',
        shiftId: shift.id,
        crewMemberId: s.crewMemberId,
        rowId: s.id,
        openedAt: s.arrivedAt,
        detail:
          'A job segment is still open on a shift that already clocked out. Pay is unaffected, ' +
          'because job time clips to the clock-out, but the record says they never left the job.',
      });
    }
  }

  // 3. A shift open from an earlier ET day. The midnight close should have caught
  // this, so one appearing here means that cron is not running — which is itself
  // the alarm, and the failure the CRON_SECRET 503 was added to make visible.
  for (const shift of shifts) {
    if (shift.clockOutAt !== null) continue;
    const opened = new Date(shift.clockInAt);
    if (Number.isNaN(opened.getTime()) || etDayKey(opened) < etDayKey(now)) {
      out.push({
        type: 'forgotten_clock_out',
        shiftId: shift.id,
        crewMemberId: shift.crewMemberId,
        rowId: null,
        openedAt: shift.clockInAt,
        detail:
          'A shift is still open from an earlier day. The midnight auto-close should have closed ' +
          'it, so if this appears, check that the midnight-close cron is actually running.',
      });
    }
  }

  // 4. An open segment on a still-open shift, past the idle gap: the missed-tap
  // case, caught while the day is still live and fixable.
  for (const s of openSegments) {
    const shift = byId.get(s.shiftId);
    if (!shift || shift.clockOutAt !== null) continue;
    const started = new Date(s.arrivedAt);
    if (Number.isNaN(started.getTime()) || now.getTime() - started.getTime() > staleMs) {
      out.push({
        type: 'stale_open_segment',
        shiftId: shift.id,
        crewMemberId: s.crewMemberId,
        rowId: s.id,
        openedAt: s.arrivedAt,
        detail:
          'Still at this job past the idle gap. Most likely a forgotten Depart, which the contract ' +
          'calls the one un-backstopped pay-and-data corruption path.',
      });
    }
  }

  return out;
}

/** Fetch the live rows and classify them. Read-only; closes nothing. */
export async function listTimeExceptions(
  now: Date = new Date(),
  staleSegmentHours: number = DEFAULT_STALE_SEGMENT_HOURS,
): Promise<{ exceptions: TimeException[]; errors: string[] }> {
  const errors: string[] = [];
  const db = getSupabaseServiceClient();
  if (!db) return { exceptions: [], errors: ['Supabase service role not configured'] };

  const [breaksRes, segmentsRes] = await Promise.all([
    db.from('shift_breaks').select('id, shift_id, crew_member_id, started_at').is('ended_at', null),
    db
      .from('job_segments')
      .select('id, shift_id, crew_member_id, arrived_at')
      .is('departed_at', null),
  ]);

  if (breaksRes.error) errors.push(`open-break scan: ${breaksRes.error.message}`);
  if (segmentsRes.error) errors.push(`open-segment scan: ${segmentsRes.error.message}`);

  type RawBreak = { id: string; shift_id: string; crew_member_id: string; started_at: string };
  type RawSegment = { id: string; shift_id: string; crew_member_id: string; arrived_at: string };

  const openBreaks: OpenBreakInput[] = (
    (breaksRes.data as unknown as RawBreak[] | null) ?? []
  ).map((r) => ({
    id: r.id,
    shiftId: r.shift_id,
    crewMemberId: r.crew_member_id,
    startedAt: r.started_at,
  }));

  const openSegments: OpenSegmentInput[] = (
    (segmentsRes.data as unknown as RawSegment[] | null) ?? []
  ).map((r) => ({
    id: r.id,
    shiftId: r.shift_id,
    crewMemberId: r.crew_member_id,
    arrivedAt: r.arrived_at,
  }));

  // Every shift referenced by an open child, plus every currently-open shift.
  const referenced = [...new Set([...openBreaks, ...openSegments].map((r) => r.shiftId))];
  const referencedRes = referenced.length
    ? await db
        .from('shifts')
        .select('id, crew_member_id, clock_in_at, clock_out_at')
        .in('id', referenced)
    : { data: [] as unknown, error: null };
  const openShiftsRes = await db
    .from('shifts')
    .select('id, crew_member_id, clock_in_at, clock_out_at')
    .is('clock_out_at', null);

  if (referencedRes.error) errors.push(`shift lookup: ${referencedRes.error.message}`);
  if (openShiftsRes.error) errors.push(`open-shift scan: ${openShiftsRes.error.message}`);

  const merged = new Map<string, ShiftRow>();
  for (const r of [
    ...((referencedRes.data as unknown as ShiftRow[] | null) ?? []),
    ...((openShiftsRes.data as unknown as ShiftRow[] | null) ?? []),
  ]) {
    merged.set(r.id, r);
  }

  const shifts: ShiftInput[] = [...merged.values()].map((r) => ({
    id: r.id,
    crewMemberId: r.crew_member_id,
    clockInAt: r.clock_in_at,
    clockOutAt: r.clock_out_at,
  }));

  return {
    exceptions: classifyTimeExceptions({
      shifts,
      openBreaks,
      openSegments,
      now,
      staleSegmentHours,
    }),
    errors,
  };
}
