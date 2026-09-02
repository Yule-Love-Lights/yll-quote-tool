// One person's time record, for the admin detail page
// (/admin/time-tracking/[crewMemberId]) — time-tracking plan phase 2,
// docs/context/project_time_tracking.md section 5.
//
// HOURS ONLY, like phase 1. No rate, no money, no approval. The shapes here
// carry no rate field, so a later edit cannot multiply anything by anything
// without first changing this module.
//
// The day-bucketing rule is DELIBERATELY IDENTICAL to hoursSummary.ts: a
// shift belongs to the America/New_York day it STARTED, and is never split
// across midnight. If these two ever disagree, the summary table and the
// person's own page will show different totals for the same shift, which is
// the drift an admin can neither see nor explain. The tests assert the two
// agree on the same input.
//
// What this page adds over the summary: the individual shifts, grouped by
// day, with the existing edit and void controls beside them, and the manual
// audit trail for this person (ledger row 473 — those entries have existed
// since PR #1062 with no reader outside the inbox feed).

import { getSupabaseServiceClient } from '@/lib/supabase';
import { paidSecondsForShift, breakSecondsForShift } from '@/lib/shiftBreaks';
import { resolveNowMs } from '@/lib/timeSpans';
import { etDayKey } from '@/lib/dashboard/inbox/normalize';
import { addDays } from '@/lib/opsMidnightClose';

/** Rolling windows, in ET days counted back from today INCLUSIVE. Same
 * vocabulary as the summary table: no "this week" or "this month", because a
 * payroll period start has not been decided and a wrong boundary on a pay
 * screen is worse than no boundary (plan 4.6). */
export const RANGE_DAYS = { '7': 7, '30': 30, '90': 90 } as const;
export type RangeKey = keyof typeof RANGE_DAYS | 'all';
export const RANGE_KEYS: ReadonlyArray<RangeKey> = ['7', '30', '90', 'all'];

export function rangeLabel(key: RangeKey): string {
  return key === 'all' ? 'All time' : `Last ${RANGE_DAYS[key]} days`;
}

export function isRangeKey(value: unknown): value is RangeKey {
  return typeof value === 'string' && (RANGE_KEYS as ReadonlyArray<string>).includes(value);
}

export type PersonShift = {
  id: string;
  clockInAt: string;
  clockOutAt: string | null;
  source: string;
  closeSource: string | null;
  /** Who typed or last corrected this row by hand; null = only ever the
   * person's own clock actions. */
  manualBy: string | null;
  paidSeconds: number;
  breakSeconds: number;
  /** True when this row is one the office TYPED (source 'office' with a
   * manual_by stamp) — the only kind the server will let anyone remove.
   * Mirrors adminVoidShift's guard so the page offers no button the server
   * would refuse. */
  removable: boolean;
};

export type PersonDay = {
  /** ET calendar day, YYYY-MM-DD. */
  day: string;
  shifts: PersonShift[];
  paidSeconds: number;
};

export type ShiftAuditEntry = {
  id: string;
  at: string;
  actor: string;
  action: 'shift-manual-create' | 'shift-manual-edit' | 'shift-manual-void' | 'shift-manual-void-aborted';
  shiftId: string | null;
  before: { clockInAt: string | null; clockOutAt: string | null } | null;
  after: { clockInAt: string | null; clockOutAt: string | null } | null;
  /** Set on an aborted void: why the removal was called off. */
  reason: string | null;
};

export type PersonTime = {
  person: { id: string; displayName: string; active: boolean; isOffice: boolean } | null;
  range: RangeKey;
  days: PersonDay[];
  /** Paid seconds across the whole window (the sum of the days below). */
  totalSeconds: number;
  shiftCount: number;
  /** The open shift, if the person is clocked in right now. It appears in
   * `days` too; this is the flag the page needs to explain a growing total. */
  openShift: { clockInAt: string; source: string } | null;
  /** Shifts inside the window the midnight sweep closed. Counted in the
   * totals, flagged, same rule as the summary table. */
  autoClosed: { count: number; seconds: number };
  audit: ShiftAuditEntry[];
  /** True when the audit list could be scoped only by this person's KNOWN
   * shift ids — see readAudit. Nothing is hidden that we could have found;
   * this says the trail may be incomplete for shifts already voided. */
  auditPartial: boolean;
  asOf: string;
  errors: string[];
};

