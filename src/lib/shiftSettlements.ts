// Shift settlements — time-tracking plan phase 3, ledger row 459.
// Jason's ruling 2026-09-02.
//
// personHours.ts knows what a person has WORKED. This module knows what has
// been HANDED OVER, and which shifts that payment covered.
//
// THE TOOL DOES NOT CALCULATE PAY. Jason: "we pay them via another
// website/cash/bank transfer, and THEN we mark the hours as approved." So
// `totalCents` is typed by an admin and is the money record. The per-line
// hours and rate are a REFERENCE, stamped at the moment of payment so a later
// correction to the shift, or a change to the person's rate, cannot rewrite
// what a payment was made against.
//
// The reference and the total are ALLOWED TO DIFFER, and nothing asserts they
// match. That is the point: overtime (ledger row 285, parked pending an
// accountant, and already live — one person logged 50h 55m in seven days),
// a cash payment rounded up, an advance, a deduction agreed off-system.
// Asserting equality here would force the tool to have an opinion about
// payroll maths that nobody has ruled on.
//
// SETTLED and UNSETTLED are DERIVED, never stored:
//   settled(person)   = sum of that person's LIVE settlement totals
//   unsettled shifts  = closed shifts with no live settlement line
// A stored balance drifts; a derived one cannot. Same posture as
// advertising/payouts.ts, which this mirrors structurally rather than
// inventing a second money-approval mechanism in one codebase.
//
// A SETTLED SHIFT CANNOT BE EDITED OR REMOVED. That guard lives at the state
// change in shifts.ts, next to the write it protects, and asks its own
// question against shift_settlement_lines — the same posture voidPlacement
// takes for advertising. This module deliberately exposes no second copy of
// it for a caller to reach for instead of the real one.

import { getSupabaseServiceClient } from '@/lib/supabase';
import { paidSecondsForShift } from '@/lib/shiftBreaks';
import { resolveNowMs } from '@/lib/timeSpans';

/**
 * How the money physically moved. The SAME four values as
 * advertising/payouts.ts, so "how much did we pay in cash this month" stays
 * answerable across both — but declared here rather than imported, because
 * importing that module would drag advertising placements, workers and
 * activity logging into a payroll module that needs none of them. The list
 * is four strings; the coupling would not be.
 */
export const SETTLEMENT_METHODS = ['cash', 'venmo', 'check', 'other'] as const;
export type SettlementMethod = (typeof SETTLEMENT_METHODS)[number];

export function isSettlementMethod(value: unknown): value is SettlementMethod {
  return typeof value === 'string' && (SETTLEMENT_METHODS as readonly string[]).includes(value);
}

export class SettlementRefusedError extends Error {
  constructor(
    public readonly code:
      | 'no-shifts'
      | 'not-found'
      | 'not-theirs'
      | 'still-open'
      | 'already-settled'
      | 'invalid-amount'
      | 'invalid-method'
      | 'lost-race',
    message: string,
  ) {
    super(message);
    this.name = 'SettlementRefusedError';
  }
}

export type ShiftSettlementLine = {
  id: string;
  shiftId: string;
  paidSeconds: number;
  rateCentsPerHour: number;
  referenceCents: number;
  voidedAt: string | null;
};

export type ShiftSettlement = {
  id: string;
  crewMemberId: string;
  totalCents: number;
  method: SettlementMethod;
  note: string | null;
  paidAt: string;
  paidBy: string | null;
  createdAt: string;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  lines: ShiftSettlementLine[];
  /** The stamped hours this payment covered, summed over its LIVE lines. */
  coveredSeconds: number;
  /** What those hours came to at the stamped rates. A reference only; it is
   * not what was paid, and the two are allowed to differ. */
  referenceCents: number;
};

/**
 * PURE. What `paidSeconds` at `rateCentsPerHour` comes to, in whole cents,
 * rounded to NEAREST.
 *
 * Nearest rather than up or down because this figure is a reference an admin
 * reads, never money that moves: the amount that moves is the one they type.
 * Rounding half a cent in either direction cannot underpay anybody, so the
 * least surprising rule wins over a protective one.
 */
