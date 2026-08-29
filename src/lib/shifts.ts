import { getSupabaseServiceClient } from '@/lib/supabase';
import { closeOpenBreakForShift } from '@/lib/shiftBreaks';
import { closeOpenSegmentForShift } from '@/lib/jobSegments';

export type ShiftSource = 'pwa' | 'telegram' | 'office' | 'system';

export type Shift = {
  id: string;
  crewMemberId: string;
  clockInAt: string;
  clockOutAt: string | null;
  source: ShiftSource;
  closeSource: ShiftSource | null;
  deviceTime: string | null;
  /** Who made a manual admin entry or the last manual edit; null = only ever
   * the crew member's own clock actions. Always a HUMAN identity — GPS never
   * writes payroll, and nothing automated sets this. */
  manualBy: string | null;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: string;
  crew_member_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  source: ShiftSource;
  close_source: ShiftSource | null;
  device_time: string | null;
  manual_by: string | null;
  created_at: string;
  updated_at: string;
};

const SELECT =
  'id, crew_member_id, clock_in_at, clock_out_at, source, close_source, device_time, manual_by, created_at, updated_at';

function toShift(row: Row): Shift {
  return {
    id: row.id,
    crewMemberId: row.crew_member_id,
    clockInAt: row.clock_in_at,
    clockOutAt: row.clock_out_at,
    source: row.source,
    closeSource: row.close_source,
    deviceTime: row.device_time,
    manualBy: row.manual_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isOpenShiftUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '23505' && error.message?.includes('shifts_one_open_per_person') === true;
}

async function getOpenShiftRow(
  db: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  crewMemberId: string,
): Promise<Row | null> {
  const { data, error } = await db
    .from('shifts')
    .select(SELECT)
    .eq('crew_member_id', crewMemberId)
    .is('clock_out_at', null)
    .maybeSingle();
  if (error) throw new Error(`getOpenShift: ${error.message}`);
  return (data as Row | null) ?? null;
}

async function getShiftRowById(
  db: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  shiftId: string,
): Promise<Row | null> {
  const { data, error } = await db.from('shifts').select(SELECT).eq('id', shiftId).maybeSingle();
  if (error) throw new Error(`clockOut: ${error.message}`);
  return (data as Row | null) ?? null;
}

export async function getOpenShift(crewMemberId: string): Promise<Shift | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;

  try {
    const row = await getOpenShiftRow(db, crewMemberId.trim());
    return row ? toShift(row) : null;
  } catch (error) {
    console.error('getOpenShift error:', error);
    return null;
  }
}

export async function clockIn(crewMemberId: string, source: ShiftSource): Promise<Shift> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const trimmedCrewMemberId = crewMemberId.trim();
  const existing = await getOpenShiftRow(db, trimmedCrewMemberId);
  if (existing) return toShift(existing);

  const { data, error } = await db
    .from('shifts')
    .insert({
      crew_member_id: trimmedCrewMemberId,
      source,
    })
    .select(SELECT)
    .maybeSingle();

  if (error) {
    if (isOpenShiftUniqueViolation(error as { code?: string; message?: string })) {
      const winner = await getOpenShiftRow(db, trimmedCrewMemberId);
      if (winner) return toShift(winner);
    }
    throw new Error(`clockIn: ${error.message}`);
  }
  if (!data) throw new Error(`clockIn: no row returned for crew member ${trimmedCrewMemberId}`);
  return toShift(data as Row);
}

export async function clockOut(
  shiftId: string,
  crewMemberId: string,
  source: ShiftSource,
): Promise<Shift> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const trimmedShiftId = shiftId.trim();
  const trimmedCrewMemberId = crewMemberId.trim();

  const now = new Date().toISOString();
  const { data, error } = await db
    .from('shifts')
    .update({ clock_out_at: now, close_source: source })
    .eq('id', trimmedShiftId)
    .eq('crew_member_id', trimmedCrewMemberId)
    .is('clock_out_at', null)
    .select(SELECT)
    .maybeSingle();

  if (error) throw new Error(`clockOut: ${error.message}`);
  if (data) {
    // Flow B: clock-out closes any break still running, at the punch time, and
    // flags it for review (`auto_closed`). It never rejects the clock-out —
    // refusing to let someone go home over a forgotten break-end is worse than
    // flagging it. A failure here is logged rather than thrown for the same
    // reason: the shift is already closed, so throwing would leave a retry
    // hitting "already closed", and the open break is exactly what the
    // `open_break` exception queue exists to catch.
    try {
      await closeOpenBreakForShift(trimmedShiftId, now, source);
    } catch (breakError) {
      console.error('clockOut: failed to auto-close the open break:', breakError);
    }
    // Same contract rule and same failure posture for a job segment left open.
    // The auto-close records `other`, never `completed` — a clock-out says the
    // day ended, not that the job finished. Each close is caught separately so
    // one failing cannot stop the other from running.
    try {
      await closeOpenSegmentForShift(trimmedShiftId, now, source);
    } catch (segmentError) {
      console.error('clockOut: failed to auto-close the open job segment:', segmentError);
    }
    return toShift(data as Row);
  }

  const row = await getShiftRowById(db, trimmedShiftId);
  if (!row) throw new Error(`clockOut: no shift found for id ${trimmedShiftId}`);
  if (row.crew_member_id !== trimmedCrewMemberId) {
    throw new Error(`clockOut: shift ${trimmedShiftId} belongs to ${row.crew_member_id}, not ${trimmedCrewMemberId}`);
  }
  if (row.clock_out_at) throw new Error(`clockOut: shift ${trimmedShiftId} is already closed`);
  throw new Error(`clockOut: shift ${trimmedShiftId} could not be closed`);
}