type ShiftEnvelope = { clockInAt: string; clockOutAt: string | null };
type BreakInterval = { startedAt: string; endedAt: string | null };

/**
 * PURE. Groups a person's shifts into ET days, newest day first, newest shift
 * first within a day, and totals the paid seconds.
 *
 * `fromDay` is the oldest ET day to include (inclusive), or null for all time.
 * Filtering happens HERE rather than in SQL so the day rule stays in one
 * place: a UTC-ranged query would drop a late-evening shift on the boundary
 * day, which is exactly the row-335 class this repo has shipped twice.
 */
export function groupPersonDays(
  shifts: ReadonlyArray<{
    id: string;
    clockInAt: string;
    clockOutAt: string | null;
    source: string;
    closeSource: string | null;
    manualBy: string | null;
  }>,
  breaks: ReadonlyArray<{ shiftId: string } & BreakInterval>,
  fromDay: string | null,
  nowIso?: string,
): { days: PersonDay[]; totalSeconds: number; shiftCount: number; openShift: PersonTime['openShift']; autoClosed: { count: number; seconds: number } } {
  const nowMs = resolveNowMs(nowIso);
  const now = new Date(nowMs).toISOString();

  const breaksByShift = new Map<string, BreakInterval[]>();
  for (const b of breaks) {
    const list = breaksByShift.get(b.shiftId);
    if (list) list.push(b);
    else breaksByShift.set(b.shiftId, [b]);
  }

  const byDay = new Map<string, PersonDay>();
  let totalSeconds = 0;
  let shiftCount = 0;
  let openShift: PersonTime['openShift'] = null;
  const autoClosed = { count: 0, seconds: 0 };

  for (const s of shifts) {
    const startMs = Date.parse(s.clockInAt);
    // A malformed clock-in has no day to sit on. It is not silently dropped:
    // it lands under the sentinel day below, which the page renders with an
    // explicit label rather than leaving the row invisible.
    const day = Number.isNaN(startMs) ? 'unknown' : etDayKey(new Date(startMs));
    if (fromDay !== null && day !== 'unknown' && day < fromDay) continue;

    const envelope: ShiftEnvelope = { clockInAt: s.clockInAt, clockOutAt: s.clockOutAt };
    const shiftBreaks = breaksByShift.get(s.id) ?? [];
    const paidSeconds = paidSecondsForShift(envelope, shiftBreaks, now);
    const breakSeconds = breakSecondsForShift(envelope, shiftBreaks, now);

    const row: PersonShift = {
      id: s.id,
      clockInAt: s.clockInAt,
      clockOutAt: s.clockOutAt,
      source: s.source,
      closeSource: s.closeSource,
      manualBy: s.manualBy,
      paidSeconds,
      breakSeconds,
      removable: s.source === 'office' && Boolean(s.manualBy),
    };

    const bucket = byDay.get(day);
    if (bucket) {
      bucket.shifts.push(row);
      bucket.paidSeconds += paidSeconds;
    } else {
      byDay.set(day, { day, shifts: [row], paidSeconds });
    }

    totalSeconds += paidSeconds;
    shiftCount += 1;
    if (s.clockOutAt === null) {
      if (!openShift || Date.parse(s.clockInAt) < Date.parse(openShift.clockInAt)) {
        openShift = { clockInAt: s.clockInAt, source: s.source };
      }
    }
    if (s.closeSource === 'system') {
      autoClosed.count += 1;
      autoClosed.seconds += paidSeconds;
    }
  }

  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  for (const d of days) {
    d.shifts.sort((a, b) => Date.parse(b.clockInAt) - Date.parse(a.clockInAt));
  }
  return { days, totalSeconds, shiftCount, openShift, autoClosed };
}