export function referenceCentsFor(paidSeconds: number, rateCentsPerHour: number): number {
  if (!Number.isFinite(paidSeconds) || !Number.isFinite(rateCentsPerHour)) return 0;
  if (paidSeconds <= 0 || rateCentsPerHour <= 0) return 0;
  return Math.round((paidSeconds * rateCentsPerHour) / 3600);
}

/** Cents as an admin reads them. */
export function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/**
 * PURE. A typed amount as whole cents, or null when it is not a payment.
 *
 * Accepts what a person types into a money field: "1350", "1,350.00",
 * "$1350.00", " 1350.5 ". Refuses zero, negative, non-numeric, and anything
 * finer than a cent, because a payment of 1350.005 is a typo rather than an
 * amount, and silently rounding somebody's pay is not this function's call.
 */
export function parseAmountCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return null;
  return cents;
}

type Db = NonNullable<ReturnType<typeof getSupabaseServiceClient>>;

const PAGE = 1000;
const ID_CHUNK = 200;

const SETTLEMENT_SELECT =
  'id, crew_member_id, total_cents, method, note, paid_at, paid_by, created_at, voided_at, voided_by, void_reason';
const LINE_SELECT =
  'id, settlement_id, shift_id, paid_seconds, rate_cents_per_hour, reference_cents, voided_at';

type SettlementRow = {
  id: string;
  crew_member_id: string;
  total_cents: number;
  method: string;
  note: string | null;
  paid_at: string;
  paid_by: string | null;
  created_at: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
};

type LineRow = {
  id: string;
  settlement_id: string;
  shift_id: string;
  paid_seconds: number;
  rate_cents_per_hour: number;
  reference_cents: number;
  voided_at: string | null;
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function requireDb(): Db {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');
  return db;
}

function toLine(row: LineRow): ShiftSettlementLine {
  return {
    id: row.id,
    shiftId: row.shift_id,
    paidSeconds: row.paid_seconds,
    rateCentsPerHour: row.rate_cents_per_hour,
    referenceCents: row.reference_cents,
    voidedAt: row.voided_at,
  };
}

function toSettlement(row: SettlementRow, lines: LineRow[]): ShiftSettlement {
  const live = lines.filter((l) => !l.voided_at);
  return {
    id: row.id,
    crewMemberId: row.crew_member_id,
    totalCents: row.total_cents,
    // The CHECK constraint restricts this column to the four known values, so
    // anything else means the constraint was changed without this file.
    method: row.method as SettlementMethod,
    note: row.note,
    paidAt: row.paid_at,
    paidBy: row.paid_by,
    createdAt: row.created_at,
    voidedAt: row.voided_at,
    voidedBy: row.voided_by,
    voidReason: row.void_reason,
    lines: lines.map(toLine),
    coveredSeconds: live.reduce((sum, l) => sum + l.paid_seconds, 0),
    referenceCents: live.reduce((sum, l) => sum + l.reference_cents, 0),
  };
}

/** Paged to completeness and THROWS on a short read: a settled total computed
 * from a truncated page understates what has been paid, which is how somebody
 * gets paid twice. */
async function readSettlements(db: Db, crewMemberId: string): Promise<SettlementRow[]> {
  const rows: SettlementRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('shift_settlements')
      .select(SETTLEMENT_SELECT)
      .eq('crew_member_id', crewMemberId)
      .order('paid_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`readSettlements: ${error.message}`);
    const page = (data ?? []) as SettlementRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

async function readLinesForSettlements(db: Db, settlementIds: string[]): Promise<LineRow[]> {
  if (settlementIds.length === 0) return [];
  const rows: LineRow[] = [];
  for (const ids of chunk(settlementIds, ID_CHUNK)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('shift_settlement_lines')
        .select(LINE_SELECT)
        .in('settlement_id', ids)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`readLinesForSettlements: ${error.message}`);
      const page = (data ?? []) as LineRow[];
      rows.push(...page);
      if (page.length < PAGE) break;
    }
  }
  return rows;
}

/**
 * Which of these shifts already sit on a LIVE settlement line, and on which
 * settlement. Used to mark rows on screen; the write path asks the same
 * question again for itself, because a screen's answer is minutes old.
 */
export async function settledShiftIds(
  shiftIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (shiftIds.length === 0) return out;
  const db = requireDb();
  for (const ids of chunk(shiftIds, ID_CHUNK)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('shift_settlement_lines')
        .select('shift_id, settlement_id, voided_at')
        .in('shift_id', ids)
        .is('voided_at', null)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`settledShiftIds: ${error.message}`);
      const page = (data ?? []) as { shift_id: string; settlement_id: string }[];
      for (const row of page) out.set(row.shift_id, row.settlement_id);
      if (page.length < PAGE) break;
    }
  }
  return out;
}

