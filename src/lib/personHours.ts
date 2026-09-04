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
import { settledSecondsByShift } from '@/lib/shiftSettlements';

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
   * Mirrors the FIRST of adminVoidShift's guards; the server also refuses a
   * shift carrying a break or job segment, which is not mirrored here.
   * ALSO false once the shift is paid — see settlementId. */
  removable: boolean;
  /** A live settlement this shift sits on, or null. A shift with ANY live
   * payment against it can be neither edited nor removed (ledger row 459,
   * guarded in shifts.ts), so the page shows the reason instead of controls
   * the server would refuse. Half paid still counts as paid for that. */
  settlementId: string | null;
  /** How many of this shift's paid seconds a live payment has covered.
   * Since 2026-09-03 a payment can land mid-shift, so this is a number and
   * not a yes/no: 0 means nothing, `paidSeconds` means the whole shift, and
   * anything between is a part payment with the rest rolled over. */
  settledSeconds: number;
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
  /** Free text explaining an entry a SCRIPT wrote — a one-off migration that
   * deleted payroll rows outside `adminVoidShift` has no other way to say why,
   * and this entry is the only surviving record of the shift. */
  note: string | null;
};

export type PersonTime = {
  person: {
    id: string;
    displayName: string;
    active: boolean;
    isOffice: boolean;
    /** For the pay panel's REFERENCE figure only. Never used to compute a
     * payment: the amount is typed by an admin (see shiftSettlements.ts). */
    baseRateCents: number;
  } | null;
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
  /** False when the settlement read FAILED. BOTH pages that read this must
   * then say nothing about payment at all rather than fall back to "unpaid":
   * the admin pay panel hides, and the staff self-view drops its paid
   * markers and its unpaid total. Telling someone they are owed for hours
   * they have already been paid for is the wrong way to be wrong. */
  settlementsReadable: boolean;
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
  /** shiftId to what a live payment has covered on it: the seconds, and one
   * settlement id for the lock message. Empty until somebody is actually
   * paid. */
  settledByShiftId: ReadonlyMap<string, { seconds: number; settlementId: string }> = new Map(),
): { days: PersonDay[]; totalSeconds: number; shiftCount: number; openShift: PersonTime['openShift']; autoClosed: { count: number; seconds: number } } {
  const nowMs = resolveNowMs(nowIso);
  const now = new Date(nowMs).toISOString();
  const todayKey = etDayKey(new Date(nowMs));

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
    // Both ends, matching summarizeHours exactly. It bounds its windows with
    // `day >= from && day <= today`; bounding only the low end here would put
    // a future-dated shift in this page's range total and not in the summary
    // row beside it, which is the one thing this module's header promises can
    // never happen (technical lens on PR #1178). No such row exists today —
    // adminCreateShift and adminUpdateShiftTimes both refuse a future
    // timestamp, and a live clock-in cannot be ahead of now — so this is a
    // guard against divergence, not against a known row.
    if (fromDay !== null && day !== 'unknown' && (day < fromDay || day > todayKey)) continue;

    const settledOn = settledByShiftId.get(s.id);
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
      removable: s.source === 'office' && Boolean(s.manualBy) && settledOn === undefined,
      settlementId: settledOn?.settlementId ?? null,
      // Capped at the shift's own hours. The database refuses lines that sum
      // past them, so a larger number here would mean the cap had failed;
      // clamping keeps a broken read from rendering as "over paid" on
      // somebody's own hours page.
      settledSeconds: Math.min(settledOn?.seconds ?? 0, paidSeconds),
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
/**
 * PURE. Splits the hours on screen into the ones a payment has been recorded
 * against and the ones that are still waiting — Jason's ask 2026-09-03, so a
 * staff member reading their own hours can see what is still outstanding.
 *
 * HOURS, NEVER A FIGURE. This deliberately returns seconds and counts and no
 * money at all. The tool RECORDS payments and does not calculate them (S59:
 * overtime has no agreed formula, ledger row 285, and one real week in this
 * data is 50h 55m), so multiplying unpaid hours by a rate would put a number
 * on screen that nobody has agreed is owed. "You have 12h nobody has paid you
 * for yet" is true; "you are owed $X" is not something this data supports.
 *
 * An OPEN shift is in neither bucket. It cannot have been paid, and calling
 * time that is still running "unpaid" would invite someone to expect it in
 * this week's payment. It is reported separately so the page can say so.
 *
 * The caller must not call this at all when `settlementsReadable` is false —
 * every shift would land in `unpaid` and the page would tell someone they are
 * owed for hours they have already been paid for.
 */
export function splitPaidHours(days: ReadonlyArray<PersonDay>): {
  paidSeconds: number;
  paidCount: number;
  unpaidSeconds: number;
  unpaidCount: number;
  openSeconds: number;
} {
  const out = { paidSeconds: 0, paidCount: 0, unpaidSeconds: 0, unpaidCount: 0, openSeconds: 0 };
  for (const day of days) {
    for (const shift of day.shifts) {
      if (shift.clockOutAt === null) {
        out.openSeconds += shift.paidSeconds;
        continue;
      }
      // Both sides of one shift, because a payment can stop half way through
      // it. A part-paid shift counts in BOTH counts on purpose: it is a shift
      // you have had money for and a shift you are still owed on.
      const settled = Math.min(shift.settledSeconds, shift.paidSeconds);
      const owing = shift.paidSeconds - settled;
      if (settled > 0) {
        out.paidSeconds += settled;
        out.paidCount += 1;
      }
      if (owing > 0) {
        out.unpaidSeconds += owing;
        out.unpaidCount += 1;
      }
    }
  }
  return out;
}

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

export type ActivityRow = {
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
    // Carried because a script that deletes payroll rows OUTSIDE adminVoidShift
    // has no other way to explain itself, and the entry it leaves is the only
    // surviving record of the shift. Written by the row-507 import; invisible
    // until now, which the S61 admin lens caught.
    note: typeof detail.note === 'string' ? detail.note : null,
  };
}

