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
import { listRates, rateForShiftStart } from '@/lib/crewMemberRates';
import { paidSecondsForShift } from '@/lib/shiftBreaks';
import { resolveNowMs } from '@/lib/timeSpans';
import { sendTelegramMessage } from '@/lib/integrations/telegram';

/**
 * How the money physically moved. Declared here rather than imported from
 * advertising/payouts.ts, because importing that module would drag
 * advertising placements, workers and activity logging into a payroll module
 * that needs none of them. The list is a few strings; the coupling would not
 * be.
 *
 * It STARTED as the same four values as advertising and has since diverged,
 * on purpose: `wise` and `moneygram` were added 2026-09-03 because they are
 * how this company actually pays its office staff (Jason: Wise for Khaye and
 * Ann, MoneyGram for himself), and payroll answering "how much went out by
 * Wise" matters more than the two lists staying identical. Advertising was
 * deliberately left alone — it pays a different population.
 */
export const SETTLEMENT_METHODS = [
  'cash',
  'venmo',
  'check',
  'wise',
  'moneygram',
  'other',
] as const;
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
      | 'no-rate'
      | 'shift-edited'
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
/** The scale factor between "cents per hour" and "cents per second", and so
 * the unit `allocatePayment` keeps its running balance in. */
const SECONDS_PER_HOUR = 3600;

export function referenceCentsFor(paidSeconds: number, rateCentsPerHour: number): number {
  if (!Number.isFinite(paidSeconds) || !Number.isFinite(rateCentsPerHour)) return 0;
  if (paidSeconds <= 0 || rateCentsPerHour <= 0) return 0;
  return Math.round((paidSeconds * rateCentsPerHour) / 3600);
}

/** One shift a payment could be applied to, with what is left owing on it. */
export type PayableRemainder = {
  shiftId: string;
  /** Sort key. The caller passes these OLDEST FIRST; this module does not
   * re-sort, so that the order a payment consumes hours in is decided in one
   * place and is visible to the caller's own tests. */
  clockInAt: string;
  /** The shift's whole paid seconds, breaks already subtracted. */
  totalSeconds: number;
  /** True when the midnight sweep closed this shift, so its clock-out is a
   * placeholder rather than a real time. Carried so the panel where paying
   * LOCKS these hours can say so before the money lands on them. */
  needsReview: boolean;
  /** What is still unpaid on it: `totalSeconds` minus every live line
   * already written against it. Never negative. */
  unpaidSeconds: number;
  /** The rate in force on the ET day this shift STARTED — resolved from the
   * person's rate history, NOT from their rate today (ledger row 506).
   *
   * Carried per shift rather than passed once per payment because a payment
   * can reach across a raise, and an hour worked in August is not worth what
   * an hour worked in September is. Zero means no rate covers that day, and
   * every caller refuses to convert rather than guessing one. */
  rateCentsPerHour: number;
};

export type PaymentAllocation = {
  lines: {
    shiftId: string;
    paidSeconds: number;
    totalSeconds: number;
    /** The rate this shift's hours were bought at — the rate in force on the
     * day it started. Stamped straight onto the settlement line, which is
     * what keeps this payment honest if the rate later moves. */
    rateCentsPerHour: number;
    /** What `paidSeconds` came to at that rate. Summed over the lines this
     * is the money the allocation actually spent. */
    referenceCents: number;
  }[];
  /** Seconds this payment actually covers, across every rate it spanned. */
  secondsCovered: number;
  /** The sum of the lines' own `referenceCents` — what the hours this payment
   * bought are worth at the rates they were bought at.
   *
   * It can differ from `totalCents` by a cent or two IN EITHER DIRECTION,
   * and that is not a defect to chase. Each line rounds its own seconds to
   * the nearest cent, and several independent roundings do not sum to the
   * rounding of the sum: the one real settlement in production sums to
   * $180.01 against a $180.00 payment, and did so before this arithmetic
   * changed. Nothing depends on the two agreeing — `total_cents` is the
   * record of what was handed over, this is what the hours came to, and
   * phase 3 made them independent on purpose. */
  spentCents: number;
  /** Money no unpaid hour could absorb. Non-zero is NOT an error: it is a
   * payment worth more than the hours it covers, which is what an overtime
   * premium, a bonus or back-pay looks like. The panel names the difference
   * in its confirmation; nothing refuses it.
   *
   * CENTS, not seconds, since 2026-09-04. With a rate per shift a leftover
   * cannot honestly be expressed as time at all: seconds are only a currency
   * while every hour is worth the same, and the whole point of the rate
   * history is that they are not. Money is the thing that is actually left
   * over, so money is what this reports. */
  unusedCents: number;
};