/** The oldest ET day a range includes, or null for all time. PURE. */
export function rangeFromDay(range: RangeKey, nowIso?: string): string | null {
  if (range === 'all') return null;
  const today = etDayKey(new Date(resolveNowMs(nowIso)));
  return addDays(today, -(RANGE_DAYS[range] - 1));
}

// ---------------------------------------------------------------------------
// Loaders. READ-ONLY: nothing in this module writes to shifts, shift_breaks
// or dashboard_activity. The writes live in shifts.ts behind the admin route.
// ---------------------------------------------------------------------------

type Db = NonNullable<ReturnType<typeof getSupabaseServiceClient>>;

const PAGE = 1000;

const AUDIT_ACTIONS = [
  'shift-manual-create',
  'shift-manual-edit',
  'shift-manual-void',
  'shift-manual-void-aborted',
] as const;

type ActivityRow = {
  id: string;
  actor: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  created_at: string;
};

function timesFrom(value: unknown): { clockInAt: string | null; clockOutAt: string | null } | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const inAt = typeof v.clock_in_at === 'string' ? v.clock_in_at : null;
  const outAt = typeof v.clock_out_at === 'string' ? v.clock_out_at : null;
  if (inAt === null && outAt === null) return null;
  return { clockInAt: inAt, clockOutAt: outAt };
}

export function toAuditEntry(row: ActivityRow): ShiftAuditEntry | null {
  if (!(AUDIT_ACTIONS as ReadonlyArray<string>).includes(row.action)) return null;
  const detail = row.detail ?? {};
  return {
    id: row.id,
    at: row.created_at,
    actor: row.actor?.trim() || 'unknown',
    action: row.action as ShiftAuditEntry['action'],
    shiftId: typeof detail.shiftId === 'string' ? detail.shiftId : null,
    before: timesFrom(detail.before),
    after: timesFrom(detail.after),
    reason: typeof detail.reason === 'string' ? detail.reason : null,
  };
}

/**
 * This person's manual-write trail.
 *
 * Two shapes have to be caught, because they are written differently:
 *
 *  - create / edit / void carry `detail.crewMemberId`, so they are asked for
 *    by that directly.
 *  - `shift-manual-void-aborted` carries only `shiftId` and a reason (see
 *    recordVoidAborted in shifts.ts), so it is matched against the shift ids
 *    this person is already known to have. A void that was aborted for a
 *    shift that has since been removed entirely is therefore NOT findable
 *    from here; `auditPartial` says so on the page rather than presenting a
 *    trail that looks complete.
 *
 * The action filter comes first on purpose: dashboard_activity holds ~937k
 * rows and its partial index is on (action, created_at desc), so this reads
 * in milliseconds instead of scanning the table (measured on prod: 1.8ms).
 */
async function readAudit(
  db: Db,
  crewMemberId: string,
  knownShiftIds: ReadonlyArray<string>,
): Promise<{ entries: ShiftAuditEntry[]; partial: boolean }> {
  const rows: ActivityRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('dashboard_activity')
      .select('id, actor, action, detail, created_at')
      .in('action', [...AUDIT_ACTIONS])
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`activity: ${error.message}`);
    const page = (data ?? []) as ActivityRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  const known = new Set(knownShiftIds);
  const entries: ShiftAuditEntry[] = [];
  let sawUnattributableAbort = false;
  for (const row of rows) {
    const entry = toAuditEntry(row);
    if (!entry) continue;
    const detail = row.detail ?? {};
    const belongsByCrew =
      typeof detail.crewMemberId === 'string' && detail.crewMemberId === crewMemberId;
    if (belongsByCrew) {
      entries.push(entry);
      if (entry.shiftId) known.add(entry.shiftId);
      continue;
    }
    if (entry.action === 'shift-manual-void-aborted') {
      if (entry.shiftId && known.has(entry.shiftId)) entries.push(entry);
      else sawUnattributableAbort = true;
    }
  }
  return { entries, partial: sawUnattributableAbort };
}

