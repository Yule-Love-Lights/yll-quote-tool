import { getSupabaseServiceClient } from '@/lib/supabase';
import type { ShiftSource } from '@/lib/shifts';

/**
 * Break tracking on the shift clock ledger.
 *
 * Breaks are UNPAID (`OPERATIONS_HUB_CONTRACT.md` section 8: advertising paid
 * seconds are the union of paid-day intervals "excluding unpaid breaks"), so
 * paid time for a shift is the clock envelope minus break time. That number
 * feeds P4P payout math, which is why the arithmetic here lives in pure
 * functions with their own tests and stays in integer milliseconds until the
 * final conversion.
 *
 * The database, not a read-then-check, enforces at most one open break per
 * shift: a partial unique index on shift_id where ended_at is null. Same shape
 * as `shifts_one_open_per_person`.
 */

export type ShiftBreak = {
  id: string;
  shiftId: string;
  crewMemberId: string;
  startedAt: string;
  endedAt: string | null;
  source: ShiftSource;
  endSource: ShiftSource | null;
  /** True when a clock-out closed this break instead of the crew member. Feeds the `open_break` exception queue. */
  autoClosed: boolean;
  deviceTime: string | null;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: string;
  shift_id: string;
  crew_member_id: string;
  started_at: string;
  ended_at: string | null;
  source: ShiftSource;
  end_source: ShiftSource | null;
  auto_closed: boolean;
  device_time: string | null;
  created_at: string;
  updated_at: string;
};

type ShiftGuardRow = {
  id: string;
  crew_member_id: string;
  clock_out_at: string | null;
};

const SELECT =
  'id, shift_id, crew_member_id, started_at, ended_at, source, end_source, auto_closed, device_time, created_at, updated_at';

type Db = NonNullable<ReturnType<typeof getSupabaseServiceClient>>;