/** One person's payments, newest first, with their lines attached. */
export async function listSettlements(crewMemberId: string): Promise<ShiftSettlement[]> {
  const db = requireDb();
  const rows = await readSettlements(db, crewMemberId);
  if (rows.length === 0) return [];
  const lines = await readLinesForSettlements(
    db,
    rows.map((r) => r.id),
  );
  const bySettlement = new Map<string, LineRow[]>();
  for (const line of lines) {
    const list = bySettlement.get(line.settlement_id);
    if (list) list.push(line);
    else bySettlement.set(line.settlement_id, [line]);
  }
  return rows.map((row) => toSettlement(row, bySettlement.get(row.id) ?? []));
}

export type SettlementSummary = {
  /** Sum of LIVE settlement totals — what this person has actually been
   * handed, as recorded. Voided payments count for nothing. */
  settledCents: number;
  settlementCount: number;
  lastPaidAt: string | null;
};

export function summarize(settlements: readonly ShiftSettlement[]): SettlementSummary {
  const live = settlements.filter((s) => !s.voidedAt);
  return {
    settledCents: live.reduce((sum, s) => sum + s.totalCents, 0),
    settlementCount: live.length,
    lastPaidAt: live.reduce<string | null>(
      (latest, s) => (latest === null || s.paidAt > latest ? s.paidAt : latest),
      null,
    ),
  };
}

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------

type ShiftRow = {
  id: string;
  crew_member_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
};

/**
 * Record that money was handed to a person for these exact shifts.
 *
 * Every named shift is re-read and must still be theirs, CLOSED, and unpaid —
 * checked at the write, not against whatever the screen was showing. An OPEN
 * shift is refused because its hours are still growing: paying one would
 * stamp a reference figure that was already wrong when it was written.
 *
 * Under a double-submit the DATABASE decides, not this code: `shift_id` is
 * unique across live settlement lines, so the second insert loses, its own
 * settlement row is unwound, and the caller gets a named conflict. That is
 * why the settlement is written BEFORE its lines — the row it would leave
 * behind on a lost race is removable, whereas lines with no parent are not.
 */
