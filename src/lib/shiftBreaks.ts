import { getSupabaseServiceClient } from '@/lib/supabase';
import type { ShiftSource } from '@/lib/shifts';
import {
  ceilSeconds,
  clipAndMerge,
  envelopeMs,
  floorSeconds,
  resolveNowMs,
  totalMs,
  type OpenInterval,
  type Span,
} from '@/lib/timeSpans';

/**
 * Break tracking on the shift clock ledger.
 *
 * Breaks are UNPAID: paid time for a shift is the clock envelope minus break
 * time. That rule used to cite OPERATIONS_HUB_CONTRACT.md section 8, which was
 * deleted with the scrapped Operations Hub (row 433). The rule itself did not
 * change, so it is stated here directly rather than pointing at a file that no
 * longer exists. Paid seconds are the union of paid-day intervals excluding
 * unpaid breaks. That number
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
//
// The interval arithmetic itself now lives in `timeSpans.ts`, shared with job
// segments. The rounding rule and the reasons behind it are documented there;
// this module just adapts the shift/break shapes onto it.
// ---------------------------------------------------------------------------

type ShiftEnvelope = { clockInAt: string; clockOutAt: string | null };
type BreakInterval = { startedAt: string; endedAt: string | null };

/** Shift row shape -> the shared interval shape. */
export function shiftEnvelopeInterval(shift: ShiftEnvelope): OpenInterval {
  return { start: shift.clockInAt, end: shift.clockOutAt };
}

/** Break row shape -> the shared interval shape. */
export function breakInterval(item: BreakInterval): OpenInterval {
  return { start: item.startedAt, end: item.endedAt };
}

/** The merged, clipped break spans inside a shift. Exported for job-segment math. */
export function breakSpansForShift(
  shift: ShiftEnvelope,
  breaks: ReadonlyArray<BreakInterval>,
  nowMs: number,
): Span[] {
  const envelope = envelopeMs(shiftEnvelopeInterval(shift), nowMs);
  if (!envelope) return [];
  return clipAndMerge(envelope, breaks.map(breakInterval), nowMs);
}

/** The whole clock envelope in seconds, before break time comes off it. */
function envelopeSecondsForShift(shift: ShiftEnvelope, nowMs: number): number {
  const envelope = envelopeMs(shiftEnvelopeInterval(shift), nowMs);
  if (!envelope) return 0;
  return ceilSeconds(envelope.end - envelope.start);
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
  return breakSecondsAt(shift, breaks, resolveNowMs(nowIso));
}

/**
 * The `nowMs`-threaded form. Anything needing more than one figure for the SAME
 * instant must use this rather than calling the public wrappers repeatedly.
 *
 * `paidSecondsForShift` used to resolve the clock for its envelope and then pass
 * `nowIso` (undefined in the live case) down to `breakSecondsForShift`, which
 * read the clock a SECOND time. On an open shift with an open break those two
 * reads can straddle a second boundary, and the extra millisecond of break gets
 * charged against an envelope measured before it existed — one paid second
 * short, corresponding to no real instant. Caught by the S59 review's money
 * lens; `jobSegments.ts` already threaded `nowMs` this way.
 */
function breakSecondsAt(
  shift: ShiftEnvelope,
  breaks: ReadonlyArray<BreakInterval>,
  nowMs: number,
): number {
  return Math.min(
    floorSeconds(totalMs(breakSpansForShift(shift, breaks, nowMs))),
    envelopeSecondsForShift(shift, nowMs),
  );
}

/** Paid seconds for the shift: the clock envelope minus unpaid break time. Never negative. */
export function paidSecondsForShift(
  shift: ShiftEnvelope,
  breaks: ReadonlyArray<BreakInterval>,
  nowIso?: string,
): number {
  // ONE clock read for the whole calculation.
  const nowMs = resolveNowMs(nowIso);
  return Math.max(0, envelopeSecondsForShift(shift, nowMs) - breakSecondsAt(shift, breaks, nowMs));
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
