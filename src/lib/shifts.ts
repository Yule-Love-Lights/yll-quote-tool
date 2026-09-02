import { getSupabaseServiceClient } from '@/lib/supabase';
import { closeOpenBreakForShift } from '@/lib/shiftBreaks';
import { closeOpenSegmentForShift } from '@/lib/jobSegments';
import { sendTelegramMessage } from '@/lib/integrations/telegram';

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
// PAID-SHIFT GUARD, added 2026-09-02 (ledger row 459, time-tracking plan
// phase 3). This note used to say there was no such guard because the tool
// had no paid marker; shift_settlements is that marker, so the guard is now
// armed. A shift sitting on a LIVE settlement line cannot have its times
// rewritten or be removed, because somebody has already been paid against
// the hours it records. Undo the payment first, which releases its shifts.
//
// Scoped to the SHIFT, not the day: settlement is per shift, so ADDING a
// shift to a day that already contains a paid one is still allowed. That is
// a correction which adds hours nobody has been paid for yet, and refusing
// it would strand real work behind a payment for different hours.

/** A typed refusal, so the route can answer with the real reason. */
export class ManualShiftRefusedError extends Error {
  constructor(
    public code:
      | 'invalid-times'
      | 'overlap'
      | 'not-found'
      | 'edit-race'
      | 'not-field-crew'
      | 'not-manual'
      | 'has-children'
      | 'audit-failed'
      | 'already-paid',
    message: string,
  ) {
    super(message);
    this.name = 'ManualShiftRefusedError';
  }
}

/**
 * Writes the append-only audit row for a manual payroll write and RETURNS the
 * failure rather than swallowing it.
 *
 * Supabase reports a failed insert as `{ error }` and does not throw, so a
 * try/catch around it only ever sees a transport fault: an RLS refusal, a
 * constraint violation or a column mismatch all came back as a quiet success
 * (S78 wrap, technical lens). Callers decide what a failure means. For create
 * and edit it stays best-effort, because the shift itself is still on screen
 * and recoverable. For a VOID it is fatal, because the row is about to stop
 * existing.
 */
async function writeManualAudit(
  db: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  entry: {
    action: 'shift-manual-create' | 'shift-manual-edit' | 'shift-manual-void';
    actor: string;
    shift: Row;
    before: Record<string, unknown> | null;
    deleted?: boolean;
  },
): Promise<{ message: string } | null> {
  try {
    const { error } = await db.from('dashboard_activity').insert({
      actor: entry.actor,
      action: entry.action,
      detail: {
        shiftId: entry.shift.id,
        crewMemberId: entry.shift.crew_member_id,
        before: entry.before,
        after: entry.deleted
          ? null
          : { clock_in_at: entry.shift.clock_in_at, clock_out_at: entry.shift.clock_out_at },
      },
    });
    return error ? { message: error.message } : null;
  } catch (thrown) {
    return { message: thrown instanceof Error ? thrown.message : String(thrown) };
  }
}

/** Best-effort transparency side effects after a manual write (staff + admin
 * lenses on PR #1062): an append-only audit row with the before/after values,
 * and a Telegram note to the crew member whose pay record was touched. Both
 * log-not-throw — the payroll write already landed, and the audit/notify
 * failing must not make a retry double-write it. */
async function afterManualWrite(
  db: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  entry: {
    action: 'shift-manual-create' | 'shift-manual-edit' | 'shift-manual-void';
    actor: string;
    shift: Row;
    /** For a void this is the ENTIRE deleted row, because the audit entry is
     * then the only copy of it that exists anywhere. */
    before: Record<string, unknown> | null;
    /** A void leaves nothing behind, so the entry says so rather than
     * repeating the deleted times as if they were still live. */
    deleted?: boolean;
  },
): Promise<void> {
  const auditError = await writeManualAudit(db, entry);
  if (auditError) {
    console.error('afterManualWrite: audit insert failed:', auditError);
  }
  await notifyCrewOfManualWrite(db, entry);
}

/** The crew member's Telegram note about a change to their own pay record.
 * Log-not-throw: the payroll write has already landed, and a failed notify
 * must not make a retry double-write it. */