function toShiftBreak(row: Row): ShiftBreak {
  return {
    id: row.id,
    shiftId: row.shift_id,
    crewMemberId: row.crew_member_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    source: row.source,
    endSource: row.end_source,
    autoClosed: row.auto_closed,
    deviceTime: row.device_time,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isOpenBreakUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '23505' && error.message?.includes('shift_breaks_one_open_per_shift') === true;
}

// ---------------------------------------------------------------------------
// Money math. Pure, no database.
// ---------------------------------------------------------------------------

type ShiftEnvelope = { clockInAt: string; clockOutAt: string | null };
type BreakInterval = { startedAt: string; endedAt: string | null };

type Span = { start: number; end: number };

function parseMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The shift envelope in milliseconds. An open shift runs to `nowMs`. Returns
 * null when the clock-in is unparseable, and an empty span when the clock-out
 * precedes the clock-in — a corrupt row must not mint negative paid time.
 */
function envelopeMs(shift: ShiftEnvelope, nowMs: number): Span | null {
  const start = parseMs(shift.clockInAt);
  if (start === null) return null;
  const end = shift.clockOutAt === null ? nowMs : parseMs(shift.clockOutAt);
  if (end === null) return null;
  return { start, end: Math.max(start, end) };
}

/**
 * Break spans clipped to the envelope and merged, so overlapping rows (two
 * office corrections on the same lunch, say) subtract their union once rather
 * than their sum twice. Double-subtracting would underpay the crew member.
 */
function mergedBreakSpans(
  envelope: Span,
  breaks: ReadonlyArray<BreakInterval>,
  nowMs: number,
): Span[] {
  const spans: Span[] = [];

  for (const item of breaks) {
    const rawStart = parseMs(item.startedAt);
    if (rawStart === null) continue;
    const rawEnd = item.endedAt === null ? nowMs : parseMs(item.endedAt);
    if (rawEnd === null) continue;

    const start = Math.max(rawStart, envelope.start);
    const end = Math.min(rawEnd, envelope.end);
    if (end > start) spans.push({ start, end });
  }

  spans.sort((a, b) => a.start - b.start);

  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function breakMs(shift: ShiftEnvelope, breaks: ReadonlyArray<BreakInterval>, nowMs: number): number {
  const envelope = envelopeMs(shift, nowMs);
  if (!envelope) return 0;
  return mergedBreakSpans(envelope, breaks, nowMs).reduce(
    (total, span) => total + (span.end - span.start),
    0,
  );
}

/**
 * ROUNDING RULE, and why the two halves round in opposite directions.
 *
 * The envelope rounds UP and break time rounds DOWN. Both directions favor the
 * employee: a longer paid day, and less unpaid time subtracted from it.
 *
 * More importantly, defining paid seconds as `envelopeSeconds - breakSeconds`
 * makes the decomposition EXACT by construction:
 *
 *     paidSecondsForShift(...) + breakSecondsForShift(...) === envelopeSeconds
 *
 * An earlier version rounded each half up independently. That held for
 * whole-second inputs but broke on real millisecond timestamps: a 10,700 ms
 * envelope with a 400 ms break gave paid 11 + break 1 = 12 against an 11-second
 * envelope. Any later timesheet or payout code that composed "shift length
 * minus break time" would then disagree with this module's own answer, and the
 * crew member would have no way to tell which figure was real. Caught by the
 * S58 wrap review's crew lens.
 */
function ceilSeconds(ms: number): number {
  return Math.ceil(Math.max(0, ms) / 1000);
}

function floorSeconds(ms: number): number {
  return Math.floor(Math.max(0, ms) / 1000);
}

/** The whole clock envelope in seconds, before break time comes off it. */
function envelopeSeconds(shift: ShiftEnvelope, nowMs: number): number {
  const envelope = envelopeMs(shift, nowMs);
  if (!envelope) return 0;
  return ceilSeconds(envelope.end - envelope.start);
}

function resolveNowMs(nowIso?: string): number {
  return nowIso ? (parseMs(nowIso) ?? Date.now()) : Date.now();
}

/**
 * Unpaid break seconds inside the shift envelope, clipped and de-overlapped.
 * Capped at the envelope so it can never exceed the day it is subtracted from.
 */
export function breakSecondsForShift(
  shift: ShiftEnvelope,
  breaks: ReadonlyArray<BreakInterval>,
  nowIso?: string,
): number {
  const nowMs = resolveNowMs(nowIso);
  return Math.min(floorSeconds(breakMs(shift, breaks, nowMs)), envelopeSeconds(shift, nowMs));
}

/** Paid seconds for the shift: the clock envelope minus unpaid break time. Never negative. */
export function paidSecondsForShift(
  shift: ShiftEnvelope,
  breaks: ReadonlyArray<BreakInterval>,
  nowIso?: string,
): number {
  const nowMs = resolveNowMs(nowIso);
  return Math.max(0, envelopeSeconds(shift, nowMs) - breakSecondsForShift(shift, breaks, nowIso));
}

// ---------------------------------------------------------------------------
// Ledger reads and writes.
// ---------------------------------------------------------------------------

async function getOpenBreakRow(db: Db, shiftId: string): Promise<Row | null> {
  const { data, error } = await db
    .from('shift_breaks')
    .select(SELECT)
    .eq('shift_id', shiftId)
    .is('ended_at', null)
    .maybeSingle();
  if (error) throw new Error(`getOpenBreak: ${error.message}`);
  return (data as Row | null) ?? null;
}

async function getBreakRowById(db: Db, breakId: string): Promise<Row | null> {
  const { data, error } = await db
    .from('shift_breaks')
    .select(SELECT)
    .eq('id', breakId)
    .maybeSingle();
  if (error) throw new Error(`endBreak: ${error.message}`);
  return (data as Row | null) ?? null;
}

async function getShiftGuardRow(db: Db, shiftId: string): Promise<ShiftGuardRow | null> {
  const { data, error } = await db
    .from('shifts')
    .select('id, crew_member_id, clock_out_at')
    .eq('id', shiftId)
    .maybeSingle();
  if (error) throw new Error(`startBreak: ${error.message}`);
  return (data as ShiftGuardRow | null) ?? null;
}

export async function getOpenBreak(shiftId: string): Promise<ShiftBreak | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;

  try {
    const row = await getOpenBreakRow(db, shiftId.trim());
    return row ? toShiftBreak(row) : null;
  } catch (error) {
    console.error('getOpenBreak error:', error);
    return null;
  }
}

export async function listBreaks(shiftId: string): Promise<ShiftBreak[]> {
  const db = getSupabaseServiceClient();
  if (!db) return [];

  try {
    const { data, error } = await db
      .from('shift_breaks')
      .select(SELECT)
      .eq('shift_id', shiftId.trim())
      .order('started_at', { ascending: true });
    if (error) throw new Error(`listBreaks: ${error.message}`);
    return ((data as Row[] | null) ?? []).map(toShiftBreak);
  } catch (error) {
    console.error('listBreaks error:', error);
    return [];
  }
}

/**
 * Open a break on a shift.
 *
 * KNOWN ACCEPTED GAP (S58 wrap review, technical lens): the "is this shift still
 * open" check is a plain SELECT, not a conditional write, so a break inserted in
 * the microseconds after a concurrent `clockOut` can be orphaned open forever —
 * the shift is closed, so nothing will ever call `closeOpenBreakForShift` for it
 * again. Pay is NOT affected: an open break clips to the shift's recorded
 * clock-out in the paid-time math, so the numbers self-heal. The damage is
 * visibility: `getOpenBreak` would report "still on break" indefinitely. The
 * real fix is the contract's `open_break` exception-queue sweep, which is not
 * built yet, so this is recorded rather than papered over. See the ledger row
 * for the sweep.
 */
export async function startBreak(
  shiftId: string,
  crewMemberId: string,
  source: ShiftSource,
): Promise<ShiftBreak> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const trimmedShiftId = shiftId.trim();
  const trimmedCrewMemberId = crewMemberId.trim();

  const shift = await getShiftGuardRow(db, trimmedShiftId);
  if (!shift) throw new Error(`startBreak: no shift found for id ${trimmedShiftId}`);
  if (shift.crew_member_id !== trimmedCrewMemberId) {
    throw new Error(
      `startBreak: shift ${trimmedShiftId} belongs to ${shift.crew_member_id}, not ${trimmedCrewMemberId}`,
    );
  }
  if (shift.clock_out_at) {
    throw new Error(`startBreak: shift ${trimmedShiftId} is already closed`);
  }

  // A double-tap or a retry on bad signal returns the break already running.
  // Restarting it would silently move its start time and overpay the day.
  const running = await getOpenBreakRow(db, trimmedShiftId);
  if (running) return toShiftBreak(running);

  const { data, error } = await db
    .from('shift_breaks')
    .insert({
      shift_id: trimmedShiftId,
      crew_member_id: trimmedCrewMemberId,
      source,
    })
    .select(SELECT)
    .maybeSingle();

  if (error) {
    if (isOpenBreakUniqueViolation(error as { code?: string; message?: string })) {
      const winner = await getOpenBreakRow(db, trimmedShiftId);
      if (winner) return toShiftBreak(winner);
    }
    throw new Error(`startBreak: ${error.message}`);
  }
  if (!data) throw new Error(`startBreak: no row returned for shift ${trimmedShiftId}`);
  return toShiftBreak(data as Row);
}

