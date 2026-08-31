import { getSupabaseServiceClient } from '@/lib/supabase';
import { logAdvertisingActivity } from '@/lib/advertising/activity';
import { earningsSummaryOrThrow } from '@/lib/advertising/placements';
import { getAdvertisingWorker } from '@/lib/advertising/workers';

// Advertising payout settlement (ledger row 481, Naldo's rulings 2026-08-30).
//
// placements.ts knows what a worker has EARNED — the rate stamped on each
// accepted photo, which never moves when a campaign's rate changes. This
// module knows what has been HANDED OVER.
//
// A settlement says WHICH photos it paid, not just "week of Aug 24, $47.50",
// because a photo inside an already-paid week can be accepted days later and
// period-only settlement cannot then tell an underpayment from a late
// acceptance. Every photo carries its stamped rate onto the settlement line,
// so a payment stays its own record however the campaign changes afterwards.
//
// SETTLED and UNPAID are DERIVED, never stored:
//   settled(worker) = sum of that worker's settlement lines
//   unpaid(worker)  = accepted earned cents - settled
// Same posture as `remaining` in signIssuances.ts: a stored balance drifts,
// a derived one cannot.
//
// A PAID PHOTO CANNOT BE VOIDED (Naldo's ruling, 2026-08-30: "refuse the
// void once paid"). The guard lives in voidPlacement, at the state change;
// this module owns the question it asks (isPlacementSettled).

/** How the money physically moved. Naldo 2026-08-30: a fixed short list, so
 * "how much did we pay in cash this month" stays answerable. Anything else
 * goes in the free-text note. */
export const SETTLEMENT_METHODS = ['cash', 'venmo', 'check', 'other'] as const;
export type SettlementMethod = (typeof SETTLEMENT_METHODS)[number];

export function isSettlementMethod(value: unknown): value is SettlementMethod {
  return typeof value === 'string' && (SETTLEMENT_METHODS as readonly string[]).includes(value);
}

export type PayablePlacement = {
  id: string;
  workerId: string;
  campaignId: string;
  /** The STAMPED accepted rate. Never a recomputed one. */
  amountCents: number;
  capturedAt: string | null;
};

export type AdvertisingSettlement = {
  id: string;
  workerId: string;
  totalCents: number;
  method: SettlementMethod;
  note: string | null;
  paidAt: string;
  paidBy: string | null;
  lineCount: number;
  createdAt: string;
  /** Void overlay (ledger row 492): the row stays as the record of what was
   * recorded, stops counting as paid, and releases its photos. */
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
};

export type WorkerPayoutSummary = {
  workerId: string;
  earnedCents: number;
  settledCents: number;
  unpaidCents: number;
  lastPaidAt: string | null;
  payableCount: number;
};

const PAGE = 1000;
/** PostgREST puts the `in` list in the URL; keep each one short. */
const ID_CHUNK = 200;

const SETTLEMENT_SELECT =
  'id, worker_id, total_cents, method, note, paid_at, paid_by, created_at, voided_at, voided_by, void_reason';
const LINE_SELECT = 'id, settlement_id, placement_id, amount_cents, voided_at';
const PLACEMENT_SELECT =
  'id, worker_id, campaign_id, status, kind, accepted_rate_cents, captured_at, created_at, voided_at, is_test';

type SettlementRow = {
  id: string;
  worker_id: string;
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
  placement_id: string;
  amount_cents: number;
  /** Mirrors the settlement's stamp, written in the same call. The partial
   * unique index keys on THIS, because an index cannot look at another
   * table: a voided payment releases its photos. */
  voided_at: string | null;
};

type PlacementRow = {
  id: string;
  worker_id: string;
  campaign_id: string;
  status: string;
  kind: string;
  accepted_rate_cents: number | null;
  captured_at: string | null;
  created_at: string;
  voided_at: string | null;
  is_test: boolean;
};

type Db = NonNullable<ReturnType<typeof getSupabaseServiceClient>>;

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Every settlement, optionally one worker's, PAGED to completeness. A pay
 * total computed from a silently truncated read is the wrong-money class
 * this repo's history warns about. Throws rather than returning a partial
 * sum: a short read here would understate what we have already paid, which
 * is how a worker gets paid twice. */