async function notifyCrewOfManualWrite(
  db: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  entry: {
    action: 'shift-manual-create' | 'shift-manual-edit' | 'shift-manual-void';
    actor: string;
    shift: Row;
  },
): Promise<void> {
  try {
    const { data } = await db
      .from('crew_members')
      .select('telegram_user_id')
      .eq('id', entry.shift.crew_member_id)
      .maybeSingle();
    const chatId = (data as { telegram_user_id: string | null } | null)?.telegram_user_id;
    if (chatId) {
      const fmt = (iso: string | null) =>
        iso
          ? new Date(iso).toLocaleString('en-US', {
              timeZone: 'America/New_York',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })
          : 'still open';
      const verb =
        entry.action === 'shift-manual-create'
          ? 'added a shift to'
          : entry.action === 'shift-manual-void'
            ? 'removed a shift from'
            : 'corrected a shift on';
      await sendTelegramMessage(
        chatId,
        `${entry.actor} ${verb} your time record: ${fmt(entry.shift.clock_in_at)} to ${fmt(entry.shift.clock_out_at)}. Tell the office if that looks wrong. This bot only understands clock commands, so a reply here will not reach anyone.`,
      );
    }
  } catch (notifyError) {
    console.error('afterManualWrite: crew Telegram notify failed:', notifyError);
  }
}

/** Ten minutes of slack for clock drift; anything further ahead is a typo. */
const MANUAL_FUTURE_SLACK_MS = 10 * 60_000;

function assertValidInterval(clockInAt: string, clockOutAt: string): void {
  const inMs = Date.parse(clockInAt);
  const outMs = Date.parse(clockOutAt);
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs)) {
    throw new ManualShiftRefusedError('invalid-times', 'Times must be valid timestamps.');
  }
  if (outMs <= inMs) {
    throw new ManualShiftRefusedError('invalid-times', 'Clock-out must be after clock-in.');
  }
  // Manual entries reconstruct the PAST. A future-dated clock-out is a typo,
  // and a dangerous one: it would sit in the crew member's timeline and make
  // their next organic clock-in ([now, infinity)) violate the no-overlap
  // constraint with only a generic error — silently locking them out of the
  // clock (S74 post-close integration lens, the #1062 x constraint interaction).
  if (outMs > Date.now() + MANUAL_FUTURE_SLACK_MS) {
    throw new ManualShiftRefusedError(
      'invalid-times',
      'The clock-out is in the future. Manual entries record time already worked.',
    );
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
  clockOutAt: string | null,
  excludeShiftId: string | null,
): Promise<void> {
  // A null clockOutAt means the edited shift stays OPEN — it occupies all
  // time from clockInAt onward, so every other shift of this member is a
  // candidate and only the end-side filter is skipped.
  let query = db
    .from('shifts')
    .select('id, clock_in_at, clock_out_at')
    .eq('crew_member_id', crewMemberId);
  if (clockOutAt !== null) query = query.lt('clock_in_at', clockOutAt);
  const { data, error } = await query;
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

  // Gate at the WRITE, not just the dropdown (the repo's promoted pitfall,
  // caught recurring here by the PR #1062 admin lens): the target must be a
  // real, ACTIVE, FIELD crew member. An office row would also be invisible on
  // the review page afterward, which is what made this worth refusing.
  const { data: crewData, error: crewError } = await db
    .from('crew_members')
    .select('id, active, is_office')
    .eq('id', crewMemberId)
    .maybeSingle();
  if (crewError) throw new Error(`adminCreateShift: crew lookup: ${crewError.message}`);
  const crew = crewData as { id: string; active: boolean; is_office: boolean } | null;
  if (!crew || !crew.active || crew.is_office) {
    throw new ManualShiftRefusedError(
      'not-field-crew',
      'Manual shifts can only be created for active field crew.',
    );
  }

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
  if (error) {
    // 23P01: the shifts_no_overlap exclusion constraint — the DB backstop for
    // the same-instant race the app-level check above cannot see.
    if ((error as { code?: string }).code === '23P01') {
      throw new ManualShiftRefusedError(
        'overlap',
        'These times overlap another shift for this crew member.',
      );
    }
    throw new Error(`adminCreateShift: ${error.message}`);
  }
  if (!data) throw new Error('adminCreateShift: no row returned');
  await afterManualWrite(db, {
    action: 'shift-manual-create',
    actor: input.actor,
    shift: data as Row,
    before: null,
  });
  return toShift(data as Row);
}

/** Every existing break and job segment must fit inside the typed interval.
 * Direct reads (not the child modules' getters) so a failed lookup REFUSES
 * instead of silently passing — the getters fail open by design for their own
 * callers, which is the wrong posture on a payroll write. */
