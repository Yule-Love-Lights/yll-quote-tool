/**
 * Pay rates CHANGE, and every conversion from money to hours has to use the
 * rate that was in force on the day the work was done — not the person's
 * rate today. Ledger row 506; the full reasoning is in
 * `migrations/2026-09-04-crew-member-rates.sql` and in
 * `docs/context/project_time_tracking.md` Part 3.
 *
 * WHY THIS EXISTS AT ALL. Before the 2026-09-03 rollover a payment named
 * shifts and marked them paid, and the rate was decoration. Since the
 * rollover a payment is an AMOUNT that gets divided by a rate to decide
 * which hours it covered, so a stale rate silently marks off the wrong
 * number of hours. Jason's own oldest unpaid shift (21 Aug 2026) sits in his
 * $13.00/h window while his stored rate is $16.00, so this was already wrong
 * in production before a line of this file was written.
 *
 * WHAT THIS FILE IS NOT. It is not the record of what anybody was PAID.
 * `shift_settlement_lines.rate_cents_per_hour` is stamped at payment time
 * and is deliberately never derived from here again. That is what keeps a
 * historical payment honest when a rate later moves, and it is why editing
 * this history is safe: it changes FUTURE conversions only.
 */

import { etDayKey } from '@/lib/dashboard/inbox/normalize';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { resolveNowMs } from '@/lib/timeSpans';

/** One rate change: from this ET calendar day onward, this much per hour. */
export type CrewMemberRate = {
  id: string;
  crewMemberId: string;
  rateCentsPerHour: number;
  /** ET calendar day, inclusive, as `YYYY-MM-DD`. */
  effectiveFrom: string;
  createdAt: string;
  createdBy: string | null;
};

type RateRow = {
  id: string;
  crew_member_id: string;
  rate_cents_per_hour: number;
  effective_from: string;
  created_at: string;
  created_by: string | null;
};

const SELECT = 'id, crew_member_id, rate_cents_per_hour, effective_from, created_at, created_by';

/**
 * The day a person's FIRST rate row takes effect, when nobody has said
 * otherwise — deliberately far in the past.
 *
 * A rate history with a gap at the start is not a smaller problem than no
 * history: a shift on a day earlier than the first row resolves to no rate,
 * so it cannot be paid at all until somebody notices and backdates a row.
 * Anchoring the first row before any shift can exist makes that gap
 * impossible, and it is what the 2026-09-04 migration seeded with, so a
 * person created afterwards is shaped the same as one who was backfilled.
 *
 * It also has to survive row 507: importing a year of pre-tool history
 * introduces shifts far older than anything in the table today, and a first
 * row anchored to "when this person was added" would leave every one of them
 * unpayable.
 */
export const RATE_HISTORY_EPOCH = '2000-01-01';