async function readSettlements(db: Db, workerId?: string): Promise<SettlementRow[]> {
  const rows: SettlementRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = db.from('advertising_settlements').select(SETTLEMENT_SELECT);
    if (workerId) query = query.eq('worker_id', workerId);
    const { data, error } = await query
      .order('paid_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`readSettlements: ${error.message}`);
    const page = (data ?? []) as SettlementRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

/** The lines of these settlements, paged and chunked. Same fail-loud rule. */
async function readLinesForSettlements(db: Db, settlementIds: string[]): Promise<LineRow[]> {
  if (settlementIds.length === 0) return [];
  const rows: LineRow[] = [];
  for (const ids of chunk(settlementIds, ID_CHUNK)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('advertising_settlement_lines')
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

/** Which of these placements already sit on a settlement line. */
async function readLinesForPlacements(db: Db, placementIds: string[]): Promise<LineRow[]> {
  if (placementIds.length === 0) return [];
  const rows: LineRow[] = [];
  for (const ids of chunk(placementIds, ID_CHUNK)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('advertising_settlement_lines')
        .select(LINE_SELECT)
        .in('placement_id', ids)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`readLinesForPlacements: ${error.message}`);
      const page = (data ?? []) as LineRow[];
      rows.push(...page);
      if (page.length < PAGE) break;
    }
  }
  return rows;
}

/** Accepted, live, real placements, optionally one worker's, paged. The
 * predicates are pushed to the server so a voided or test row never reaches
 * the money math at all. */
async function readAcceptedPlacements(db: Db, workerId?: string): Promise<PlacementRow[]> {
  const rows: PlacementRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = db.from('advertising_placements').select(PLACEMENT_SELECT).eq('status', 'accepted').eq('is_test', false);
    if (workerId) query = query.eq('worker_id', workerId);
    const { data, error } = await query
      .is('voided_at', null)
      .order('captured_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`readAcceptedPlacements: ${error.message}`);
    const page = (data ?? []) as PlacementRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

type SettledTotals = {
  /** workerId -> cents already handed over */
  settledCents: Map<string, number>;
  /** workerId -> the most recent paid_at */
  lastPaidAt: Map<string, string>;
  /** every placement id that has been paid */
  paidPlacementIds: Set<string>;
};

async function settledTotals(db: Db, workerId?: string): Promise<SettledTotals> {
  const settlements = await readSettlements(db, workerId);
  const workerBySettlement = new Map(settlements.map((s) => [s.id, s.worker_id]));
  const lines = await readLinesForSettlements(
    db,
    settlements.map((s) => s.id),
  );

  const settledCents = new Map<string, number>();
  const lastPaidAt = new Map<string, string>();
  const paidPlacementIds = new Set<string>();

  // A VOIDED payment counts for nothing (ledger row 492): not toward settled
  // money, not as a claim on its photos, and not as the last time this worker
  // was paid. The row itself survives as history and is still listed.
  for (const line of lines) {
    if (line.voided_at) continue;
    const worker = workerBySettlement.get(line.settlement_id);
    if (!worker) continue;
    settledCents.set(worker, (settledCents.get(worker) ?? 0) + line.amount_cents);
    paidPlacementIds.add(line.placement_id);
  }
  for (const s of settlements) {
    if (s.voided_at) continue;
    const current = lastPaidAt.get(s.worker_id);
    if (!current || Date.parse(s.paid_at) > Date.parse(current)) lastPaidAt.set(s.worker_id, s.paid_at);
  }

  return { settledCents, lastPaidAt, paidPlacementIds };
}

function toPayable(row: PlacementRow): PayablePlacement {
  return {
    id: row.id,
    workerId: row.worker_id,
    campaignId: row.campaign_id,
    amountCents: row.accepted_rate_cents ?? 0,
    capturedAt: row.captured_at,
  };
}

/**
 * Money readers refuse rather than return zeros when the database is not
 * configured. Returning an empty result here would render "$0 earned, $0
 * owed" for every worker on a healthy-looking response, which is the same
 * confident falsehood the throwing earnings read exists to prevent, reached
 * through a different door. (Delta-verify round 2, PR #1130.)
 */
function requireDb(): NonNullable<ReturnType<typeof getSupabaseServiceClient>> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('payouts: Supabase service role not configured, so the pay figures could not be read');
  return db;
}

/**
 * What this worker is still owed for, photo by photo: accepted, not voided,
 * not a test row, and not already on a settlement line. This is the set the
 * "Mark paid" action defaults to (Naldo 2026-08-30: pay everything
 * outstanding).
 */
export async function listPayablePlacements(workerId: string): Promise<PayablePlacement[]> {
  const db = requireDb();
  const id = workerId.trim();
  const [accepted, settled] = await Promise.all([readAcceptedPlacements(db, id), settledTotals(db)]);
  return accepted.filter((row) => !settled.paidPlacementIds.has(row.id)).map(toPayable);
}

/** Has this placement been paid? The void guard's question — a paid photo
 * cannot be voided, because the money has already left. */
export async function isPlacementSettled(placementId: string): Promise<boolean> {
  const db = getSupabaseServiceClient();
  if (!db) return false;
  const lines = await readLinesForPlacements(db, [placementId.trim()]);
  // Only a LIVE line is a claim. Once the payment covering a photo is voided
  // the money is back on the books as unpaid, so the photo can be voided
  // itself again (ledger row 492).
  return lines.some((line) => !line.voided_at);
}

/** One worker's money at a glance: earned (history), paid, still owed. */
export async function getWorkerPayoutSummary(workerId: string): Promise<WorkerPayoutSummary> {
  const id = workerId.trim();
  const db = requireDb();

  const [summaries, settled, accepted] = await Promise.all([
    earningsSummaryOrThrow({ workerId: id }),
    settledTotals(db, id),
    readAcceptedPlacements(db, id),
  ]);
  const earnedCents = summaries.find((s) => s.workerId === id)?.total.acceptedEarnedCents ?? 0;
  const settledCents = settled.settledCents.get(id) ?? 0;
  return {
    workerId: id,
    earnedCents,
    settledCents,
    unpaidCents: earnedCents - settledCents,
    lastPaidAt: settled.lastPaidAt.get(id) ?? null,
    payableCount: accepted.filter((row) => !settled.paidPlacementIds.has(row.id)).length,
  };
}

/** Every worker's earned / paid / unpaid, for the admin pay screen. */
export async function listPayoutSummaries(): Promise<WorkerPayoutSummary[]> {
  const db = requireDb();
  const [summaries, settled, accepted] = await Promise.all([
    earningsSummaryOrThrow(),
    settledTotals(db),
    readAcceptedPlacements(db),
  ]);

  const payableCount = new Map<string, number>();
  for (const row of accepted) {
    if (settled.paidPlacementIds.has(row.id)) continue;
    payableCount.set(row.worker_id, (payableCount.get(row.worker_id) ?? 0) + 1);
  }

  // A worker who has been paid but has no live accepted rows must still
  // appear, so the pay screen never loses a payment it recorded.
  const workerIds = new Set<string>([
    ...summaries.map((s) => s.workerId),
    ...settled.settledCents.keys(),
    ...payableCount.keys(),
  ]);

  return [...workerIds]
    .sort((a, b) => a.localeCompare(b))
    .map((workerId) => {
      const earnedCents = summaries.find((s) => s.workerId === workerId)?.total.acceptedEarnedCents ?? 0;
      const settledCents = settled.settledCents.get(workerId) ?? 0;
          return {
        workerId,
        earnedCents,
        settledCents,
        unpaidCents: earnedCents - settledCents,
        lastPaidAt: settled.lastPaidAt.get(workerId) ?? null,
        payableCount: payableCount.get(workerId) ?? 0,
      };
    });
}

function toSettlement(row: SettlementRow, lineCount: number): AdvertisingSettlement {
  return {
    id: row.id,
    workerId: row.worker_id,
    totalCents: row.total_cents,
    method: (isSettlementMethod(row.method) ? row.method : 'other') as SettlementMethod,
    note: row.note,
    paidAt: row.paid_at,
    paidBy: row.paid_by,
    lineCount,
    createdAt: row.created_at,
    voidedAt: row.voided_at,
    voidedBy: row.voided_by,
    voidReason: row.void_reason,
  };
}

/** One worker's payment history, newest first — the worker's own screen
 * shows this (Naldo 2026-08-30), and it is what settles a "you never paid me
 * for that week" conversation. */
export async function listSettlements(workerId: string): Promise<AdvertisingSettlement[]> {
  const db = requireDb();
  const settlements = await readSettlements(db, workerId.trim());
  const lines = await readLinesForSettlements(
    db,
    settlements.map((s) => s.id),
  );
  const countBySettlement = new Map<string, number>();
  for (const line of lines) {
    countBySettlement.set(line.settlement_id, (countBySettlement.get(line.settlement_id) ?? 0) + 1);
  }
  // readSettlements already orders by (paid_at, id), a TOTAL order, so
  // reversing it is newest-first even when two payments share a millisecond
  // — re-sorting on the timestamp alone would leave those two in whatever
  // order the sort happened to land on.
  return settlements
    .map((s) => toSettlement(s, countBySettlement.get(s.id) ?? 0))
    .reverse();
}

/**
 * VOID a settlement (ledger row 492, Naldo's ruling 2026-08-31): a payment
 * recorded by mistake is undone WITHOUT losing the record that it was
 * recorded. The row stays, carrying who recorded it, who undid it and why;
 * it stops counting toward what the worker has been paid; and the photos it
 * covered become payable again.
 *
 * An overlay, not a delete, matching how a placement is voided. There is no
 * un-void: a payment voided in error is simply recorded again, which is also
 * why the photos have to be released.
 *
 * The stamp goes on the settlement AND on its lines, because the partial
 * unique index that releases the photos keys on the line (an index cannot
 * read another table). The LINES are stamped FIRST: that write is the one
 * that releases the money, and if it fails the payment must stay whole
 * rather than end up half-voided, counting for nothing while still blocking
 * its photos. CAS on voided_at IS NULL, so the first void wins and a retry
 * returns it unchanged.
 */
export async function voidSettlement(
  settlementId: string,
  voidedBy: string,
  reason: string,
): Promise<AdvertisingSettlement> {
  const db = requireDb();
  const id = settlementId.trim();
  const voidReason = reason.trim();
  if (!voidReason) throw new Error('voidSettlement: a reason is required');

  const { data: existingRows, error: readError } = await db
    .from('advertising_settlements')
    .select(SETTLEMENT_SELECT)
    .eq('id', id)
    .limit(1);
  if (readError) throw new Error(`voidSettlement: ${readError.message}`);
  const existing = ((existingRows ?? []) as SettlementRow[])[0];
  if (!existing) throw new Error(`voidSettlement: no settlement found for id ${id}`);

  const lines = await readLinesForSettlements(db, [id]);
  if (existing.voided_at) {
    // Idempotent: the first void stands, reason and actor included.
    return toSettlement(existing, lines.filter((line) => !line.voided_at).length);
  }

  const voidedAt = new Date().toISOString();

  // Release the photos first. Until these are stamped the money is still
  // claimed, so a failure here leaves a whole, live payment rather than a
  // settlement that counts for nothing while its photos stay locked.
  const { error: linesError } = await db
    .from('advertising_settlement_lines')
    .update({ voided_at: voidedAt })
    .eq('settlement_id', id)
    .is('voided_at', null);
  if (linesError) {
    // Nothing has moved yet: this is the FIRST write, so the payment is
    // still whole and still counts. Safe to say nothing changed.
    throw new Error(`voidSettlement: the photos could not be released (${linesError.message}), nothing was voided`);
  }

  const { data, error } = await db
    .from('advertising_settlements')
    .update({ voided_at: voidedAt, voided_by: voidedBy, void_reason: voidReason })
    .eq('id', id)
    .is('voided_at', null)
    .select(SETTLEMENT_SELECT)
    .maybeSingle();
  if (error) {
    // The lines ARE already released, so this is NOT "nothing changed": the
    // payment already counts as $0 while still reading as live. Retrying
    // this same call heals it (the line update is a no-op second time), so
    // say that rather than implying the books are untouched.
    throw new Error(
      `voidSettlement: the photos were released but settlement ${id} still reads as live (${error.message}) — run the undo again to finish it`,
    );
  }

  const voided = data as SettlementRow | null;
  if (!voided) {
    // Another admin won the race between our read and our write. Their stamp
    // stands, and the lines are released either way. Return THEIR row and
    // write NO audit event: this call changed nothing, and a second
    // settlement_voided carrying our actor and our reason would put a void
    // in the trail that never happened, misattributed to the wrong admin.
    // voidPlacement's own lost-race branch returns early for the same reason.
    const { data: currentRows } = await db
      .from('advertising_settlements')
      .select(SETTLEMENT_SELECT)
      .eq('id', id)
      .limit(1);
    const current = ((currentRows ?? []) as SettlementRow[])[0];
    if (!current?.voided_at) {
      throw new Error(`voidSettlement: settlement ${id} could not be voided`);
    }
    return toSettlement(current, lines.filter((line) => !line.voided_at).length);
  }

  await logAdvertisingActivity({
    actor: voidedBy,
    action: 'settlement_voided',
    workerId: voided.worker_id,
    detail: {
      settlementId: voided.id,
      totalCents: voided.total_cents,
      lineCount: lines.length,
      method: voided.method,
      reason: voidReason,
    },
  });

  return toSettlement(voided, lines.length);
}

/**
 * Record that money was handed to a worker for these exact photos.
 *
 * Every named photo is re-read and must still be this worker's, accepted,
 * live, real, and unpaid — the check happens at the write, not at whatever
 * the screen was showing. The total is the sum of the STAMPED rates, never a
 * recomputed one, and it is asserted against the lines that actually landed
 * before the payment is allowed to stand.
 *
 * Under a double-submit the database decides: `placement_id` is unique
 * across settlement lines, so the second insert loses and its own settlement
 * row is unwound, leaving exactly one payment and a named conflict for the
 * caller. Nothing here ever touches a placement row — earned is history.
 */
export async function recordSettlement(
  workerId: string,
  placementIds: string[],
  paidBy: string,
  opts: { method: SettlementMethod; note?: string },
): Promise<AdvertisingSettlement> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  if (!isSettlementMethod(opts.method)) {
    throw new Error(`recordSettlement: unknown payment method — use one of ${SETTLEMENT_METHODS.join(', ')}`);
  }

  const id = workerId.trim();
  const ids = [...new Set(placementIds.map((p) => p.trim()).filter(Boolean))];
  if (ids.length === 0) {
    throw new Error('recordSettlement: no photos selected — there is nothing to pay');
  }

  const worker = await getAdvertisingWorker(id);
  if (!worker) throw new Error(`recordSettlement: no advertising worker found for id ${id}`);
  if (worker.isTest) {
    throw new Error(`recordSettlement: ${worker.displayName} is a test worker and cannot be paid`);
  }

  // Re-read every named photo. The screen's idea of what is payable can be
  // minutes old; this is the check that counts.
  const rows: PlacementRow[] = [];
  for (const part of chunk(ids, ID_CHUNK)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('advertising_placements')
        .select(PLACEMENT_SELECT)
        .in('id', part)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`recordSettlement: ${error.message}`);
      const page = (data ?? []) as PlacementRow[];
      rows.push(...page);
      if (page.length < PAGE) break;
    }
  }
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const placementId of ids) {
    const row = byId.get(placementId);
    if (!row) throw new Error(`recordSettlement: no photo found for id ${placementId}`);
    if (row.worker_id !== id) {
      throw new Error(`recordSettlement: photo ${placementId} belongs to another worker and cannot be paid here`);
    }
    if (row.is_test) throw new Error(`recordSettlement: photo ${placementId} is a test row and is not real money`);
    if (row.voided_at) throw new Error(`recordSettlement: photo ${placementId} is voided and pays nothing`);
    if (row.status !== 'accepted') {
      throw new Error(`recordSettlement: photo ${placementId} is not accepted (${row.status}) and cannot be paid`);
    }
    if (row.accepted_rate_cents == null) {
      throw new Error(`recordSettlement: photo ${placementId} carries no stamped rate and cannot be paid`);
    }
  }

  const already = (await readLinesForPlacements(db, ids)).filter((line) => !line.voided_at);
  if (already.length > 0) {
    const names = already.map((l) => l.placement_id).join(', ');
    throw new Error(`recordSettlement: ${names} has already been paid — reload the pay screen`);
  }

  const totalCents = ids.reduce((sum, placementId) => sum + (byId.get(placementId)?.accepted_rate_cents ?? 0), 0);
  if (totalCents <= 0) {
    throw new Error(`recordSettlement: these photos are worth ${dollars(totalCents)} — there is nothing to pay`);
  }

  const { data: created, error: settlementError } = await db
    .from('advertising_settlements')
    .insert({
      worker_id: id,
      total_cents: totalCents,
      method: opts.method,
      note: opts.note?.trim() || null,
      paid_by: paidBy,
    })
    .select(SETTLEMENT_SELECT)
    .maybeSingle();
  if (settlementError) throw new Error(`recordSettlement: ${settlementError.message}`);
  if (!created) throw new Error('recordSettlement: the payment could not be recorded');
  const settlement = created as SettlementRow;

  /**
   * Unwind our own half-written payment. The lines cascade with it.
   *
   * Retried, because this is the only thing standing between a failed write
   * and a bad state, and the stakes differ by call site (delta-verify, PR
   * #1130). Before the lines land, a leftover settlement row contributes
   * nothing: settled money is summed from LINES, not from total_cents. After
   * they land, a failed delete leaves a photo genuinely voided AND paid, so
   * the message has to name the row and ask for it by hand rather than say
   * "try again", which would be useless advice.
   */
  const unwind = async (linesLanded = false) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { error } = await db.from('advertising_settlements').delete().eq('id', settlement.id);
      if (!error) return;
      console.error(`recordSettlement unwind attempt ${attempt + 1} failed:`, error.message);
    }
    throw new Error(
      linesLanded
        ? `recordSettlement: settlement ${settlement.id} was recorded and could NOT be removed after a photo was voided mid-payment — this worker's paid and earned figures will disagree until settlement ${settlement.id} is reconciled by hand`
        : `recordSettlement: the payment could not be recorded AND settlement ${settlement.id} could not be removed — check it by hand before paying again`,
    );
  };

  const { error: linesError } = await db
    .from('advertising_settlement_lines')
    .insert(
      ids.map((placementId) => ({
        settlement_id: settlement.id,
        placement_id: placementId,
        amount_cents: byId.get(placementId)?.accepted_rate_cents ?? 0,
      })),
    )
    .select(LINE_SELECT);

  if (linesError) {
    await unwind();
    const duplicate =
      (linesError as { code?: string }).code === '23505' || /duplicate key/i.test(linesError.message ?? '');
    if (duplicate) {
      throw new Error(
        'recordSettlement: one of these photos was paid a moment ago — reload the pay screen and try again',
      );
    }
    throw new Error(`recordSettlement: ${linesError.message}`);
  }

  // Trap 8: the total is only true if the lines behind it actually landed.
  // Read them back rather than trusting the insert's own echo.
  const stored = (await readLinesForSettlements(db, [settlement.id])).filter((line) => !line.voided_at);
  const storedSum = stored.reduce((sum, line) => sum + line.amount_cents, 0);
  if (stored.length !== ids.length || storedSum !== totalCents) {
    // Some lines may already be on the books here, and settled money is
    // summed from LINES: if the delete then fails, those lines are real paid
    // money against a settlement nobody meant to keep. Tell unwind the truth
    // about what landed so its message asks for the right thing.
    await unwind(stored.length > 0);
    throw new Error(
      `recordSettlement: the payment's lines did not land in full (${stored.length} of ${ids.length}, ${dollars(storedSum)} of ${dollars(totalCents)}) — nothing was recorded`,
    );
  }

  // The void side of this race, closed from the settle side (technical lens,
  // PR #1130). Everything above was validated against a snapshot read before
  // the insert. A void landing in that window passes ITS OWN guard, because
  // no settlement line existed yet when it looked — leaving the photo voided
  // (so it counts nothing toward earned) AND paid (so it counts toward
  // settled), which is exactly how unpaid goes negative.
  //
  // The line insert is the serialisation point: once a line exists, any
  // later void is refused by placementIsPaid. So re-reading voided_at HERE,
  // after the lines have landed, catches every ordering. If a void won the
  // gap, unwind the payment and refuse: the photo stays voided and unpaid,
  // and the two figures stay consistent.
  const afterWrite: PlacementRow[] = [];
  for (const part of chunk(ids, ID_CHUNK)) {
    const { data, error } = await db
      .from('advertising_placements')
      .select('id, voided_at')
      .in('id', part)
      .order('id', { ascending: true })
      .range(0, PAGE - 1);
    if (error) {
      await unwind(true);
      throw new Error(`recordSettlement: could not confirm the photos were still live — nothing was recorded`);
    }
    afterWrite.push(...((data ?? []) as PlacementRow[]));
  }
  const votedAfter = afterWrite.filter((row) => row.voided_at);
  if (votedAfter.length > 0) {
    await unwind(true);
    throw new Error(
      `recordSettlement: ${votedAfter.map((r) => r.id).join(', ')} was voided while this payment was being written — nothing was recorded`,
    );
  }

  await logAdvertisingActivity({
    actor: paidBy,
    action: 'settlement_recorded',
    workerId: id,
    detail: {
      settlementId: settlement.id,
      totalCents,
      lineCount: ids.length,
      method: opts.method,
      note: settlement.note,
    },
  });

  return toSettlement(settlement, ids.length);
}