// ─── Manual admin entries (2026-08-29, Naldo's ruling) ──────────────────────
// An admin reconstructs a forgotten shift, reading the GPS timeline beside the
// form and TYPING the times. GPS never writes payroll: these functions write
// only what a human typed, and stamp who typed it (`manual_by`).
//
// NO PAID-DAY GUARD YET, on purpose and on record: the tool has no
// paid/approved marker on shifts today (payroll approval still happens in
// Copilot). When the Staff payroll build lands a paid marker, editing a paid
// day must start refusing here. Until then the audit stamp is the protection.

/** A typed refusal, so the route can answer with the real reason. */
export class ManualShiftRefusedError extends Error {
  constructor(
    public code: 'invalid-times' | 'overlap' | 'not-found' | 'edit-race',
    message: string,
  ) {
    super(message);
    this.name = 'ManualShiftRefusedError';
  }
}

function assertValidInterval(clockInAt: string, clockOutAt: string): void {
  const inMs = Date.parse(clockInAt);
  const outMs = Date.parse(clockOutAt);
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs)) {
    throw new ManualShiftRefusedError('invalid-times', 'Times must be valid timestamps.');
  }
  if (outMs <= inMs) {
    throw new ManualShiftRefusedError('invalid-times', 'Clock-out must be after clock-in.');
  }
}

/**
 * Refuses when [clockInAt, clockOutAt) overlaps any OTHER shift of this crew
 * member. An open shift occupies all time from its clock-in onward. Fails
 * CLOSED: a lookup error refuses the write — on payroll, refusing a manual
 * entry is a retry; double-paying an overlap is not.
 */
async function assertNoOverlap(
  db: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  crewMemberId: string,
  clockInAt: string,
  clockOutAt: string,
  excludeShiftId: string | null,
): Promise<void> {
  const { data, error } = await db
    .from('shifts')
    .select('id, clock_in_at, clock_out_at')
    .eq('crew_member_id', crewMemberId)
    .lt('clock_in_at', clockOutAt);
  if (error) {
    throw new ManualShiftRefusedError(
      'overlap',
      `Could not check for overlapping shifts (${error.message}). Nothing was written; try again.`,
    );
  }
  const rows = (data as unknown as { id: string; clock_in_at: string; clock_out_at: string | null }[]) ?? [];
  const clash = rows.find(
    (r) => r.id !== excludeShiftId && (r.clock_out_at === null || r.clock_out_at > clockInAt),
  );
  if (clash) {
    throw new ManualShiftRefusedError(
      'overlap',
      'These times overlap another shift for this crew member.',
    );
  }
}

export async function adminCreateShift(input: {
  crewMemberId: string;
  clockInAt: string;
  clockOutAt: string;
  actor: string;
}): Promise<Shift> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');
  const crewMemberId = input.crewMemberId.trim();
  assertValidInterval(input.clockInAt, input.clockOutAt);
  await assertNoOverlap(db, crewMemberId, input.clockInAt, input.clockOutAt, null);

  const { data, error } = await db
    .from('shifts')
    .insert({
      crew_member_id: crewMemberId,
      clock_in_at: input.clockInAt,
      clock_out_at: input.clockOutAt,
      source: 'office',
      close_source: 'office',
      manual_by: input.actor,
    })
    .select(SELECT)
    .maybeSingle();
  if (error) throw new Error(`adminCreateShift: ${error.message}`);
  if (!data) throw new Error('adminCreateShift: no row returned');
  return toShift(data as Row);
}

export async function adminUpdateShiftTimes(input: {
  shiftId: string;
  clockInAt: string;
  clockOutAt: string;
  actor: string;
}): Promise<Shift> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');
  const shiftId = input.shiftId.trim();
  assertValidInterval(input.clockInAt, input.clockOutAt);

  const row = await getShiftRowById(db, shiftId);
  if (!row) throw new ManualShiftRefusedError('not-found', 'No shift with that id.');
  await assertNoOverlap(db, row.crew_member_id, input.clockInAt, input.clockOutAt, shiftId);

  const payload: Record<string, unknown> = {
    clock_in_at: input.clockInAt,
    clock_out_at: input.clockOutAt,
    manual_by: input.actor,
  };
  // Closing a shift that was open records the office as the closer, same as a
  // header clock-out would.
  if (row.clock_out_at === null) payload.close_source = 'office';

  // CAS on updated_at: if anything touched the row between our read and this
  // write (the crew member clocking out, another admin editing), the update
  // matches zero rows and the caller retries against fresh state.
  const { data, error } = await db
    .from('shifts')
    .update(payload)
    .eq('id', shiftId)
    .eq('updated_at', row.updated_at)
    .select(SELECT)
    .maybeSingle();
  if (error) throw new Error(`adminUpdateShiftTimes: ${error.message}`);
  if (!data) {
    throw new ManualShiftRefusedError(
      'edit-race',
      'This shift changed while you were editing it. Reload and try again.',
    );
  }
  // Sibling parity with clockOut(): closing a shift that was OPEN must also
  // close any break or job segment still running on it, at the typed end
  // time, with the same log-not-throw posture (the shift is already closed;
  // the exception queues catch what slips).
  if (row.clock_out_at === null) {
    try {
      await closeOpenBreakForShift(shiftId, input.clockOutAt, 'office');
    } catch (breakError) {
      console.error('adminUpdateShiftTimes: failed to auto-close the open break:', breakError);
    }
    try {
      await closeOpenSegmentForShift(shiftId, input.clockOutAt, 'office');
    } catch (segmentError) {
      console.error('adminUpdateShiftTimes: failed to auto-close the open job segment:', segmentError);
    }
  }
  return toShift(data as Row);
}