export async function recordShiftSettlement(input: {
  crewMemberId: string;
  shiftIds: readonly string[];
  totalCents: number;
  paidBy: string;
  method: SettlementMethod;
  note?: string | null;
  nowIso?: string;
}): Promise<ShiftSettlement> {
  const db = requireDb();

  if (!isSettlementMethod(input.method)) {
    throw new SettlementRefusedError(
      'invalid-method',
      `Pick how it was paid: ${SETTLEMENT_METHODS.join(', ')}.`,
    );
  }
  if (!Number.isInteger(input.totalCents) || input.totalCents <= 0) {
    throw new SettlementRefusedError(
      'invalid-amount',
      'Enter the amount actually paid, as a positive figure.',
    );
  }

  const crewMemberId = input.crewMemberId.trim();
  const ids = [...new Set(input.shiftIds.map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) {
    throw new SettlementRefusedError('no-shifts', 'Pick at least one shift this payment covers.');
  }

  // The person, for the rate to stamp. Read at the write so the reference
  // reflects the rate in force when the payment was recorded.
  const { data: crewData, error: crewError } = await db
    .from('crew_members')
    .select('id, display_name, base_rate_cents')
    .eq('id', crewMemberId)
    .maybeSingle();
  if (crewError) throw new Error(`recordShiftSettlement: crew lookup: ${crewError.message}`);
  const crew = crewData as { id: string; display_name: string; base_rate_cents: number } | null;
  if (!crew) throw new SettlementRefusedError('not-found', 'No staff member with that id.');

  // Re-read every named shift.
  const shiftRows: ShiftRow[] = [];
  for (const part of chunk(ids, ID_CHUNK)) {
    const { data, error } = await db
      .from('shifts')
      .select('id, crew_member_id, clock_in_at, clock_out_at')
      .in('id', part);
    if (error) throw new Error(`recordShiftSettlement: shifts: ${error.message}`);
    shiftRows.push(...((data ?? []) as ShiftRow[]));
  }
  const byId = new Map(shiftRows.map((r) => [r.id, r]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      throw new SettlementRefusedError(
        'not-found',
        'One of those shifts no longer exists. Reload and try again.',
      );
    }
    if (row.crew_member_id !== crewMemberId) {
      throw new SettlementRefusedError(
        'not-theirs',
        `One of those shifts does not belong to ${crew.display_name}. Reload and try again.`,
      );
    }
    if (row.clock_out_at === null) {
      throw new SettlementRefusedError(
        'still-open',
        'One of those shifts is still running. A shift can only be paid once it has been clocked out.',
      );
    }
  }

  // Already paid? The unique index is the real guarantee; this check exists to
  // give a person a sentence instead of a constraint violation.
  const alreadySettled = await settledShiftIds(ids);
  if (alreadySettled.size > 0) {
    throw new SettlementRefusedError(
      'already-settled',
      `${alreadySettled.size} of those shifts ${alreadySettled.size === 1 ? 'has' : 'have'} already been paid. Reload and try again.`,
    );
  }

  // The breaks, for the stamped hours. Read failure REFUSES: with no break
  // rows nothing is subtracted, so the reference would overstate the hours
  // this payment says it covered.
  const breakRows: { shift_id: string; started_at: string; ended_at: string | null }[] = [];
  for (const part of chunk(ids, ID_CHUNK)) {
    const { data, error } = await db
      .from('shift_breaks')
      .select('shift_id, started_at, ended_at')
      .in('shift_id', part);
    if (error) {
      throw new Error(
        `recordShiftSettlement: breaks could not be read (${error.message}); nothing was recorded`,
      );
    }
    breakRows.push(...((data ?? []) as typeof breakRows));
  }
  const breaksByShift = new Map<string, { startedAt: string; endedAt: string | null }[]>();
  for (const b of breakRows) {
    const list = breaksByShift.get(b.shift_id);
    const entry = { startedAt: b.started_at, endedAt: b.ended_at };
    if (list) list.push(entry);
    else breaksByShift.set(b.shift_id, [entry]);
  }

  const nowIso = new Date(resolveNowMs(input.nowIso)).toISOString();
  const linePayloads = ids.map((id) => {
    const row = byId.get(id) as ShiftRow;
    const paidSeconds = paidSecondsForShift(
      { clockInAt: row.clock_in_at, clockOutAt: row.clock_out_at },
      breaksByShift.get(id) ?? [],
      nowIso,
    );
    return {
      shift_id: id,
      paid_seconds: paidSeconds,
      rate_cents_per_hour: crew.base_rate_cents,
      reference_cents: referenceCentsFor(paidSeconds, crew.base_rate_cents),
    };
  });

  const { data: created, error: createError } = await db
    .from('shift_settlements')
    .insert({
      crew_member_id: crewMemberId,
      total_cents: input.totalCents,
      method: input.method,
      note: input.note?.trim() || null,
      paid_at: nowIso,
      paid_by: input.paidBy,
    })
    .select(SETTLEMENT_SELECT)
    .maybeSingle();
  if (createError) throw new Error(`recordShiftSettlement: ${createError.message}`);
  const settlement = created as SettlementRow | null;
  if (!settlement) throw new Error('recordShiftSettlement: no settlement row returned');

  const { data: lineData, error: lineError } = await db
    .from('shift_settlement_lines')
    .insert(linePayloads.map((l) => ({ ...l, settlement_id: settlement.id })))
    .select(LINE_SELECT);
  if (lineError) {
    // Unwind: a settlement with no lines is a payment against nothing, and it
    // would count toward what this person has been paid. Deleting it is safe
    // precisely because no line ever attached to it.
    const { error: unwindError } = await db
      .from('shift_settlements')
      .delete()
      .eq('id', settlement.id);
    const lostRace = (lineError as { code?: string }).code === '23505';
    if (unwindError) {
      // Say what is actually true: an empty payment is on the books.
      throw new Error(
        `recordShiftSettlement: the shifts could not be attached (${lineError.message}) and the empty payment could not be removed (${unwindError.message}) — settlement ${settlement.id} is on the books covering nothing and must be voided by hand`,
      );
    }
    if (lostRace) {
      throw new SettlementRefusedError(
        'lost-race',
        'Someone recorded a payment for one of those shifts while you were on this page. Nothing was recorded here. Reload and try again.',
      );
    }
    throw new Error(`recordShiftSettlement: ${lineError.message}; nothing was recorded`);
  }

  const lines = (lineData ?? []) as LineRow[];
  // Assert what LANDED, not what was sent. A short insert would leave a
  // payment claiming to cover shifts it does not.
  if (lines.length !== linePayloads.length) {
    throw new Error(
      `recordShiftSettlement: expected ${linePayloads.length} shifts on settlement ${settlement.id} but ${lines.length} landed — void it and record it again`,
    );
  }

  return toSettlement(settlement, lines);
}

/**
 * Undo a payment recorded by mistake (mirroring advertising row 492).
 *
 * An OVERLAY, not a delete: the row stays as the record of what was recorded
 * and who undid it, stops counting toward what this person has been paid, and
 * releases its shifts so they can be paid — and corrected — again.
 *
 * The LINES are released first. Until they are stamped the shifts are still
 * claimed, so a failure part-way leaves a whole, live payment rather than one
 * that counts for nothing while its shifts stay locked.
 */
export async function voidShiftSettlement(input: {
  settlementId: string;
  voidedBy: string;
  reason: string;
}): Promise<ShiftSettlement> {
  const db = requireDb();
  const id = input.settlementId.trim();
  const reason = input.reason.trim();
  if (!reason) {
    throw new SettlementRefusedError('invalid-amount', 'Say why this payment is being undone.');
  }

  const { data: existingData, error: readError } = await db
    .from('shift_settlements')
    .select(SETTLEMENT_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (readError) throw new Error(`voidShiftSettlement: ${readError.message}`);
  const existing = existingData as SettlementRow | null;
  if (!existing) throw new SettlementRefusedError('not-found', 'No payment with that id.');

  const lines = await readLinesForSettlements(db, [id]);
  // Idempotent: the first void stands, with its own actor and reason.
  if (existing.voided_at) return toSettlement(existing, lines);

  const voidedAt = new Date().toISOString();

  const { error: linesError } = await db
    .from('shift_settlement_lines')
    .update({ voided_at: voidedAt })
    .eq('settlement_id', id)
    .is('voided_at', null);
  if (linesError) {
    // The FIRST write: the payment is still whole and still counts, so
    // nothing changed is the honest thing to say.
    throw new Error(
      `voidShiftSettlement: the shifts could not be released (${linesError.message}); nothing was undone`,
    );
  }

  const { data, error } = await db
    .from('shift_settlements')
    .update({ voided_at: voidedAt, voided_by: input.voidedBy, void_reason: reason })
    .eq('id', id)
    .is('voided_at', null)
    .select(SETTLEMENT_SELECT)
    .maybeSingle();
  if (error) {
    // NOT "nothing changed": the shifts are already released, so the payment
    // counts as covering nothing while still reading as live. Running the
    // same undo again finishes it, because the line update is a no-op the
    // second time.
    throw new Error(
      `voidShiftSettlement: the shifts were released but payment ${id} still reads as live (${error.message}) — run the undo again to finish it`,
    );
  }

  const voided = data as SettlementRow | null;
  if (!voided) {
    // Another admin won the race. Their stamp stands and the shifts are
    // released either way, so return THEIR row rather than overwriting the
    // reason and actor with ours.
    const { data: currentData } = await db
      .from('shift_settlements')
      .select(SETTLEMENT_SELECT)
      .eq('id', id)
      .maybeSingle();
    const current = currentData as SettlementRow | null;
    if (!current?.voided_at) {
      throw new Error(`voidShiftSettlement: payment ${id} could not be undone`);
    }
    return toSettlement(current, await readLinesForSettlements(db, [id]));
  }

  return toSettlement(voided, await readLinesForSettlements(db, [id]));
}
