import { getSupabaseServiceClient } from '@/lib/supabase';
import { etDayKey } from '@/lib/dashboard/inbox/normalize';
import { logAdvertisingActivity } from '@/lib/advertising/activity';

// Placements: one row per yard sign (or door hanger) placed, plus the review
// transitions and the earnings math. The money rules (Naldo 2026-08-27, do
// not reopen): $2.50 per ACCEPTED yard sign, stamped onto the placement at
// acceptance (accepted_rate_cents) so later rate changes never move history;
// pending and rejected placements never count for pay; a
// rejected-then-resubmitted-then-accepted placement pays exactly once; door
// hangers are modeled but pay for them is PERMANENTLY EXCLUDED until Naldo
// approves a rule. The same rules exist as CHECK constraints in
// migrations/2026-08-28-advertising-schema.sql; the guards here are the
// data-layer mirror so a bad call fails with a named message instead of a
// raw 23514.

export type PlacementKind = 'yard_sign' | 'door_hanger';
export type PlacementStatus = 'pending' | 'accepted' | 'rejected' | 'resubmitted';

export type AdvertisingPlacement = {
  id: string;
  campaignId: string;
  workerId: string;
  kind: PlacementKind;
  status: PlacementStatus;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  capturedAt: string | null;
  photoPath: string | null;
  suggestedAddress: string | null;
  route: string | null;
  neighborhood: string | null;
  propertyId: string | null;
  rejectionReason: string | null;
  acceptedRateCents: number | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  isTest: boolean;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: string;
  campaign_id: string;
  worker_id: string;
  kind: PlacementKind;
  status: PlacementStatus;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  captured_at: string | null;
  photo_path: string | null;
  suggested_address: string | null;
  route: string | null;
  neighborhood: string | null;
  property_id: string | null;
  rejection_reason: string | null;
  accepted_rate_cents: number | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  is_test: boolean;
  created_at: string;
  updated_at: string;
};

const SELECT =
  'id, campaign_id, worker_id, kind, status, lat, lng, accuracy_m, captured_at, photo_path, suggested_address, route, neighborhood, property_id, rejection_reason, accepted_rate_cents, reviewed_by, reviewed_at, is_test, created_at, updated_at';

function toPlacement(row: Row): AdvertisingPlacement {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    workerId: row.worker_id,
    kind: row.kind,
    status: row.status,
    lat: row.lat,
    lng: row.lng,
    accuracyM: row.accuracy_m,
    capturedAt: row.captured_at,
    photoPath: row.photo_path,
    suggestedAddress: row.suggested_address,
    route: row.route,
    neighborhood: row.neighborhood,
    propertyId: row.property_id,
    rejectionReason: row.rejection_reason,
    acceptedRateCents: row.accepted_rate_cents,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    isTest: row.is_test,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type Db = NonNullable<ReturnType<typeof getSupabaseServiceClient>>;

async function getPlacementRow(db: Db, id: string): Promise<Row | null> {
  const { data, error } = await db.from('advertising_placements').select(SELECT).eq('id', id).maybeSingle();
  if (error) throw new Error(`getPlacement: ${error.message}`);
  return (data as Row | null) ?? null;
}

// Audit appends go through logAdvertisingActivity (activity.ts) — see the
// actor convention documented there: worker id for worker actions, auth user
// id for review actions.

export async function getPlacement(id: string): Promise<AdvertisingPlacement | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  try {
    const row = await getPlacementRow(db, id.trim());
    return row ? toPlacement(row) : null;
  } catch (error) {
    console.error('getPlacement error:', error);
    return null;
  }
}

/** PostgREST silently caps an unranged select at 1000 rows (the repo has
 * been bitten before — see selfServeMetrics.ts / inbox store #310). Every
 * read here is either explicitly bounded (listPlacements) or paged to
 * completeness (earningsSummary — money totals must never truncate). */
const PAGE_SIZE = 1000;

/**
 * Newest-first listing, explicitly BOUNDED (default 500, max 1000 per call).
 * This is a display read; anything that needs every row (pay math) goes
 * through the paged fetch inside earningsSummary instead.
 */
export async function listPlacements(opts?: {
  workerId?: string;
  campaignId?: string;
  status?: PlacementStatus;
  limit?: number;
}): Promise<AdvertisingPlacement[]> {
  const db = getSupabaseServiceClient();
  if (!db) return [];
  const limit = Math.max(1, Math.min(opts?.limit ?? 500, PAGE_SIZE));
  let query = db.from('advertising_placements').select(SELECT);
  if (opts?.workerId) query = query.eq('worker_id', opts.workerId.trim());
  if (opts?.campaignId) query = query.eq('campaign_id', opts.campaignId.trim());
  if (opts?.status) query = query.eq('status', opts.status);
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(0, limit - 1);
  if (error) {
    console.error('listPlacements error:', error);
    return [];
  }
  return (data ?? []).map((row) => toPlacement(row as Row));
}