/**
 * PURE. Spend a payment across a person's unpaid hours, OLDEST FIRST.
 *
 * Jason's rule, 2026-09-03: "when I put an amount of money in, I want it to
 * automatically mark off the corresponding amount of hours... the first
 * record to be marked approved will be the one from last week, the oldest
 * record." The leftover ROLLS OVER: it stays unpaid and the next payment
 * picks it up, instead of being written off by a payment that did not cover
 * it. The case that produced the rule: $180.00 at $9.00/h buys exactly 20h
 * against 20h 34m of shifts, and the odd 34 minutes must survive.
 *
 * A SHIFT CAN THEREFORE BE PART PAID. That is the whole point, and it is why
 * the database no longer holds "one live line per shift" as a unique index —
 * see the 2026-09-03 migration, where a trigger now holds the weaker but
 * correct invariant that a shift's live lines cannot sum past its hours.
 *
 * ⚠ THIS IS THE ARITHMETIC PHASE 3 DELIBERATELY AVOIDED, POINTED THE OTHER
 * WAY. Phase 3 refused to compute what to PAY from hours, because overtime
 * has no agreed formula here (ledger row 285). This computes which HOURS a
 * payment covered, which needs a rate and inherits the same limit: it is
 * exact only while every hour is worth that day's straight rate. The day an
 * hour is worth 1.5x, a payment buys fewer hours than this says. Told to
 * Jason 2026-09-03 and accepted; the rate used is stamped on every line so a
 * later overtime rule can find and re-judge these rows rather than inherit
 * them silently.
 *
 * ⚠ EVERY SHIFT CARRIES ITS OWN RATE (2026-09-04, ledger row 506). This
 * function used to take ONE rate and divide once. It cannot: a payment
 * reaching back across a raise buys different amounts of time on either side
 * of it, and dividing the whole amount by today's rate marks off the wrong
 * hours. Jason's own case is why — his oldest unpaid shift is in his
 * $13.00/h window while his current rate is $16.00, so a single division
 * marked off about 19% fewer hours than the money bought.
 *
 * So it walks in MONEY rather than in seconds: at each shift, work out what
 * that shift's remaining hours cost AT ITS OWN RATE, and either buy the
 * whole thing or buy as much of it as the money left will reach.
 *
 * ⚠ AND IT WALKS IN CENT-SECONDS, not in cents. Subtracting each shift's
 * cost ROUNDED TO WHOLE CENTS accumulates a rounding error per shift, and it
 * is not theoretical: on Khaye's real five-shift $180.00 payment it marked
 * off 2 seconds fewer than the same money bought under the single division
 * this replaced. So the running balance is held in `cents × 3600` — the unit
 * in which `seconds × rate` is exact — and nothing is rounded until a
 * boundary actually has to be chosen. Whole-shift takes are then exact, and
 * the ONE rounding left is the single partial take at the end, which is
 * where a boundary genuinely has to fall.
 */
