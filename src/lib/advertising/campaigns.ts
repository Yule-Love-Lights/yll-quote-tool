import { getSupabaseServiceClient } from '@/lib/supabase';
import { logAdvertisingActivity } from '@/lib/advertising/activity';

// Campaign rate config is MONEY: rate_cents is the CURRENT
// per-accepted-PHOTO rate (default 250 = $2.50; per-photo basis is Naldo's
// 2026-08-29 ruling — the campaign's name says whether the photos are yard
// signs or door hangers). It is read at acceptance time and stamped onto the
// placement (accepted_rate_cents); changing it here affects FUTURE
// acceptances only — pay history never moves.

export type AdvertisingCampaign = {
  id: string;
  name: string;
  notes: string | null;
  rateCents: number;
  active: boolean;
  isTest: boolean;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: string;
  name: string;
  notes: string | null;
  rate_cents: number;
  active: boolean;
  is_test: boolean;
  created_at: string;
  updated_at: string;
};

const SELECT = 'id, name, notes, rate_cents, active, is_test, created_at, updated_at';

export const DEFAULT_PHOTO_RATE_CENTS = 250;

function toCampaign(row: Row): AdvertisingCampaign {
  return {
    id: row.id,
    name: row.name,
    notes: row.notes,
    rateCents: row.rate_cents,
    active: row.active,
    isTest: row.is_test,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertValidRateCents(rateCents: number): void {
  if (!Number.isInteger(rateCents) || rateCents < 0) {
    throw new Error(`Invalid rate: ${rateCents} — the per-sign rate must be a non-negative integer number of cents`);
  }
}

export async function createAdvertisingCampaign(input: {
  name: string;
  notes?: string | null;
  rateCents?: number;
  isTest?: boolean;
}): Promise<AdvertisingCampaign> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const name = input.name.trim();
  if (!name) throw new Error('createAdvertisingCampaign: name is required');
  const rateCents = input.rateCents ?? DEFAULT_PHOTO_RATE_CENTS;
  assertValidRateCents(rateCents);

  const { data, error } = await db
    .from('advertising_campaigns')
    .insert({
      name,
      notes: input.notes?.trim() || null,
      rate_cents: rateCents,
      is_test: input.isTest ?? false,
    })
    .select(SELECT)
    .maybeSingle();
  if (error) throw new Error(`createAdvertisingCampaign: ${error.message}`);
  if (!data) throw new Error('createAdvertisingCampaign: no row returned');
  return toCampaign(data as Row);
}

export async function getAdvertisingCampaign(id: string): Promise<AdvertisingCampaign | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  const { data, error } = await db.from('advertising_campaigns').select(SELECT).eq('id', id.trim()).maybeSingle();
  if (error || !data) return null;
  return toCampaign(data as Row);
}

export async function listAdvertisingCampaigns(opts?: { includeInactive?: boolean }): Promise<AdvertisingCampaign[]> {
  const db = getSupabaseServiceClient();
  if (!db) return [];
  let query = db.from('advertising_campaigns').select(SELECT);
  if (!opts?.includeInactive) query = query.eq('active', true);
  // Explicitly bounded display read (PostgREST caps unranged selects at
  // 1000 silently anyway; saying so keeps the truncation visible here).
  const { data, error } = await query.order('created_at', { ascending: false }).range(0, 999);
  if (error) {
    console.error('listAdvertisingCampaigns error:', error);
    return [];
  }
  return (data ?? []).map((row) => toCampaign(row as Row));
}

/** Thrown when a rate edit loses a race with another admin's edit: the
 * audit row's "prior rate" would have been a lie, so the write is refused
 * instead. Reload, look at the current rate, and edit again. */
export class CampaignRateConflictError extends Error {
  constructor() {
    super('The campaign rate changed while you were editing it. Reload and try again.');
    this.name = 'CampaignRateConflictError';
  }
}

/**
 * Patch a campaign. `actor` is REQUIRED — the auth user id of whoever is
 * editing (or 'system' for an automated write): a rate change decides what
 * every FUTURE acceptance pays, and it must never happen without a trace
 * (admin lens + delta-verify, PR #1057 review).
 *
 * A rate change is a compare-and-swap against the prior rate this caller
 * read: if another admin's edit landed in between, the write is refused
 * (CampaignRateConflictError) rather than logging a wrong "prior" — an
 * audit trail that lies is worse than none.
 */
export async function updateAdvertisingCampaign(
  id: string,
  patch: { name?: string; notes?: string | null; rateCents?: number; active?: boolean },
  actor: string,
): Promise<AdvertisingCampaign | null> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const payload: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('updateAdvertisingCampaign: name cannot be empty');
    payload.name = name;
  }
  if (patch.notes !== undefined) payload.notes = patch.notes?.trim() || null;
  if (patch.rateCents !== undefined) {
    assertValidRateCents(patch.rateCents);
    payload.rate_cents = patch.rateCents;
  }
  if (patch.active !== undefined) payload.active = patch.active;

  // Read the prior rate BEFORE the write, so the audit row can say what the
  // rate moved FROM — and CAS on it below, so what it says is TRUE.
  const changingRate = payload.rate_cents !== undefined;
  let priorRateCents: number | null = null;
  if (changingRate) {
    const prior = await getAdvertisingCampaign(id);
    if (!prior) throw new Error(`updateAdvertisingCampaign: no campaign found for id ${id.trim()}`);
    priorRateCents = prior.rateCents;
  }

  let query = db.from('advertising_campaigns').update(payload).eq('id', id.trim());
  if (changingRate) query = query.eq('rate_cents', priorRateCents);
  const { data, error } = await query.select(SELECT).maybeSingle();
  if (error) throw new Error(`updateAdvertisingCampaign: ${error.message}`);
  if (!data) {
    // With a rate patch, the row existed a moment ago (read above), so a
    // miss means the CAS lost: someone else moved the rate first.
    if (changingRate) throw new CampaignRateConflictError();
    return null;
  }
  const updated = toCampaign(data as Row);

  if (changingRate && priorRateCents !== updated.rateCents) {
    await logAdvertisingActivity({
      actor,
      action: 'rate_changed',
      detail: {
        campaignId: updated.id,
        campaignName: updated.name,
        priorRateCents,
        newRateCents: updated.rateCents,
      },
    });
  }

  return updated;
}