async function assertContainsChildren(
  db: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  shiftId: string,
  clockInAt: string,
  clockOutAt: string | null,
): Promise<void> {
  const refuseUnreadable = (what: string) =>
    new ManualShiftRefusedError(
      'invalid-times',
      `Could not check this shift's ${what}. Nothing was written; try again.`,
    );
  const inMs = Date.parse(clockInAt);
  const outMs = clockOutAt === null ? Infinity : Date.parse(clockOutAt);

  const { data: breakData, error: breakError } = await db
    .from('shift_breaks')
    .select('started_at, ended_at')
    .eq('shift_id', shiftId);
  if (breakError) throw refuseUnreadable('breaks');
  const { data: segData, error: segError } = await db
    .from('job_segments')
    .select('arrived_at, departed_at')
    .eq('shift_id', shiftId);
  if (segError) throw refuseUnreadable('job segments');

  const children: { label: string; start: string; end: string | null }[] = [
    ...(((breakData as unknown as { started_at: string; ended_at: string | null }[]) ?? []).map(
      (b) => ({ label: 'a break', start: b.started_at, end: b.ended_at }),
    )),
    ...(((segData as unknown as { arrived_at: string; departed_at: string | null }[]) ?? []).map(
      (s) => ({ label: 'a job segment', start: s.arrived_at, end: s.departed_at }),
    )),
  ];
  for (const child of children) {
    if (Date.parse(child.start) < inMs) {
      throw new ManualShiftRefusedError(
        'invalid-times',
        `This shift has ${child.label} that started at ${child.start}; the clock-in must be at or before that.`,
      );
    }
    const childEnd = child.end === null ? Date.parse(child.start) + 1 : Date.parse(child.end);
    if (childEnd > outMs) {
      throw new ManualShiftRefusedError(
        'invalid-times',
        `This shift has ${child.label} running past the typed clock-out (${child.end ?? 'still running from ' + child.start}); the clock-out must cover it.`,
      );
    }
  }
}

export async function adminUpdateShiftTimes(input: {
  shiftId: string;
  /** null = keep the shift OPEN (valid only while it IS open — a crew member
   * still working keeps working; PR #1062 staff lens: force-closing here made
   * their bot say "not clocked in" mid-shift and lost the rest of the day). */
  clockOutAt: string | null;
  clockInAt: string;
  actor: string;
}): Promise<Shift> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');
  const shiftId = input.shiftId.trim();
  if (input.clockOutAt !== null) {
    assertValidInterval(input.clockInAt, input.clockOutAt);
  } else if (!Number.isFinite(Date.parse(input.clockInAt))) {
    throw new ManualShiftRefusedError('invalid-times', 'Times must be valid timestamps.');
  } else if (Date.parse(input.clockInAt) > Date.now() + MANUAL_FUTURE_SLACK_MS) {
    // Same future-typo mine as the clock-out check, from the keep-open side.
    throw new ManualShiftRefusedError(
      'invalid-times',
      'The clock-in is in the future. Manual entries record time already worked.',
    );
  }

  const row = await getShiftRowById(db, shiftId);
  if (!row) throw new ManualShiftRefusedError('not-found', 'No shift with that id.');
  if (input.clockOutAt === null && row.clock_out_at !== null) {
    throw new ManualShiftRefusedError(
      'invalid-times',
      'A closed shift needs a clock-out time; clearing it would reopen the shift.',
    );
  }
  await assertNoOverlap(db, row.crew_member_id, input.clockInAt, input.clockOutAt, shiftId);

  const closingOpenShift = row.clock_out_at === null && input.clockOutAt !== null;

  // CONTAINMENT RULE (PR #1062 delta-verify): the typed interval must CONTAIN
  // every break and job segment this shift already has — pulling the clock-in
  // later than a break's start clips the break out of the pay math exactly the
  // way a too-early clock-out does (paidSecondsForShift clips child spans to
  // the shift envelope and silently drops what falls outside). One rule kills
  // the class from both ends, compared numerically, never as strings.
  //
  // FAIL-CLOSED: if the children cannot be read, the edit is refused — on
  // payroll a refusal is a retry; a clipped break is silent overpay.
  //
  // Known residual, on record: this is check-then-act. A break the bot starts
  // in the instant between this read and the CAS write below is not seen; the
  // window is milliseconds, the writer is one crew member's own bot action,
  // and closing it needs a DB transaction this codebase does not use yet.
  await assertContainsChildren(db, shiftId, input.clockInAt, input.clockOutAt);

  // Row 459: refuse if somebody has already been paid for these hours.
  await assertNotSettled(db, shiftId, 'edited');

  const payload: Record<string, unknown> = {
    clock_in_at: input.clockInAt,
    clock_out_at: input.clockOutAt,
    manual_by: input.actor,
  };
  // Closing a shift that was open records the office as the closer, same as a
  // header clock-out would.
  if (closingOpenShift) payload.close_source = 'office';

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
  if (error) {
    if ((error as { code?: string }).code === '23P01') {
      throw new ManualShiftRefusedError(
        'overlap',
        'These times overlap another shift for this crew member.',
      );
    }
    throw new Error(`adminUpdateShiftTimes: ${error.message}`);
  }
  if (!data) {
    throw new ManualShiftRefusedError(
      'edit-race',
      'This shift changed while you were editing it. Reload and try again.',
    );
  }
  // Sibling parity with clockOut(): closing a shift that was OPEN must also
  // close any break or job segment still running on it, at the typed end
  // time, with the same log-not-throw posture (the shift is already closed;
  // the exception queues catch what slips). The pre-close guard above already
  // proved the typed time is after each child's start.
  if (closingOpenShift) {
    try {
      await closeOpenBreakForShift(shiftId, input.clockOutAt as string, 'office');
    } catch (breakError) {
      console.error('adminUpdateShiftTimes: failed to auto-close the open break:', breakError);
    }
    try {
      await closeOpenSegmentForShift(shiftId, input.clockOutAt as string, 'office');
    } catch (segmentError) {
      console.error('adminUpdateShiftTimes: failed to auto-close the open job segment:', segmentError);
    }
  }
  await afterManualWrite(db, {
    action: 'shift-manual-edit',
    actor: input.actor,
    shift: data as Row,
    before: { clock_in_at: row.clock_in_at, clock_out_at: row.clock_out_at },
  });
  return toShift(data as Row);
}

