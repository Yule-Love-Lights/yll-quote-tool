import { getSupabaseServiceClient } from '@/lib/supabase';

// Campaign rate config is MONEY: rate_cents is the CURRENT
// per-accepted-yard-sign rate (default 250 = $2.50, Naldo 2026-08-27). It is
// read at acceptance time and stamped onto the placement
// (accepted_rate_cents); changing it here affects FUTURE acceptances only —
// pay history never moves.

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

export const DEFAULT_YARD_SIGN_RATE_CENTS = 250;

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
  const rateCents = input.rateCents ?? DEFAULT_YARD_SIGN_RATE_CENTS;
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
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) {
    console.error('listAdvertisingCampaigns error:', error);
    return [];
  }
  return (data ?? []).map((row) => toCampaign(row as Row));
}

export async function updateAdvertisingCampaign(
  id: string,
  patch: { name?: string; notes?: string | null; rateCents?: number; active?: boolean },
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

  const { data, error } = await db
    .from('advertising_campaigns')
    .update(payload)
    .eq('id', id.trim())
    .select(SELECT)
    .maybeSingle();
  if (error) throw new Error(`updateAdvertisingCampaign: ${error.message}`);
  return data ? toCampaign(data as Row) : null;
}