export async function endBreak(
  breakId: string,
  crewMemberId: string,
  source: ShiftSource,
): Promise<ShiftBreak> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const trimmedBreakId = breakId.trim();
  const trimmedCrewMemberId = crewMemberId.trim();

  const now = new Date().toISOString();
  const { data, error } = await db
    .from('shift_breaks')
    .update({ ended_at: now, end_source: source })
    .eq('id', trimmedBreakId)
    .eq('crew_member_id', trimmedCrewMemberId)
    .is('ended_at', null)
    .select(SELECT)
    .maybeSingle();

  if (error) throw new Error(`endBreak: ${error.message}`);
  if (data) return toShiftBreak(data as Row);

  const row = await getBreakRowById(db, trimmedBreakId);
  if (!row) throw new Error(`endBreak: no break found for id ${trimmedBreakId}`);
  if (row.crew_member_id !== trimmedCrewMemberId) {
    throw new Error(
      `endBreak: break ${trimmedBreakId} belongs to ${row.crew_member_id}, not ${trimmedCrewMemberId}`,
    );
  }
  if (row.ended_at) throw new Error(`endBreak: break ${trimmedBreakId} already ended`);
  throw new Error(`endBreak: break ${trimmedBreakId} could not be ended`);
}

/**
 * Close whatever break is running on a shift, at the punch time.
 *
 * Per the contract's Flow B semantics, clock-out "closes any open segment/break
 * at punch time and flags review" — it does not reject the clock-out, because
 * refusing to let someone go home over a forgotten break-end is worse than
 * flagging it. `auto_closed` is what feeds the `open_break` exception queue.
 *
 * Returns null when nothing was running, which also makes a retried clock-out a
 * no-op rather than something that moves an already-recorded end time.
 *
 * ⚠️ THIS FUNCTION DOES NOT CHECK OWNERSHIP. It takes a shiftId and closes
 * whatever break is open on it, with no crew_member_id guard of its own. The
 * ONLY caller today is `clockOut`, which is safe because it establishes
 * ownership first: its own UPDATE filters on `crew_member_id`, and this is
 * called only after that UPDATE returned a row. Any new caller MUST do the
 * same, or crew member A can close crew member B's break by supplying B's
 * shift id. If you need a standalone break-close, add a crewMemberId guard
 * mirroring `startBreak`/`endBreak` rather than calling this directly.
 */
export async function closeOpenBreakForShift(
  shiftId: string,
  closedAt: string,
  source: ShiftSource,
): Promise<ShiftBreak | null> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const { data, error } = await db
    .from('shift_breaks')
    .update({ ended_at: closedAt, end_source: source, auto_closed: true })
    .eq('shift_id', shiftId.trim())
    .is('ended_at', null)
    .select(SELECT)
    .maybeSingle();

  if (error) throw new Error(`closeOpenBreakForShift: ${error.message}`);
  return data ? toShiftBreak(data as Row) : null;
}