/**
 * Void a manual office entry: DELETE the row (row 458).
 *
 * A shift that should never have existed cannot be fixed by editing its
 * times. Shrinking it to a minute still leaves a minute of pay against a day
 * the person did not work, so the only honest correction is removal.
 *
 * Deleting payroll is only safe because of what it refuses, and all three
 * guards fail CLOSED:
 *
 * 1. The row must be a MANUAL office entry (`source = 'office'` AND a
 *    `manual_by` stamp). A shift the crew member clocked themselves is their
 *    record of their own day; the office corrects it, never erases it.
 * 2. The row must carry no break and no job segment. Those rows reference the
 *    shift and hold their own time; a shift with either is real activity, and
 *    an unreadable child lookup refuses rather than deletes blind.
 * 3. A compare-and-swap on `updated_at`: if anything touched the row between
 *    the read and the delete, the delete matches nothing and the admin looks
 *    again. Deleting a row somebody just changed is deleting a row nobody
 *    reviewed.
 *
 * The deleted row is written to the activity trail in full before this
 * returns, because that entry is then the only copy of it anywhere.
 */
export async function adminVoidShift(input: { shiftId: string; actor: string }): Promise<void> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');
  const shiftId = input.shiftId.trim();

  const row = await getShiftRowById(db, shiftId);
  if (!row) throw new ManualShiftRefusedError('not-found', 'No shift with that id.');

  if (row.source !== 'office' || !row.manual_by) {
    throw new ManualShiftRefusedError(
      'not-manual',
      'Only a manual office entry can be removed. Correct the times instead.',
    );
  }

  await assertNoChildren(db, shiftId);

  // Row 459: refuse if somebody has already been paid for these hours. Before
  // the audit write, so a refused void leaves no trail entry describing a
  // removal that never happened.
  await assertNotSettled(db, shiftId, 'removed');

  // The audit row goes in BEFORE the row is destroyed, and a failure REFUSES
  // the void (S78 wrap, technical lens). It used to be written afterwards by
  // the same best-effort helper the create and edit paths use, which meant a
  // failed insert left a payroll row deleted with no record of it anywhere
  // while the admin was told it worked. Of the two ways this can lie, an
  // entry for a removal that did not happen is the recoverable one: the shift
  // is still on the page. A vanished row with no entry is not.
  const auditError = await writeManualAudit(db, {
    action: 'shift-manual-void',
    actor: input.actor,
    shift: row,
    before: { ...(row as unknown as Record<string, unknown>) },
    deleted: true,
  });
  if (auditError) {
    // The cause is logged, never shown: a persistent failure here (an RLS
    // misconfiguration, a constraint) would otherwise be an opaque "try
    // again" loop with nothing to diagnose it from.
    console.error('adminVoidShift: audit insert refused the void:', auditError.message);
    throw new ManualShiftRefusedError(
      'audit-failed',
      'The activity log could not record this removal, so nothing was removed. Try again.',
    );
  }

  const { data, error } = await db
    .from('shifts')
    .delete()
    .eq('id', shiftId)
    .eq('updated_at', row.updated_at)
    .select(SELECT)
    .maybeSingle();
  if (error) {
    await recordVoidAborted(db, input.actor, shiftId, 'delete-failed');
    throw new Error(`adminVoidShift: ${error.message}`);
  }
  if (!data) {
    await recordVoidAborted(db, input.actor, shiftId, 'edit-race');
    throw new ManualShiftRefusedError(
      'edit-race',
      'This shift changed while you were looking at it. Reload and try again.',
    );
  }

  // The audit row is already written; this only sends the crew member their
  // note, and stays log-not-throw because the delete has landed.
  await notifyCrewOfManualWrite(db, {
    action: 'shift-manual-void',
    actor: input.actor,
    shift: data as Row,
  });
}