export async function submitPlacement(input: {
  campaignId: string;
  workerId: string;
  kind: PlacementKind;
  lat: number;
  lng: number;
  accuracyM?: number | null;
  capturedAt?: string | null;
  photoPath: string;
  suggestedAddress?: string | null;
  route?: string | null;
  neighborhood?: string | null;
  propertyId?: string | null;
  isTest?: boolean;
}): Promise<AdvertisingPlacement> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const photoPath = input.photoPath.trim();
  if (!photoPath) throw new Error('submitPlacement: a proof photo is required');
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) {
    throw new Error('submitPlacement: GPS coordinates are required');
  }
  if (input.lat < -90 || input.lat > 90 || input.lng < -180 || input.lng > 180) {
    throw new Error('submitPlacement: GPS coordinates out of range');
  }
  if (input.kind !== 'yard_sign' && input.kind !== 'door_hanger') {
    throw new Error(`submitPlacement: unknown kind ${String(input.kind)}`);
  }

  const { data, error } = await db
    .from('advertising_placements')
    .insert({
      campaign_id: input.campaignId.trim(),
      worker_id: input.workerId.trim(),
      kind: input.kind,
      status: 'pending',
      lat: input.lat,
      lng: input.lng,
      accuracy_m: input.accuracyM ?? null,
      captured_at: input.capturedAt ?? new Date().toISOString(),
      photo_path: photoPath,
      suggested_address: input.suggestedAddress?.trim() || null,
      route: input.route?.trim() || null,
      neighborhood: input.neighborhood?.trim() || null,
      property_id: input.propertyId ?? null,
      is_test: input.isTest ?? false,
    })
    .select(SELECT)
    .maybeSingle();
  if (error) throw new Error(`submitPlacement: ${error.message}`);
  if (!data) throw new Error('submitPlacement: no row returned');

  const placement = toPlacement(data as Row);
  await logAdvertisingActivity({
    actor: placement.workerId,
    action: 'submitted',
    placementId: placement.id,
    workerId: placement.workerId,
    detail: { kind: placement.kind },
  });
  return placement;
}

/**
 * Accept a placement, stamping the campaign's CURRENT rate onto it (yard
 * signs only — door hangers accept with no rate, permanently unpaid).
 *
 * The status filter (`in ('pending','resubmitted')`) is a compare-and-swap:
 * a concurrent or retried accept matches no row, and the recovery path
 * returns the already-accepted row UNCHANGED — that is what makes
 * reject→resubmit→accept (and a double-clicked accept) pay exactly once.
 * The stamp only ever happens on the transition into 'accepted'.
 */
