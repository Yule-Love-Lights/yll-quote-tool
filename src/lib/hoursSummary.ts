// Per-person hours from the manual clock, for the admin Time tracking page
// (Jason S59, time-tracking plan phase 1: `docs/context/project_time_tracking.md`).
//
// HOURS ONLY. No rate, no money, no approval state. The plan's 4.4 keeps money
// a separate later decision, and this module has no field a renderer could
// multiply by a rate. Phase 3 (settlement) is a different module.
//
// This is the first real caller of `paidSecondsForShift`, which shipped with
// its tests and no consumer (plan section 0). The arithmetic stays there; this
// module only decides WHICH shifts land in WHICH column.
//
// Rules a reader needs, all deliberate:
//
//  - A shift counts on the ET calendar day it STARTED. A shift crossing
//    midnight is not split. Today 5 of 27 prod shifts cross midnight, and all
//    5 are midnight auto-closes (close_source 'system', a forgotten
//    clock-out); splitting a bogus 14-hour day across two dates would only
//    spread the error. The date is the America/New_York business day
//    (etDayKey), never UTC: the row-335 class.
//  - Windows are ROLLING, counted in ET days including today: 'today',
//    the last 7 days, the last 30 days, and all time. No "this week", because
//    a payroll week start has not been decided and a wrong boundary here is a
//    wrong number on a pay screen.
//  - An open shift counts up to `now` (paidSecondsForShift does this), and the
//    row says so, because a number that keeps growing needs a reason next to it.
//  - A midnight auto-close is reported separately AND left inside the totals.
//    Leaving it out would silently under-report a real day the person simply
//    forgot to close; hiding that it is in would make a 14-hour phantom look
//    like work. The admin sees both numbers and fixes the shift on the two
//    clocks page, which is where the manual editor lives.
//  - A shift whose crew id matches no staff row is NOT dropped: it renders
//    under '(unknown)'. Hiding a payroll row behind a failed lookup is the
//    silent-empty class this repo keeps getting bitten by (fleetDay.ts has the
//    same rule).

import { getSupabaseServiceClient } from '@/lib/supabase';
import { paidSecondsForShift } from '@/lib/shiftBreaks';
import { resolveNowMs } from '@/lib/timeSpans';
import { etDayKey } from '@/lib/dashboard/inbox/normalize';
import { addDays } from '@/lib/opsMidnightClose';
import { listAllStaff, type StaffMember } from '@/lib/crewMembers';

export type HoursShift = {
  id: string;
  crewMemberId: string;
  clockInAt: string;
  clockOutAt: string | null;
  source: string;
  closeSource: string | null;
};

export type HoursBreak = {
  shiftId: string;
  startedAt: string;
  endedAt: string | null;
};

export type HoursStaff = Pick<StaffMember, 'id' | 'displayName' | 'active' | 'isOffice'>;

export type PersonHours = {
  crewMemberId: string;
  displayName: string;
  /** Office or field, straight off crew_members.is_office. Shown as a label,
   * not used to group: one live row carries a flag that contradicts how the
   * person actually works (plan 4.2), and a label makes that visible where a
   * grouping would bury it. */
  isOffice: boolean;
  active: boolean;
  /** Paid seconds (envelope minus breaks) per rolling window. */
  todaySeconds: number;
  last7Seconds: number;
  last30Seconds: number;
  allTimeSeconds: number;
  shiftCount: number;
  /** The open shift, if one: when it started and which door opened it. */
  openShift: { clockInAt: string; source: string } | null;
  /** Shifts the midnight sweep closed (close_source 'system'), all time, and
   * the paid seconds those rows contribute to allTimeSeconds. */
  autoClosed: { count: number; seconds: number };
};

export type HoursSummary = {
  rows: PersonHours[];
  /** ISO instant the figures were computed at; open shifts count up to it. */
  asOf: string;
  errors: string[];
};

const UNKNOWN_NAME = '(unknown)';

/**
 * PURE. Buckets each shift's paid seconds into the rolling windows by the ET
 * day it started, one row per staff member (plus one '(unknown)' row per
 * crew id that has shifts but no staff row).
 *
 * Sort: office first, then field, then by name within each; inactive people
 * sink to the bottom of their group. Same order as the Staff panel in
 * Settings, so the two screens read alike.
 */