/**
 * PURE. Splits raw activity rows into this person's trail.
 *
 * TWO passes, because the rows arrive newest-first and an aborted void is
 * attributed through the shift ids of OTHER rows. In one pass the abort is
 * seen before the older row that would have named its shift, so the exact
 * case this trail exists for — two admins racing a void, one winning, the
 * other's "removal called off" entry being the correction to a standing
 * "Shift removed" claim — dropped the correction and kept the claim
 * (technical lens on PR #1178). Pass one learns every shift id that is this
 * person's; pass two places the aborts.
 */
export function attributeAuditRows(
  rows: ReadonlyArray<ActivityRow>,
  crewMemberId: string,
  knownShiftIds: ReadonlyArray<string>,
): { entries: ShiftAuditEntry[]; partial: boolean } {
  const known = new Set(knownShiftIds);
  const mine: ShiftAuditEntry[] = [];
  const aborts: ShiftAuditEntry[] = [];
  for (const row of rows) {
    const entry = toAuditEntry(row);
    if (!entry) continue;
    const detail = row.detail ?? {};
    if (typeof detail.crewMemberId === 'string' && detail.crewMemberId === crewMemberId) {
      mine.push(entry);
      if (entry.shiftId) known.add(entry.shiftId);
    } else if (entry.action === 'shift-manual-void-aborted') {
      aborts.push(entry);
    }
  }

  let sawUnattributableAbort = false;
  for (const abort of aborts) {
    if (abort.shiftId && known.has(abort.shiftId)) mine.push(abort);
    else sawUnattributableAbort = true;
  }
  // Newest first, so a correction sits directly above the claim it corrects
  // — and tie-broken by id descending, the SAME order the query asks for.
  // Sorting on the timestamp alone dropped that tiebreak, and the two lists
  // are concatenated (this person's rows, then the aborts), so an abort
  // written in the same millisecond as the void it corrects would have sorted
  // BELOW it, which is the one ordering this list must not produce
  // (delta-verify on PR #1178).
  mine.sort((a, b) => {
    const byTime = Date.parse(b.at) - Date.parse(a.at);
    if (byTime !== 0 && Number.isFinite(byTime)) return byTime;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return { entries: mine, partial: sawUnattributableAbort };
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

  return attributeAuditRows(rows, crewMemberId, knownShiftIds);
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
    settlementsReadable: false,
    asOf,
    errors,
  };

  const db = getSupabaseServiceClient();
  if (!db) return { ...empty, errors: ['no service client'] };

  const { data: personData, error: personError } = await db
    .from('crew_members')
    .select('id, display_name, active, is_office, base_rate_cents')
    .eq('id', crewMemberId)
    .maybeSingle();
  if (personError) return { ...empty, errors: [`crew_members: ${personError.message}`] };
  const personRow = personData as {
    id: string;
    display_name: string;
    active: boolean;
    is_office: boolean;
    base_rate_cents: number;
  } | null;
  if (!personRow) return empty;
  const person = {
    id: personRow.id,
    displayName: personRow.display_name,
    active: personRow.active,
    isOffice: personRow.is_office,
    baseRateCents: personRow.base_rate_cents,
  };

  const shiftRows = await readShifts(db, crewMemberId).catch((e: unknown) => {
    errors.push(e instanceof Error ? e.message : 'shifts read failed');
    return [] as Awaited<ReturnType<typeof readShifts>>;
  });
  const shiftIds = shiftRows.map((r) => r.id);

  const [breakRows, audit, settled] = await Promise.all([
    readBreaks(db, shiftIds).catch((e: unknown) => {
      // The DIRECTION matters and a generic "incomplete" hides it: with no
      // break rows, paidSecondsForShift subtracts nothing and every total on
      // the page is TOO HIGH. On a payroll screen an overstatement that reads
      // like an undercount is the dangerous way round (technical lens on
      // PR #1178).
      errors.push(
        `${e instanceof Error ? e.message : 'shift_breaks read failed'} — break time could not be subtracted, so the hours below are too HIGH, not too low`,
      );
      return [] as Awaited<ReturnType<typeof readBreaks>>;
    }),
    readAudit(db, crewMemberId, shiftIds).catch((e: unknown) => {
      errors.push(e instanceof Error ? e.message : 'activity read failed');
      return { entries: [] as ShiftAuditEntry[], partial: false };
    }),
    // Which shifts are already paid. A failure must NOT read as "none are
    // paid": that would offer Edit and Remove on rows the server refuses, and
    // list an already-paid shift as payable a second time. Null means unknown,
    // and the page hides the pay panel on it.
    settledSecondsByShift(shiftIds).catch((e: unknown) => {
      errors.push(
        `${e instanceof Error ? e.message : 'settlement read failed'} — which hours have already been paid could not be read, so nothing here says paid or unpaid`,
      );
      return null;
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
    settled ?? new Map(),
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
    settlementsReadable: settled !== null,
    asOf,
    errors,
  };
}