export function allocatePayment(
  /** Unpaid shifts, OLDEST FIRST. Not re-sorted here. Deliberately typed to
   * the four fields it READS rather than to PayableRemainder, so a caller
   * with its own shape (the panel's preview) needs no adapter and this
   * function cannot start depending on a field it has no business in. */
  remainders: readonly {
    shiftId: string;
    totalSeconds: number;
    unpaidSeconds: number;
    rateCentsPerHour: number;
  }[],
  totalCents: number,
): PaymentAllocation {
  const lines: PaymentAllocation['lines'] = [];
  // The balance, in cents × 3600. An hour of work at `rate` cents/hour costs
  // `3600 × rate` in these units and a second costs `rate`, both exactly, so
  // no whole-shift take ever has to round.
  let remaining =
    Number.isFinite(totalCents) && totalCents > 0 ? Math.floor(totalCents) * SECONDS_PER_HOUR : 0;
  let covered = 0;
  let spent = 0;

  for (const shift of remainders) {
    if (remaining <= 0) break;
    // A shift with nothing owing on it is skipped rather than written as a
    // zero line: a line claiming to cover no time is not a record of
    // anything, and it would make the settlement look like it touched more
    // shifts than it paid for.
    if (shift.unpaidSeconds <= 0) continue;
    // A shift on a day no rate covers is SKIPPED, not bought at somebody
    // else's rate and not bought for free. It stays unpaid and stays
    // visible, which is the honest outcome: the fix is to enter the rate for
    // that day, and guessing one here would hide the fact that it is missing.
    if (!Number.isFinite(shift.rateCentsPerHour) || shift.rateCentsPerHour <= 0) continue;

    // Exact, in cent-seconds. `referenceCentsFor` is used only for the LINE's
    // own stamped figure, which is a whole-cent value an admin reads.
    const wholeShiftCost = shift.unpaidSeconds * shift.rateCentsPerHour;
    if (remaining >= wholeShiftCost) {
      lines.push({
        shiftId: shift.shiftId,
        paidSeconds: shift.unpaidSeconds,
        totalSeconds: shift.totalSeconds,
        rateCentsPerHour: shift.rateCentsPerHour,
        referenceCents: referenceCentsFor(shift.unpaidSeconds, shift.rateCentsPerHour),
      });
      remaining -= wholeShiftCost;
      covered += shift.unpaidSeconds;
      spent += referenceCentsFor(shift.unpaidSeconds, shift.rateCentsPerHour);
      continue;
    }

    // Part of a shift. What is left buys fewer seconds than the shift has,
    // so the money is spent here and the rest of the shift rolls over. This
    // is the ONLY place a second boundary is rounded, and it happens at most
    // once per payment.
    //
    // The cap is not redundant: rounding to the NEAREST second means an
    // amount a fraction of a second short of the whole shift can round back
    // up to its full length. Capping keeps a line from ever claiming more
    // time than the shift has — which the database trigger would refuse
    // anyway, but a refusal is a worse answer than the correct number.
    const take = Math.min(
      Math.round(remaining / shift.rateCentsPerHour),
      shift.unpaidSeconds,
    );
    if (take > 0) {
      const takeCents = referenceCentsFor(take, shift.rateCentsPerHour);
      lines.push({
        shiftId: shift.shiftId,
        paidSeconds: take,
        totalSeconds: shift.totalSeconds,
        rateCentsPerHour: shift.rateCentsPerHour,
        referenceCents: takeCents,
      });
      covered += take;
      spent += takeCents;
    }
    // Whether or not a whole second could be bought, the money is gone: what
    // is left is smaller than one second of this shift's time. Counting it as
    // "unused" would report a bonus that is really a rounding crumb.
    remaining = 0;
    break;
  }

  return {
    lines,
    secondsCovered: covered,
    spentCents: spent,
    // Back to whole cents, rounded DOWN. What survives here is money no hour
    // could absorb, which the panel reads as an overtime premium or a bonus;
    // a sub-cent remainder rounded UP would announce a one-cent bonus that
    // nobody paid.
    unusedCents: Math.max(0, Math.floor(remaining / SECONDS_PER_HOUR)),
  };
}

/**
 * PURE. What a set of unpaid hours comes to, each at its own rate.
 *
 * The ceiling the pay panel shows, and the figure `excessOverHours` measures
 * a typed amount against. A SUM over shifts rather than `seconds × oneRate`
 * since 2026-09-04: with a rate per day there is no single rate to multiply
 * by, and using the person's current one overstates the value of every hour
 * worked before their last raise.
 */
