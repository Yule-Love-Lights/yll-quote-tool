import { getSupabaseServiceClient } from '@/lib/supabase';

// Advertising workers are their OWN population (Naldo 2026-08-27, audit doc
// section 13 q1): identity rows live here, never in crew_members; they share
// only the Supabase auth store. Accounts carry app_metadata.role =
// 'advertising' and are rejected by getOperator / the role-aware proxy
// (#1043) — nothing in this module mints logins, it only stores the link.

export type AdvertisingWorker = {
  id: string;
  displayName: string;
  authUserId: string | null;
  active: boolean;
  isTest: boolean;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: string;
  display_name: string;
  auth_user_id: string | null;
  active: boolean;
  is_test: boolean;
  created_at: string;
  updated_at: string;
};

const SELECT = 'id, display_name, auth_user_id, active, is_test, created_at, updated_at';

function toWorker(row: Row): AdvertisingWorker {
  return {
    id: row.id,
    displayName: row.display_name,
    authUserId: row.auth_user_id,
    active: row.active,
    isTest: row.is_test,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isDisplayNameUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '23505' && error.message?.includes('advertising_workers_display_name_key') === true;
}

function isAuthUserIdUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '23505' && error.message?.includes('advertising_workers_auth_user_id_key') === true;
}

/** Thrown when a login is already linked to a DIFFERENT worker — one login
 * must never back two payees (that would let one person accrue another's
 * sign money). */
export class WorkerLoginTakenError extends Error {
  constructor() {
    super('That login is already linked to another advertising worker.');
    this.name = 'WorkerLoginTakenError';
  }
}

export async function createAdvertisingWorker(input: {
  displayName: string;
  authUserId?: string | null;
  isTest?: boolean;
}): Promise<AdvertisingWorker> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const displayName = input.displayName.trim();
  if (!displayName) throw new Error('createAdvertisingWorker: display name is required');

  const payload: Record<string, unknown> = {
    display_name: displayName,
    auth_user_id: input.authUserId ?? null,
    is_test: input.isTest ?? false,
  };

  const { data, error } = await db.from('advertising_workers').insert(payload).select(SELECT).maybeSingle();
  if (error) {
    // The auth-link collision is checked FIRST: it is the pay-identity
    // conflict and must not be masked by the name message when both apply.
    if (isAuthUserIdUniqueViolation(error as { code?: string; message?: string })) {
      throw new WorkerLoginTakenError();
    }
    if (isDisplayNameUniqueViolation(error as { code?: string; message?: string })) {
      // Two concurrent creates for the same person: recover the winner, the
      // insertCrewMember pattern. The unique index is on lower(trim()), so a
      // case-insensitive refetch finds it.
      const { data: winner, error: refetchError } = await db
        .from('advertising_workers')
        .select(SELECT)
        .ilike('display_name', displayName)
        .maybeSingle();
      if (!refetchError && winner) return toWorker(winner as Row);
    }
    throw new Error(`createAdvertisingWorker: ${error.message}`);
  }
  if (!data) throw new Error('createAdvertisingWorker: no row returned');
  return toWorker(data as Row);
}

export async function getAdvertisingWorker(id: string): Promise<AdvertisingWorker | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  const { data, error } = await db.from('advertising_workers').select(SELECT).eq('id', id.trim()).maybeSingle();
  if (error || !data) return null;
  return toWorker(data as Row);
}

export async function getAdvertisingWorkerByAuthUserId(authUserId: string): Promise<AdvertisingWorker | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  const { data, error } = await db
    .from('advertising_workers')
    .select(SELECT)
    .eq('auth_user_id', authUserId.trim())
    .maybeSingle();
  if (error || !data) return null;
  return toWorker(data as Row);
}

export async function listAdvertisingWorkers(opts?: { includeInactive?: boolean }): Promise<AdvertisingWorker[]> {
  const db = getSupabaseServiceClient();
  if (!db) return [];
  let query = db.from('advertising_workers').select(SELECT);
  if (!opts?.includeInactive) query = query.eq('active', true);
  // Explicitly bounded display read (PostgREST caps unranged selects at
  // 1000 silently anyway; saying so keeps the truncation visible here).
  const { data, error } = await query.order('display_name', { ascending: true }).range(0, 999);
  if (error) {
    console.error('listAdvertisingWorkers error:', error);
    return [];
  }
  return (data ?? []).map((row) => toWorker(row as Row));
}

/** Deactivate rather than delete: a worker with placement history cannot be
 * deleted anyway (plain FK, Postgres refuses), and inactive keeps pay history
 * readable. Returns null when the id matches nothing. */
export async function setAdvertisingWorkerActive(id: string, active: boolean): Promise<AdvertisingWorker | null> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');
  const { data, error } = await db
    .from('advertising_workers')
    .update({ active })
    .eq('id', id.trim())
    .select(SELECT)
    .maybeSingle();
  if (error) throw new Error(`setAdvertisingWorkerActive: ${error.message}`);
  return data ? toWorker(data as Row) : null;
}