function toRate(row: RateRow): CrewMemberRate {
  return {
    id: row.id,
    crewMemberId: row.crew_member_id,
    rateCentsPerHour: row.rate_cents_per_hour,
    effectiveFrom: row.effective_from,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function requireDb() {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');
  return db;
}

/**
 * PURE. The rate in force on an ET calendar day: the row with the greatest
 * `effective_from` that is at or before that day.
 *
 * Returns 0 when no row covers the day — which is a real answer and not a
 * failure. A person with no rate at all, or a day earlier than their first
 * rate row, has no rate, and every caller treats 0 as "refuse to convert"
 * rather than "free". Never fall back to the person's CURRENT rate on a
 * miss: that is exactly the bug this module exists to remove, and a silent
 * fallback would reintroduce it for the one case where it matters most.
 *
 * `rates` may arrive in any order; this scans rather than trusting a sort,
 * because a single mis-ordered list would resolve every shift to the wrong
 * rate with nothing on any screen to show for it.
 *
 * Day strings are `YYYY-MM-DD`, so a plain string compare IS a date compare.
 */
export function rateForDay(
  rates: readonly { rateCentsPerHour: number; effectiveFrom: string }[],
  etDay: string,
): number {
  let best: { rateCentsPerHour: number; effectiveFrom: string } | null = null;
  for (const r of rates) {
    if (r.effectiveFrom > etDay) continue;
    if (best === null || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  if (best === null) return 0;
  return best.rateCentsPerHour > 0 ? best.rateCentsPerHour : 0;
}

/**
 * PURE. The rate in force when a shift STARTED.
 *
 * A shift that runs past midnight takes the rate of the day it began on —
 * said out loud here because it is a decision, not an accident. It is the
 * same rule `groupPersonDays` already uses to decide which day a shift's
 * hours belong to, and the two must not disagree: a shift shown under
 * Thursday must be paid at Thursday's rate.
 */
export function rateForShiftStart(
  rates: readonly { rateCentsPerHour: number; effectiveFrom: string }[],
  clockInAtIso: string,
): number {
  const ms = Date.parse(clockInAtIso);
  if (!Number.isFinite(ms)) return 0;
  return rateForDay(rates, etDayKey(new Date(ms)));
}

/**
 * PURE. The distinct rates present across a set of already-rated shifts,
 * ascending.
 *
 * The pay panel's copy names a single "$X/hr" figure, which is a lie the
 * moment a payment reaches across a raise. This is what the panel asks
 * before printing that sentence — the guard-and-copy rule in AGENTS.md: the
 * arithmetic being right does not make the sentence describing it right.
 */
export function distinctRates(rated: readonly { rateCentsPerHour: number }[]): number[] {
  const seen = new Set<number>();
  for (const r of rated) if (r.rateCentsPerHour > 0) seen.add(r.rateCentsPerHour);
  return [...seen].sort((a, b) => a - b);
}

/** Every rate row for a person, OLDEST FIRST. */
export async function listRates(crewMemberId: string): Promise<CrewMemberRate[]> {
  const db = requireDb();
  const { data, error } = await db
    .from('crew_member_rates')
    .select(SELECT)
    .eq('crew_member_id', crewMemberId)
    .order('effective_from', { ascending: true });
  if (error) throw new Error(`listRates: ${error.message}`);
  return ((data ?? []) as RateRow[]).map(toRate);
}

/**
 * Every rate row for several people at once, keyed by crew member id.
 *
 * For screens that price a whole team's hours in one render and must not
 * issue a query per person.
 */
export async function listRatesFor(
  crewMemberIds: readonly string[],
): Promise<Map<string, CrewMemberRate[]>> {
  const out = new Map<string, CrewMemberRate[]>();
  const ids = [...new Set(crewMemberIds)].filter(Boolean);
  if (ids.length === 0) return out;
  const db = requireDb();
  const { data, error } = await db
    .from('crew_member_rates')
    .select(SELECT)
    .in('crew_member_id', ids)
    .order('effective_from', { ascending: true });
  if (error) throw new Error(`listRatesFor: ${error.message}`);
  for (const row of (data ?? []) as RateRow[]) {
    const rate = toRate(row);
    const list = out.get(rate.crewMemberId);
    if (list) list.push(rate);
    else out.set(rate.crewMemberId, [rate]);
  }
  return out;
}

export class RateRefusedError extends Error {
  readonly reason: 'invalid-rate' | 'invalid-date' | 'not-found' | 'last-rate' | 'uncovers-today';
  constructor(reason: RateRefusedError['reason'], message: string) {
    super(message);
    this.name = 'RateRefusedError';
    this.reason = reason;
  }
}

/** `YYYY-MM-DD`, and a real day rather than 2026-02-31. */
export function isEtDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * Set a person's rate from an ET day onward, and bring
 * `crew_members.base_rate_cents` back into step in the same call.
 *
 * THE ONLY WRITER OF EITHER. The column is the rate NOW and about forty
 * consumers read it, nearly all of them to display a figure; the history is
 * what the money maths resolves against. Keeping them in step by
 * construction — recompute the column from the history on every write —
 * removes the drift question entirely rather than answering it with
 * discipline. `setStaffRate` in crewMembers.ts now calls through here with
 * today's ET day; nothing else writes `base_rate_cents`.
 *
 * Upserts on (person, day): setting a rate twice for the same day corrects
 * that day rather than making "the rate in force" ambiguous.
 *
 * An `effectiveFrom` in the PAST is allowed, and is the normal case — it is
 * how a real history gets entered at all. It cannot rewrite money already
 * recorded, because every settlement line carries its own stamped rate; it
 * changes what future conversions do, and the screen says exactly that.
 */
export async function setRateFrom(input: {
  crewMemberId: string;
  rateCentsPerHour: number;
  effectiveFrom: string;
  createdBy?: string | null;
  nowIso?: string;
}): Promise<CrewMemberRate[]> {
  const db = requireDb();
  if (!Number.isInteger(input.rateCentsPerHour) || input.rateCentsPerHour <= 0) {
    throw new RateRefusedError('invalid-rate', 'Enter an hourly rate greater than zero.');
  }
  if (!isEtDay(input.effectiveFrom)) {
    throw new RateRefusedError(
      'invalid-date',
      'Pick the date the rate started, as a real calendar day.',
    );
  }

  const { data: crew, error: crewError } = await db
    .from('crew_members')
    .select('id')
    .eq('id', input.crewMemberId)
    .maybeSingle();
  if (crewError) throw new Error(`setRateFrom: crew lookup: ${crewError.message}`);
  if (!crew) throw new RateRefusedError('not-found', 'No staff member with that id.');

  const { error: upsertError } = await db.from('crew_member_rates').upsert(
    {
      crew_member_id: input.crewMemberId,
      rate_cents_per_hour: input.rateCentsPerHour,
      effective_from: input.effectiveFrom,
      created_by: input.createdBy ?? null,
    },
    { onConflict: 'crew_member_id,effective_from' },
  );
  if (upsertError) throw new Error(`setRateFrom: ${upsertError.message}`);

  return syncCurrentRate(input.crewMemberId, input.nowIso);
}

/**
 * Remove one rate row, then bring the column back into step.
 *
 * Refuses to remove the LAST row: a person with an empty history has no rate
 * on any day, so every future payment to them would be refused with a
 * message about a rate that is not set — true, but arriving at it by
 * deleting the only row is a trap rather than a decision. Change the figure
 * instead.
 *
 * Refuses, for the same reason, any removal that would leave TODAY with no
 * rate — which is not the same check, and is reachable: with a future-dated
 * raise on file, deleting the row that covers today leaves two rows, passes
 * the count test, and uncovers the present. That state is worse than it
 * looks. `syncCurrentRate` cannot then recompute `crew_members`
 * `base_rate_cents`, so it keeps its old value while no rate in the history
 * supports it, and the forty-odd screens that read it go on displaying a
 * figure that has silently stopped being true (admin lens on PR #1214).
 * Refusing here keeps "the column is the rate in force today" an invariant
 * rather than something that holds until somebody deletes the wrong row.
 */
export async function deleteRate(input: {
  crewMemberId: string;
  rateId: string;
  nowIso?: string;
}): Promise<CrewMemberRate[]> {
  const db = requireDb();
  const existing = await listRates(input.crewMemberId);
  if (!existing.some((r) => r.id === input.rateId)) {
    throw new RateRefusedError('not-found', 'That rate is not on this person’s history.');
  }
  if (existing.length <= 1) {
    throw new RateRefusedError(
      'last-rate',
      'This is the only rate on record. Change the figure rather than removing it, or no day has a rate at all.',
    );
  }
  const today = etDayKey(new Date(resolveNowMs(input.nowIso)));
  const remaining = existing.filter((r) => r.id !== input.rateId);
  if (rateForDay(remaining, today) <= 0) {
    throw new RateRefusedError(
      'uncovers-today',
      'Removing this would leave today with no hourly rate at all, so nothing could be paid and the rate shown everywhere else would stop being true. Add the rate that should apply from now first, then remove this one.',
    );
  }
  const { error } = await db
    .from('crew_member_rates')
    .delete()
    .eq('id', input.rateId)
    .eq('crew_member_id', input.crewMemberId);
  if (error) throw new Error(`deleteRate: ${error.message}`);
  return syncCurrentRate(input.crewMemberId, input.nowIso);
}

/**
 * Recompute `crew_members.base_rate_cents` as the rate in force TODAY.
 *
 * Called after every history write so the column is derived rather than
 * maintained. A history with no row covering today leaves the column
 * untouched rather than zeroing it: zero is how "this person has no rate" is
 * spelt everywhere else, and writing it here as a side effect of an
 * unrelated edit would refuse their next payment for a reason nobody typed.
 */
async function syncCurrentRate(crewMemberId: string, nowIso?: string): Promise<CrewMemberRate[]> {
  const db = requireDb();
  const rates = await listRates(crewMemberId);
  const today = etDayKey(new Date(resolveNowMs(nowIso)));
  const current = rateForDay(rates, today);
  // Zero means the history covers no rate for TODAY. Both writers now refuse
  // to create that state — `setRateFrom` only ever adds cover and
  // `deleteRate` refuses a removal that uncovers today — so reaching here
  // means something outside this module wrote the table. Leave the column
  // alone rather than zeroing it: zero is how "no rate" is spelt everywhere
  // else, and writing it as a side effect would refuse somebody's next
  // payment for a reason nobody typed. Say so in the log, because a column
  // that has stopped matching the history is not a state to discover from a
  // wrong number on a screen.
  if (current <= 0) {
    console.error(
      `syncCurrentRate: ${crewMemberId} has no rate covering ${today}, so crew_members.base_rate_cents was left as it was and no longer matches the history`,
    );
  }
  if (current > 0) {
    // Read the row BACK rather than trusting an error-free response. An
    // `.eq()` that matches nothing is not an error in postgrest, so without
    // this the one thing this function exists to guarantee — that the column
    // and the history agree — would be a hope. If it did not land, say so
    // loudly: a silent miss leaves the displayed rate stale while the
    // history says otherwise, which is the drift this design removes.
    const { data, error } = await db
      .from('crew_members')
      .update({
        base_rate_cents: current,
        updated_at: new Date(resolveNowMs(nowIso)).toISOString(),
      })
      .eq('id', crewMemberId)
      .select('id, base_rate_cents')
      .maybeSingle();
    if (error) {
      throw new Error(`setRateFrom: could not bring the current rate into step: ${error.message}`);
    }
    const updated = data as { id: string; base_rate_cents: number } | null;
    if (!updated || updated.base_rate_cents !== current) {
      throw new Error(
        `setRateFrom: the rate history was saved but ${crewMemberId}'s current rate did not move to ${current}; they now disagree`,
      );
    }
  }
  return rates;
}