export function valueOfHours(
  rated: readonly { unpaidSeconds: number; rateCentsPerHour: number }[],
): number {
  let cents = 0;
  for (const shift of rated) cents += referenceCentsFor(shift.unpaidSeconds, shift.rateCentsPerHour);
  return cents;
}

/**
 * PURE. Seconds as a person reads them: "4h 22m", "34m", "0m".
 *
 * Deliberately not imported from hoursSummary's formatHours: this module is
 * read by the Telegram notifier and by refusal messages, and a payroll
 * message should not start failing because a display helper changed shape.
 */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  const whole = Math.round(seconds / 60);
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/**
 * PURE. What a typed amount is worth ABOVE the hours it can be spent on.
 *
 * Zero when the money fits inside the unpaid hours, positive when it does
 * not — an overtime premium, a bonus, back-pay. Nothing refuses a positive
 * value (Jason, 2026-09-03); the panel names the figure and asks.
 *
 * Extracted from the panel deliberately. The pay panel is a client component
 * and this repo has no screen tests, so a decision left inline there is a
 * decision nothing can check — and the browser could not drive it either
 * (the preview pane blocks real clicks, and a scripted input never reaches
 * React's state, which made a first attempt at verifying it silently
 * meaningless). Out here it is four lines with its own tests.
 */
export function excessOverHours(typedCents: number | null, maxCents: number): number {
  if (typedCents === null || !Number.isFinite(typedCents)) return 0;
  if (!Number.isFinite(maxCents) || maxCents < 0) return 0;
  return Math.max(0, typedCents - maxCents);
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
export type ShiftCoverage = {
  /** Live seconds paid against this shift, summed across every settlement
   * that has touched it. A shift can now be part paid, so this is a number
   * rather than a yes/no. */
  seconds: number;
  /** One live settlement covering it — enough for the lock message, which
   * only has to say "a payment holds this". */
  settlementId: string;
};

/**
 * How much of each shift has been PAID FOR, live lines only.
 *
 * Since 2026-09-03 a payment can land in the middle of a shift, so "is this
 * paid" became "how much of it is". Read this when you need the amount;
 * read `settledShiftIds` when all you need is whether a shift is locked.
 */
export async function settledSecondsByShift(
  shiftIds: readonly string[],
): Promise<Map<string, ShiftCoverage>> {
  const out = new Map<string, ShiftCoverage>();
  if (shiftIds.length === 0) return out;
  const db = requireDb();
  for (const ids of chunk(shiftIds, ID_CHUNK)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('shift_settlement_lines')
        .select('shift_id, settlement_id, paid_seconds, voided_at')
        .in('shift_id', ids)
        .is('voided_at', null)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`settledSecondsByShift: ${error.message}`);
      const page = (data ?? []) as {
        shift_id: string;
        settlement_id: string;
        paid_seconds: number;
      }[];
      for (const row of page) {
        const prev = out.get(row.shift_id);
        out.set(row.shift_id, {
          seconds: (prev?.seconds ?? 0) + row.paid_seconds,
          settlementId: prev?.settlementId ?? row.settlement_id,
        });
      }
      if (page.length < PAGE) break;
    }
  }
  return out;
}

/**
 * Which shifts a live payment holds, whether in part or in full.
 *
 * Unchanged in meaning by the 2026-09-03 rollover work, which is why its
 * three callers did not have to move: a shift with ANY live line is locked
 * against edit and removal (ledger row 459). Half paid is still paid enough
 * that rewriting the times would rewrite what somebody was paid for.
 */
export async function settledShiftIds(
  shiftIds: readonly string[],
): Promise<Map<string, string>> {
  const coverage = await settledSecondsByShift(shiftIds);
  return new Map([...coverage].map(([shiftId, c]) => [shiftId, c.settlementId]));
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
  /** Payments stuck HALF-UNDONE: their shifts were released but the payment
   * itself never got its stamp. Running the undo again finishes them. They
   * are excluded from settledCents — see below. */
  halfUndone: string[];
};