export function summarizeHours(
  staff: ReadonlyArray<HoursStaff>,
  shifts: ReadonlyArray<HoursShift>,
  breaks: ReadonlyArray<HoursBreak>,
  nowIso?: string,
): PersonHours[] {
  const nowMs = resolveNowMs(nowIso);
  const now = new Date(nowMs);
  const today = etDayKey(now);
  const from7 = addDays(today, -6);
  const from30 = addDays(today, -29);

  const breaksByShift = new Map<string, HoursBreak[]>();
  for (const b of breaks) {
    const list = breaksByShift.get(b.shiftId);
    if (list) list.push(b);
    else breaksByShift.set(b.shiftId, [b]);
  }

  const rows = new Map<string, PersonHours>();
  const rowFor = (crewMemberId: string): PersonHours => {
    const existing = rows.get(crewMemberId);
    if (existing) return existing;
    const created = emptyRow({
      id: crewMemberId,
      displayName: UNKNOWN_NAME,
      active: false,
      isOffice: false,
    });
    rows.set(crewMemberId, created);
    return created;
  };
  for (const s of staff) rows.set(s.id, emptyRow(s));

  for (const shift of shifts) {
    const row = rowFor(shift.crewMemberId);
    const seconds = paidSecondsForShift(
      { clockInAt: shift.clockInAt, clockOutAt: shift.clockOutAt },
      breaksByShift.get(shift.id) ?? [],
      now.toISOString(),
    );
    // A malformed timestamp gives no envelope and 0 seconds; the shift still
    // counts as a shift so the count and the hours do not silently disagree.
    const startMs = Date.parse(shift.clockInAt);
    const day = Number.isNaN(startMs) ? null : etDayKey(new Date(startMs));

    row.shiftCount += 1;
    row.allTimeSeconds += seconds;
    if (day !== null) {
      if (day === today) row.todaySeconds += seconds;
      if (day >= from7 && day <= today) row.last7Seconds += seconds;
      if (day >= from30 && day <= today) row.last30Seconds += seconds;
    }
    if (shift.clockOutAt === null) {
      // The DB's partial unique index allows one open shift per person; if
      // two ever arrive, keep the earlier start so the "since" is honest.
      if (!row.openShift || Date.parse(shift.clockInAt) < Date.parse(row.openShift.clockInAt)) {
        row.openShift = { clockInAt: shift.clockInAt, source: shift.source };
      }
    }
    if (shift.closeSource === 'system') {
      row.autoClosed.count += 1;
      row.autoClosed.seconds += seconds;
    }
  }

  return [...rows.values()].sort(compareRows);
}

function emptyRow(s: HoursStaff): PersonHours {
  return {
    crewMemberId: s.id,
    displayName: s.displayName,
    isOffice: s.isOffice,
    active: s.active,
    todaySeconds: 0,
    last7Seconds: 0,
    last30Seconds: 0,
    allTimeSeconds: 0,
    shiftCount: 0,
    openShift: null,
    autoClosed: { count: 0, seconds: 0 },
  };
}

function compareRows(a: PersonHours, b: PersonHours): number {
  if (a.isOffice !== b.isOffice) return a.isOffice ? -1 : 1;
  if (a.active !== b.active) return a.active ? -1 : 1;
  return a.displayName.localeCompare(b.displayName, 'en');
}

/** "7h 24m" from seconds; minutes rounded to nearest. "0m" for nothing. */
export function formatHours(seconds: number): string {
  const minutes = Math.round(Math.max(0, seconds) / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

// ---------------------------------------------------------------------------
// Loader. Read-only: this module never writes to shifts or shift_breaks.
// ---------------------------------------------------------------------------

type Db = NonNullable<ReturnType<typeof getSupabaseServiceClient>>;

type ShiftRow = {
  id: string;
  crew_member_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  source: string;
  close_source: string | null;
};

type BreakRow = { shift_id: string; started_at: string; ended_at: string | null };

// PostgREST caps a single read at 1000 rows. Every window here is all-time,
// so the read pages until a short page rather than trusting one call. A
// truncated read would understate someone's hours and look exactly like a
// quiet stretch (payouts.ts has the same rule for the same reason).
const PAGE = 1000;

async function readAllShifts(db: Db): Promise<ShiftRow[]> {
  const rows: ShiftRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('shifts')
      .select('id, crew_member_id, clock_in_at, clock_out_at, source, close_source')
      .order('clock_in_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`shifts: ${error.message}`);
    const page = (data ?? []) as ShiftRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

async function readAllBreaks(db: Db): Promise<BreakRow[]> {
  const rows: BreakRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('shift_breaks')
      .select('shift_id, started_at, ended_at')
      .order('started_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`shift_breaks: ${error.message}`);
    const page = (data ?? []) as BreakRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

/**
 * Everyone's hours, for the admin page. Fails LOUD, not empty: a read error
 * lands in `errors` and the rows are whatever could be computed (staff with
 * zero hours when shifts failed, nobody when staff failed), so the page can
 * render an error card instead of an all-clear table of zeros.
 */
export async function loadHoursSummary(nowIso?: string): Promise<HoursSummary> {
  const asOf = new Date(resolveNowMs(nowIso)).toISOString();
  const errors: string[] = [];
  const db = getSupabaseServiceClient();
  if (!db) return { rows: [], asOf, errors: ['no service client'] };

  // listAllStaff logs and returns [] on error; an empty staff list with shifts
  // present is not silent here because every shift then renders as
  // '(unknown)', which is the visible failure it should be.
  const [staff, shifts, breaks] = await Promise.all([
    listAllStaff(),
    readAllShifts(db).catch((e: unknown) => {
      errors.push(e instanceof Error ? e.message : 'shifts read failed');
      return [] as ShiftRow[];
    }),
    readAllBreaks(db).catch((e: unknown) => {
      errors.push(e instanceof Error ? e.message : 'shift_breaks read failed');
      return [] as BreakRow[];
    }),
  ]);

  const rows = summarizeHours(
    staff,
    shifts.map((r) => ({
      id: r.id,
      crewMemberId: r.crew_member_id,
      clockInAt: r.clock_in_at,
      clockOutAt: r.clock_out_at,
      source: r.source,
      closeSource: r.close_source,
    })),
    breaks.map((b) => ({ shiftId: b.shift_id, startedAt: b.started_at, endedAt: b.ended_at })),
    asOf,
  );
  return { rows, asOf, errors };
}