/**
 * Refuses when the shift sits on a LIVE settlement line — somebody has been
 * paid against the hours this row records (ledger row 459).
 *
 * The question is asked HERE, against the lines table, rather than by
 * importing shiftSettlements.ts: the guard belongs at the state change it
 * protects, and a second copy of it exported from that module is something a
 * test can reach for instead of the real one, which is how the advertising
 * equivalent once shipped with a missing filter.
 *
 * Fails CLOSED. An unreadable lookup refuses the write, because on payroll a
 * refusal costs a retry and rewriting hours somebody was already paid for
 * costs a correction nobody can see.
 */
async function assertNotSettled(
  db: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  shiftId: string,
  what: 'edited' | 'removed',
): Promise<void> {
  const { data, error } = await db
    .from('shift_settlement_lines')
    .select('id, settlement_id')
    .eq('shift_id', shiftId)
    .is('voided_at', null)
    .limit(1);
  if (error) {
    throw new ManualShiftRefusedError(
      'already-paid',
      `Could not check whether this shift has been paid (${error.message}). Nothing was changed; try again.`,
    );
  }
  if ((data ?? []).length > 0) {
    throw new ManualShiftRefusedError(
      'already-paid',
      `This shift has already been paid, so it cannot be ${what}. Undo that payment on this person's page first — that releases the shift.`,
    );
  }
}

/**
 * Refuses when the shift has any break or job segment attached. Fails CLOSED:
 * a lookup error refuses the void, because deleting a parent whose children
 * we could not read is exactly the case this guard exists for.
 */
async function assertNoChildren(
  db: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  shiftId: string,
): Promise<void> {
  const refuse = (message: string) => new ManualShiftRefusedError('has-children', message);

  const { data: breakData, error: breakError } = await db
    .from('shift_breaks')
    .select('id')
    .eq('shift_id', shiftId);
  if (breakError) throw refuse('Could not check this shift for breaks. Nothing was removed.');
  if (((breakData as unknown as { id: string }[]) ?? []).length > 0) {
    throw refuse('This shift has a break on it, so it records real time. Correct the times instead.');
  }

  const { data: segData, error: segError } = await db
    .from('job_segments')
    .select('id')
    .eq('shift_id', shiftId);
  if (segError) throw refuse('Could not check this shift for job time. Nothing was removed.');
  if (((segData as unknown as { id: string }[]) ?? []).length > 0) {
    throw refuse('This shift has job time on it, so it records real work. Correct the times instead.');
  }
}

/**
 * Corrects the activity trail when the audit row landed but the delete did
 * not (S78 wrap delta-verify).
 *
 * The void writes its record FIRST so a deleted row can never go unrecorded.
 * That ordering has a mirror case: the entry says a shift was removed and
 * then the delete is refused, which leaves the trail asserting something
 * false about payroll. A second append-only entry says so, rather than
 * leaving the reader to infer it from a shift that is still there.
 *
 * Log-not-throw on purpose: the caller is already throwing the real refusal,
 * and a failure to write the correction must not replace it with a different
 * error.
 */
async function recordVoidAborted(
  db: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  actor: string,
  shiftId: string,
  reason: 'edit-race' | 'delete-failed',
): Promise<void> {
  try {
    const { error } = await db.from('dashboard_activity').insert({
      actor,
      action: 'shift-manual-void-aborted',
      detail: { shiftId, reason, note: 'The shift was NOT removed. The entry above did not happen.' },
    });
    if (error) {
      console.error('recordVoidAborted: could not correct the trail:', error.message);
    }
  } catch (thrown) {
    console.error('recordVoidAborted: could not correct the trail:', thrown);
  }
}