export async function acceptPlacement(id: string, reviewedBy: string): Promise<AdvertisingPlacement> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const placementId = id.trim();
  const row = await getPlacementRow(db, placementId);
  if (!row) throw new Error(`acceptPlacement: no placement found for id ${placementId}`);
  if (row.status === 'accepted') return toPlacement(row); // idempotent retry
  if (row.status === 'rejected') {
    throw new Error('acceptPlacement: placement is rejected — it must be resubmitted before it can be accepted');
  }
  if (!row.photo_path) {
    // Mirror of the advertising_placements_accepted_shape CHECK: an accepted
    // placement is a pay event and must carry its proof photo.
    throw new Error('acceptPlacement: placement has no proof photo, so it cannot be accepted');
  }

  let acceptedRateCents: number | null = null;
  if (row.kind === 'yard_sign') {
    const { data: campaign, error: campaignError } = await db
      .from('advertising_campaigns')
      .select('id, rate_cents')
      .eq('id', row.campaign_id)
      .maybeSingle();
    if (campaignError || !campaign) {
      throw new Error(`acceptPlacement: could not read campaign rate: ${campaignError?.message ?? 'campaign missing'}`);
    }
    const rate = (campaign as { rate_cents: number }).rate_cents;
    if (!Number.isInteger(rate) || rate < 0) {
      throw new Error(`acceptPlacement: campaign rate ${String(rate)} is not a valid cent amount`);
    }
    acceptedRateCents = rate;
  }

  const { data, error } = await db
    .from('advertising_placements')
    .update({
      status: 'accepted',
      accepted_rate_cents: acceptedRateCents,
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', placementId)
    .in('status', ['pending', 'resubmitted'])
    .select(SELECT)
    .maybeSingle();
  if (error) throw new Error(`acceptPlacement: ${error.message}`);

  if (!data) {
    // Lost the CAS race: someone else reviewed it between our read and write.
    const current = await getPlacementRow(db, placementId);
    if (current?.status === 'accepted') return toPlacement(current);
    throw new Error(
      `acceptPlacement: placement ${placementId} moved to '${current?.status ?? 'missing'}' before this accept landed`,
    );
  }

  const accepted = toPlacement(data as Row);
  await logAdvertisingActivity({
    actor: reviewedBy,
    action: 'accepted',
    placementId: accepted.id,
    workerId: accepted.workerId,
    detail: { kind: accepted.kind, acceptedRateCents: accepted.acceptedRateCents },
  });
  return accepted;
}

/** Reject with a required reason (the worker sees it). Same CAS shape as
 * accept; a retried reject returns the already-rejected row unchanged. */
export async function rejectPlacement(
  id: string,
  reviewedBy: string,
  reason: string,
): Promise<AdvertisingPlacement> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const placementId = id.trim();
  const rejectionReason = reason.trim();
  if (!rejectionReason) {
    // Mirror of the advertising_placements_rejected_has_reason CHECK.
    throw new Error('rejectPlacement: a rejection reason is required');
  }

  const { data, error } = await db
    .from('advertising_placements')
    .update({
      status: 'rejected',
      rejection_reason: rejectionReason,
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', placementId)
    .in('status', ['pending', 'resubmitted'])
    .select(SELECT)
    .maybeSingle();
  if (error) throw new Error(`rejectPlacement: ${error.message}`);

  if (!data) {
    const current = await getPlacementRow(db, placementId);
    if (!current) throw new Error(`rejectPlacement: no placement found for id ${placementId}`);
    if (current.status === 'rejected') return toPlacement(current); // idempotent retry
    throw new Error(`rejectPlacement: placement ${placementId} is '${current.status}' and cannot be rejected`);
  }

  const rejected = toPlacement(data as Row);
  await logAdvertisingActivity({
    actor: reviewedBy,
    action: 'rejected',
    placementId: rejected.id,
    workerId: rejected.workerId,
    detail: { reason: rejectionReason },
  });
  return rejected;
}

/** Worker asks for another look at a rejected placement. The rejection
 * reason is deliberately KEPT (the worker can still see why the last review
 * said no); accept/reject stamp fresh review fields when they land. */
export async function resubmitPlacement(id: string): Promise<AdvertisingPlacement> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const placementId = id.trim();
  const { data, error } = await db
    .from('advertising_placements')
    .update({ status: 'resubmitted' })
    .eq('id', placementId)
    .eq('status', 'rejected')
    .select(SELECT)
    .maybeSingle();
  if (error) throw new Error(`resubmitPlacement: ${error.message}`);

  if (!data) {
    const current = await getPlacementRow(db, placementId);
    if (!current) throw new Error(`resubmitPlacement: no placement found for id ${placementId}`);
    if (current.status === 'resubmitted') return toPlacement(current); // idempotent retry
    throw new Error(`resubmitPlacement: placement ${placementId} is '${current.status}', only rejected placements can be resubmitted`);
  }

  const resubmitted = toPlacement(data as Row);
  await logAdvertisingActivity({
    actor: resubmitted.workerId,
    action: 'resubmitted',
    placementId: resubmitted.id,
    workerId: resubmitted.workerId,
  });
  return resubmitted;
}

// --- Earnings -----------------------------------------------------------------

export type EarningsBucket = {
  pendingEstimatedCents: number;
  acceptedEarnedCents: number;
};

export type WorkerEarningsSummary = {
  workerId: string;
  total: EarningsBucket;
  byDay: Array<{ day: string } & EarningsBucket>;
  byWeek: Array<{ weekStart: string } & EarningsBucket>;
};

/** The ET Monday that starts the week holding this instant. Pure calendar
 * arithmetic on the ET day key, so DST transitions cannot shift a bucket. */
export function etWeekStartKey(d: Date): string {
  const [y, m, day] = etDayKey(d).split('-').map(Number);
  const utcNoon = Date.UTC(y, m - 1, day, 12);
  const weekday = new Date(utcNoon).getUTCDay(); // 0 = Sunday
  const daysSinceMonday = (weekday + 6) % 7;
  const monday = new Date(utcNoon - daysSinceMonday * 24 * 3600_000);
  const mm = String(monday.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(monday.getUTCDate()).padStart(2, '0');
  return `${monday.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * Pure earnings math over placement rows — exported so the money rules are
 * testable with no database in the loop.
 *
 * Earned: accepted YARD SIGNS only, at the STAMPED accepted_rate_cents,
 * bucketed by the ET day/week of reviewed_at (pay accrues at acceptance).
 * Pending estimate: pending + resubmitted yard signs at the campaign's
 * CURRENT rate, bucketed by captured_at (falling back to created_at).
 * Nothing else ever counts: rejected rows, door hangers (permanently
 * unpaid), and is_test rows all contribute zero.
 */
export function summarizeEarnings(
  placements: AdvertisingPlacement[],
  currentRateCentsByCampaign: Map<string, number>,
): WorkerEarningsSummary[] {
  type Acc = {
    total: EarningsBucket;
    byDay: Map<string, EarningsBucket>;
    byWeek: Map<string, EarningsBucket>;
  };
  const byWorker = new Map<string, Acc>();

  const bucket = (map: Map<string, EarningsBucket>, key: string): EarningsBucket => {
    let b = map.get(key);
    if (!b) {
      b = { pendingEstimatedCents: 0, acceptedEarnedCents: 0 };
      map.set(key, b);
    }
    return b;
  };

  for (const p of placements) {
    if (p.isTest) continue;

    // Every real placement mints its worker's summary entry, so a worker
    // whose rows are all door hangers or rejections still shows up with
    // zeros instead of silently vanishing from their own earnings view.
    let acc = byWorker.get(p.workerId);
    if (!acc) {
      acc = {
        total: { pendingEstimatedCents: 0, acceptedEarnedCents: 0 },
        byDay: new Map(),
        byWeek: new Map(),
      };
      byWorker.set(p.workerId, acc);
    }

    if (p.kind !== 'yard_sign') continue; // door hangers: permanently unpaid

    let earned = 0;
    let estimated = 0;
    let at: string | null = null;

    if (p.status === 'accepted') {
      if (p.acceptedRateCents == null) continue; // unstorable by CHECK; belt-and-braces
      earned = p.acceptedRateCents;
      at = p.reviewedAt ?? p.createdAt;
    } else if (p.status === 'pending' || p.status === 'resubmitted') {
      estimated = currentRateCentsByCampaign.get(p.campaignId) ?? 0;
      at = p.capturedAt ?? p.createdAt;
    } else {
      continue; // rejected: never pays, never estimates
    }

    acc.total.acceptedEarnedCents += earned;
    acc.total.pendingEstimatedCents += estimated;

    const when = new Date(at);
    const day = bucket(acc.byDay, etDayKey(when));
    day.acceptedEarnedCents += earned;
    day.pendingEstimatedCents += estimated;
    const week = bucket(acc.byWeek, etWeekStartKey(when));
    week.acceptedEarnedCents += earned;
    week.pendingEstimatedCents += estimated;
  }

  return [...byWorker.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([workerId, acc]) => ({
      workerId,
      total: acc.total,
      byDay: [...acc.byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, b]) => ({ day, ...b })),
      byWeek: [...acc.byWeek.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([weekStart, b]) => ({ weekStart, ...b })),
    }));
}

/** PURE: door hangers placed per worker (ops suggestions round). Door
 * hangers are permanently unpaid, so they appear in no money figure — this
 * count is how the admin pay page shows the hustle anyway, and whether
 * workers bother logging them at all. Test rows count for nothing, same as
 * everywhere else. */
export function countDoorHangersByWorker(placements: AdvertisingPlacement[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of placements) {
    if (p.isTest || p.kind !== 'door_hanger') continue;
    out.set(p.workerId, (out.get(p.workerId) ?? 0) + 1);
  }
  return out;
}

/** Per-worker earnings: pending estimated cents and accepted earned cents,
 * total plus ET day and week groupings. Scope with workerId for the worker's
 * own view; unscoped for the admin pay summary. */
export async function earningsSummary(opts?: { workerId?: string }): Promise<WorkerEarningsSummary[]> {
  const db = getSupabaseServiceClient();
  if (!db) return [];

  // Page to completeness: a pay total computed from a silently truncated
  // read is exactly the wrong-money class this repo's history warns about.
  const placements: AdvertisingPlacement[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = db.from('advertising_placements').select(SELECT);
    if (opts?.workerId) query = query.eq('worker_id', opts.workerId.trim());
    // The id tiebreaker makes the page order TOTAL: rows sharing one
    // created_at (a bulk backfill) can otherwise be double-counted or
    // dropped across a page boundary, which is the exact truncation class
    // this paging exists to close.
    const { data, error } = await query
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      console.error('earningsSummary placements error:', error);
      return [];
    }
    const rows = (data ?? []) as Row[];
    placements.push(...rows.map((row) => toPlacement(row)));
    if (rows.length < PAGE_SIZE) break;
  }

  const rateByCampaign = new Map<string, number>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: campaigns, error: campaignsError } = await db
      .from('advertising_campaigns')
      .select('id, rate_cents')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (campaignsError) {
      console.error('earningsSummary campaigns error:', campaignsError);
      return [];
    }
    const rows = (campaigns ?? []) as { id: string; rate_cents: number }[];
    for (const c of rows) rateByCampaign.set(c.id, c.rate_cents);
    if (rows.length < PAGE_SIZE) break;
  }

  return summarizeEarnings(placements, rateByCampaign);
}