/**
 * PURE.
 *
 * A settlement that is not voided but has NO live lines is a half-undone
 * payment, not a live one: `voidShiftSettlement` releases the lines first and
 * stamps the parent second, and the code says out loud what happens if the
 * second write fails. Counting it toward "recorded as paid" would overstate
 * what this person has been handed while its shifts are already payable
 * again — the same money counted twice (technical lens on PR #1179).
 *
 * A real settlement always has at least one live line: recordShiftSettlement
 * refuses to return until it has asserted the lines it sent are the lines
 * that landed. So "no live lines" identifies the broken state exactly, with
 * no false positives to worry about.
 */
export function summarize(settlements: readonly ShiftSettlement[]): SettlementSummary {
  const halfUndone = settlements
    .filter((s) => !s.voidedAt && s.lines.length > 0 && s.lines.every((l) => l.voidedAt))
    .map((s) => s.id);
  const stuck = new Set(halfUndone);
  const live = settlements.filter((s) => !s.voidedAt && !stuck.has(s.id));
  return {
    settledCents: live.reduce((sum, s) => sum + s.totalCents, 0),
    settlementCount: live.length,
    lastPaidAt: live.reduce<string | null>(
      (latest, s) => (latest === null || s.paidAt > latest ? s.paidAt : latest),
      null,
    ),
    halfUndone,
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
  close_source?: string | null;
};

/**
 * Every closed shift this person has, with what is still owing on each,
 * OLDEST FIRST — the order a payment is spent in (Jason, 2026-09-03).
 *
 * OPEN shifts are excluded: their hours are still growing, so paying one
 * would stamp a reference that was already wrong when it was written. That
 * was phase 3's `still-open` refusal, and it survives here as an exclusion
 * rather than an error, because the admin no longer names shifts and so
 * cannot name a running one by mistake.
 *
 * A break read that FAILS throws. With no break rows nothing is subtracted,
 * every shift looks longer than it is, and a payment would be recorded as
 * covering hours that were never worked.
 */
export async function unpaidRemainders(
  crewMemberId: string,
  nowIso?: string,
): Promise<PayableRemainder[]> {
  const db = requireDb();
  const now = new Date(resolveNowMs(nowIso)).toISOString();

  const shiftRows: ShiftRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('shifts')
      .select('id, crew_member_id, clock_in_at, clock_out_at, close_source')
      .eq('crew_member_id', crewMemberId)
      .not('clock_out_at', 'is', null)
      .order('clock_in_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`unpaidRemainders: shifts: ${error.message}`);
    const page = (data ?? []) as ShiftRow[];
    shiftRows.push(...page);
    if (page.length < PAGE) break;
  }
  if (shiftRows.length === 0) return [];

  const ids = shiftRows.map((r) => r.id);
  const breakRows: { shift_id: string; started_at: string; ended_at: string | null }[] = [];
  for (const part of chunk(ids, ID_CHUNK)) {
    const { data, error } = await db
      .from('shift_breaks')
      .select('shift_id, started_at, ended_at')
      .in('shift_id', part);
    if (error) {
      throw new Error(
        `unpaidRemainders: breaks could not be read (${error.message}); the hours would be overstated`,
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

  const covered = await settledSecondsByShift(ids);

  // The rate history, read ONCE for the person and resolved per shift below.
  // A read that fails throws for the same reason the break read does: with no
  // rate rows every shift resolves to zero, allocatePayment skips every one
  // of them, and a payment would be refused as covering nothing — which looks
  // exactly like "this person has no rate set" and is not.
  const rates = await listRates(crewMemberId);

  const out: PayableRemainder[] = [];
  for (const row of shiftRows) {
    const totalSeconds = paidSecondsForShift(
      { clockInAt: row.clock_in_at, clockOutAt: row.clock_out_at },
      breaksByShift.get(row.id) ?? [],
      now,
    );
    const paid = covered.get(row.id)?.seconds ?? 0;
    if (paid > totalSeconds) {
      console.error(
        `unpaidRemainders: shift ${row.id} has ${paid}s paid against ${totalSeconds}s worked — somebody has been paid for time that is no longer on the record`,
      );
    }
    out.push({
      shiftId: row.id,
      clockInAt: row.clock_in_at,
      totalSeconds,
      needsReview: row.close_source === 'system',
      // Never negative: a shift whose live lines exceed its length would
      // otherwise become a NEGATIVE remainder that quietly absorbs part of
      // the next payment. The clamp stays — but it is no longer SILENT. It
      // can only happen when a shift was shortened after being paid, and
      // burying that means burying a real overpayment (technical lens on
      // PR #1190).
      unpaidSeconds: Math.max(0, totalSeconds - paid),
      // The rate for the ET day this shift STARTED, never the person's rate
      // today (ledger row 506). Zero when no rate row covers that day, which
      // allocatePayment skips rather than guesses at.
      rateCentsPerHour: rateForShiftStart(rates, row.clock_in_at),
    });
  }
  return out;
}

/**
 * Record that money was handed to a person, and mark off the hours it bought.
 *
 * AMOUNT-DRIVEN SINCE 2026-09-03. Phase 3 took a list of shift ids and marked
 * each one paid in full; the first real payment showed why that is wrong.
 * $180.00 covered five weekdays worth 20h 34m at $9.00/h — the money buys
 * exactly 20h, and phase 3 wrote off the odd 34 minutes. Now the amount is
 * converted to seconds and spent over the unpaid shifts OLDEST FIRST, a shift
 * may be left part paid, and the remainder ROLLS OVER to the next payment.
 *
 * WHAT IS REFUSED, and why each:
 *   * `no-rate`      — the person has no positive rate, so the money cannot
 *                      be converted to hours at all. Guessing one here would
 *                      be inventing payroll.
 *   * `no-shifts`    — nothing closed and unpaid to put the money against.
 *
 * NOT refused: an amount worth MORE than the unpaid hours. There was a
 * ceiling here briefly and it made an overtime premium, a bonus or back-pay
 * impossible to record at all, so it was removed the same day (Jason,
 * 2026-09-03). The allocation still stops at the last unpaid second; the
 * excess is simply money recorded above what those hours come to, and the
 * panel names the difference before anyone confirms it.
 *
 * Under a double-submit the DATABASE decides, not this code: the trigger
 * added 2026-09-03 refuses lines that would sum past a shift's hours, taking
 * a lock on the shift row so two admins paying the same person serialise.
 * The settlement is written BEFORE its lines for the same reason as phase 3 —
 * the row it leaves behind on a lost race is removable, whereas lines with no
 * parent are not.
 */
export async function recordShiftSettlement(input: {
  crewMemberId: string;
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

  // The person, for their name in the refusals. The RATE no longer comes from
  // here: since 2026-09-04 each shift is converted at the rate in force on
  // the day it was worked, resolved inside `unpaidRemainders` from the rate
  // history (ledger row 506).
  const { data: crewData, error: crewError } = await db
    .from('crew_members')
    .select('id, display_name')
    .eq('id', crewMemberId)
    .maybeSingle();
  if (crewError) throw new Error(`recordShiftSettlement: crew lookup: ${crewError.message}`);
  const crew = crewData as { id: string; display_name: string } | null;
  if (!crew) throw new SettlementRefusedError('not-found', 'No staff member with that id.');

  const remainders = await unpaidRemainders(crewMemberId, input.nowIso);
  const owedSeconds = remainders.reduce((sum, r) => sum + r.unpaidSeconds, 0);
  if (owedSeconds <= 0) {
    throw new SettlementRefusedError(
      'no-shifts',
      `${crew.display_name} has no unpaid hours to put this against. Every closed shift is already paid for.`,
    );
  }

  // `no-rate` still exists, but it now asks a per-DAY question rather than a
  // per-person one: are any of these unpaid hours on a day this person has a
  // rate for? None at all is the old "no rate set" case and refuses. SOME is
  // not refused — the payment covers the days that do have a rate, and the
  // rest stay unpaid and visible rather than being bought at a guessed rate
  // or silently written off. The panel names any such days before anyone
  // confirms.
  const payableAtSomeRate = remainders.filter(
    (r) => r.unpaidSeconds > 0 && r.rateCentsPerHour > 0,
  );
  if (payableAtSomeRate.length === 0) {
    throw new SettlementRefusedError(
      'no-rate',
      `None of ${crew.display_name}'s unpaid hours fall on a day with an hourly rate on record, so there is no way to work out which hours this payment covers. Set their rate first.`,
    );
  }

  // NO CEILING ON THE AMOUNT (Jason, 2026-09-03, reversing his earlier call
  // once the consequence was clear). A cap at straight-rate value made an
  // overtime premium, a bonus or back-pay IMPOSSIBLE to record: once someone's
  // hours were paid at base rate there was no unpaid shift left to attach
  // anything to, and void-and-re-record recomputed the same ceiling every
  // time. Overtime has no agreed formula here (ledger row 285) and a 50h 55m
  // week is already in the data, so the tool must be able to record a payment
  // worth more than the hours (admin lens on PR #1190).
  //
  // What the money cannot do is mark off hours that do not exist: the
  // allocation stops at the last unpaid second, and anything beyond that is
  // simply money recorded above what those hours come to. That restores the
  // phase 3 property this design had accidentally removed — total_cents is
  // the money record, the per-line reference is what the hours were worth,
  // and the two are ALLOWED to differ. The difference is now meaningful
  // again rather than rounding noise, which is exactly when it should be.
  //
  // The confirmation lives in the panel, where a person can see the figure
  // before agreeing to it. This function does not second-guess a number an
  // admin has confirmed.
  const allocation = allocatePayment(remainders, input.totalCents);
  if (allocation.lines.length === 0) {
    throw new SettlementRefusedError(
      'no-shifts',
      'That amount covers no time at all. Record a larger amount.',
    );
  }

  const nowIso = new Date(resolveNowMs(input.nowIso)).toISOString();
  // The rate and the reference come off the LINE, which carried the rate in
  // force on that shift's own day through the allocation. This is the stamp
  // ledger row 506 says must not change shape: it is what keeps this payment
  // honest if the rate history is later corrected.
  const linePayloads = allocation.lines.map((line) => ({
    shift_id: line.shiftId,
    paid_seconds: line.paidSeconds,
    shift_total_seconds: line.totalSeconds,
    rate_cents_per_hour: line.rateCentsPerHour,
    reference_cents: line.referenceCents,
  }));

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
    // 23505 was the phase 3 unique index; 23514 is the check_violation the
    // 2026-09-03 trigger raises. Both usually mean the same thing to the
    // person: somebody else paid these hours while this page was open. Kept
    // BOTH, because a shift paid before that migration ran is still covered
    // by a line the old index created.
    //
    // EXCEPT for one 23514, which is not a race at all. The trigger also
    // refuses lines that DISAGREE about how long a shift is, which happens
    // when a shift was edited while a payment was live against it — the
    // narrow window between assertNotSettled's read and its write in
    // shifts.ts. Retrying can never clear that, so telling the admin to try
    // again would send them round a loop forever on a shift that has quietly
    // become unpayable (technical lens on PR #1190). It gets its own refusal
    // and the only instruction that actually works.
    const raced = (lineError as { code?: string }).code;
    const disagreeing =
      raced === '23514' && /disagreeing on its length/.test(lineError.message ?? '');
    const lostRace = !disagreeing && (raced === '23505' || raced === '23514');
    if (unwindError) {
      // Say what is actually true: an empty payment is on the books.
      throw new Error(
        `recordShiftSettlement: the shifts could not be attached (${lineError.message}) and the empty payment could not be removed (${unwindError.message}) — settlement ${settlement.id} is on the books covering nothing and must be voided by hand`,
      );
    }
    if (disagreeing) {
      throw new SettlementRefusedError(
        'shift-edited',
        `One of ${crew.display_name}'s shifts was changed after a payment was already recorded against it, so the tool cannot tell which hours that payment covered. Undo that payment, correct the shift, then record both again. Nothing was recorded here.`,
      );
    }
    if (lostRace) {
      throw new SettlementRefusedError(
        'lost-race',
        'Someone recorded a payment for one of those shifts while you were on this page. Nothing was recorded here. The list below has been brought up to date — check it and record again.',
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

  const stillOwed = owedSeconds - allocation.secondsCovered;
  await notifyCrewOfPayment(db, {
    crewMemberId,
    // HOURS, not "N shifts": a payment can now stop part way through a shift,
    // so a shift count would overstate what it covered. The rollover is named
    // too — the whole reason for this change is that the leftover survives,
    // and the person should hear that from the same message.
    text: `${input.paidBy} recorded a payment to you of ${dollars(input.totalCents)} by ${input.method}, covering ${formatSeconds(allocation.secondsCovered)} of your unpaid time${stillOwed > 0 ? `, with ${formatSeconds(stillOwed)} still unpaid and carried over` : ' — nothing is left unpaid'}. Tell the office if that does not match what you received. This bot only understands clock commands, so a reply here will not reach anyone.`,
  });

  return toSettlement(settlement, lines);
}

/**
 * Tell the person their own pay record moved — the same courtesy, and the
 * same log-not-throw posture, that a manual change to their SHIFT already
 * gets from notifyCrewOfManualWrite in shifts.ts.
 *
 * Recording a payment was the one payroll write that told them nothing, and
 * it is the write with the highest stakes: it locks the shift against
 * correction (customer lens on PR #1179). A DM to their own account is not
 * the /crew page, which stays deliberately money-free because the whole crew
 * can open it; this is one person's own receipt.
 *
 * Best-effort by design. The payment has already landed, and a failed notify
 * must never make a retry record it twice.
 */
async function notifyCrewOfPayment(
  db: Db,
  entry: { crewMemberId: string; text: string },
): Promise<void> {
  try {
    const { data } = await db
      .from('crew_members')
      .select('telegram_user_id')
      .eq('id', entry.crewMemberId)
      .maybeSingle();
    const chatId = (data as { telegram_user_id: string | null } | null)?.telegram_user_id;
    if (chatId) await sendTelegramMessage(chatId, entry.text);
  } catch (notifyError) {
    console.error('notifyCrewOfPayment: failed:', notifyError);
  }
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

  // The HOURS that just went back to unpaid, not only the amount. `lines`
  // was read before the void, so this is what was live at that moment.
  //
  // The record-payment message names hours and rollover; leaving this one at
  // "a $180.00 payment was undone" made the person better informed when they
  // were PAID than when a payment was taken back, on the screen the whole
  // feature exists to make trustworthy (staff lens on PR #1190). With part
  // payments the amount alone no longer implies which hours moved.
  // EVERY line of this settlement, voided or not — not just the ones that
  // were live when this function started.
  //
  // Only this settlement's own undo ever voids these lines, so the sum is the
  // same number either way on a first run. On the HALF-UNDONE re-run it is
  // the only correct answer: the first attempt released the lines and then
  // failed to stamp the settlement, so by the time the admin runs Undo again
  // every line already reads as voided. Filtering to live lines made that
  // second run compute ZERO, and the crew member's only message for the whole
  // event would have said "$40.00 undone... 0m of your time goes back to
  // unpaid" — self-contradictory, and the true figure never sent, because the
  // first attempt sent nothing at all (delta-verify on PR #1190).
  const releasedSeconds = lines.reduce((sum, l) => sum + l.paid_seconds, 0);
  await notifyCrewOfPayment(db, {
    crewMemberId: voided.crew_member_id,
    text: `${input.voidedBy} undid the record of a ${dollars(voided.total_cents)} payment to you: ${reason}. ${formatSeconds(releasedSeconds)} of your time goes back to unpaid. Tell the office if that looks wrong. This bot only understands clock commands, so a reply here will not reach anyone.`,
  });

  return toSettlement(voided, await readLinesForSettlements(db, [id]));
}