async function readShifts(db: Db, crewMemberId: string) {
  const rows: {
    id: string;
    clock_in_at: string;
    clock_out_at: string | null;
    source: string;
    close_source: string | null;
    manual_by: string | null;
  }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('shifts')
      .select('id, clock_in_at, clock_out_at, source, close_source, manual_by')
      .eq('crew_member_id', crewMemberId)
      .order('clock_in_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`shifts: ${error.message}`);
    const page = (data ?? []) as typeof rows;
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

async function readBreaks(db: Db, shiftIds: ReadonlyArray<string>) {
  if (shiftIds.length === 0) return [];
  const rows: { shift_id: string; started_at: string; ended_at: string | null }[] = [];
  // Chunked: an `in` list of every shift id would eventually outgrow the URL.
  const CHUNK = 200;
  for (let i = 0; i < shiftIds.length; i += CHUNK) {
    const ids = shiftIds.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('shift_breaks')
        .select('shift_id, started_at, ended_at')
        .in('shift_id', [...ids])
        .order('started_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`shift_breaks: ${error.message}`);
      const page = (data ?? []) as typeof rows;
      rows.push(...page);
      if (page.length < PAGE) break;
    }
  }
  return rows;
}

/**
 * One person's hours and audit trail. Fails LOUD: every read error lands in
 * `errors` for the page to render, rather than an empty day list that looks
 * exactly like a person who never worked.
 *
 * `person` is null when the id matches no crew row — the page shows a
 * not-found state rather than an empty table under a blank name.
 */
export async function loadPersonTime(
  crewMemberId: string,
  range: RangeKey,
  nowIso?: string,
): Promise<PersonTime> {
  const asOf = new Date(resolveNowMs(nowIso)).toISOString();
  const errors: string[] = [];
  const empty: PersonTime = {
    person: null,
    range,
    days: [],
    totalSeconds: 0,
    shiftCount: 0,
    openShift: null,
    autoClosed: { count: 0, seconds: 0 },
    audit: [],
    auditPartial: false,
    asOf,
    errors,
  };

  const db = getSupabaseServiceClient();
  if (!db) return { ...empty, errors: ['no service client'] };

  const { data: personData, error: personError } = await db
    .from('crew_members')
    .select('id, display_name, active, is_office')
    .eq('id', crewMemberId)
    .maybeSingle();
  if (personError) return { ...empty, errors: [`crew_members: ${personError.message}`] };
  const personRow = personData as {
    id: string;
    display_name: string;
    active: boolean;
    is_office: boolean;
  } | null;
  if (!personRow) return empty;
  const person = {
    id: personRow.id,
    displayName: personRow.display_name,
    active: personRow.active,
    isOffice: personRow.is_office,
  };

  const shiftRows = await readShifts(db, crewMemberId).catch((e: unknown) => {
    errors.push(e instanceof Error ? e.message : 'shifts read failed');
    return [] as Awaited<ReturnType<typeof readShifts>>;
  });
  const shiftIds = shiftRows.map((r) => r.id);

  const [breakRows, audit] = await Promise.all([
    readBreaks(db, shiftIds).catch((e: unknown) => {
      errors.push(e instanceof Error ? e.message : 'shift_breaks read failed');
      return [] as Awaited<ReturnType<typeof readBreaks>>;
    }),
    readAudit(db, crewMemberId, shiftIds).catch((e: unknown) => {
      errors.push(e instanceof Error ? e.message : 'activity read failed');
      return { entries: [] as ShiftAuditEntry[], partial: false };
    }),
  ]);

  const grouped = groupPersonDays(
    shiftRows.map((r) => ({
      id: r.id,
      clockInAt: r.clock_in_at,
      clockOutAt: r.clock_out_at,
      source: r.source,
      closeSource: r.close_source,
      manualBy: r.manual_by,
    })),
    breakRows.map((b) => ({ shiftId: b.shift_id, startedAt: b.started_at, endedAt: b.ended_at })),
    rangeFromDay(range, asOf),
    asOf,
  );

  return {
    person,
    range,
    days: grouped.days,
    totalSeconds: grouped.totalSeconds,
    shiftCount: grouped.shiftCount,
    openShift: grouped.openShift,
    autoClosed: grouped.autoClosed,
    audit: audit.entries,
    auditPartial: audit.partial,
    asOf,
    errors,
  };
}
