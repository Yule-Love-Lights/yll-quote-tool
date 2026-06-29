// Admin user-management data layer (ledger #81 Slice 3). Wraps the Supabase
// service-role admin API (auth.admin.*) into the small shape the operator
// accounts UI needs, plus the pure countAdmins() that feeds the last-admin guard.

import type { SupabaseClient } from '@supabase/supabase-js';
import { roleOf, nameOf, type OperatorRole } from './supabaseServer';

export type OperatorAccount = {
  id: string;
  email: string | null;
  role: OperatorRole;
  name: string | null;
  createdAt: string | null;
  lastSignInAt: string | null;
};

type RawUser = {
  id: string;
  email?: string | null;
  app_metadata?: unknown;
  created_at?: string | null;
  last_sign_in_at?: string | null;
};

/** Map a Supabase auth user to the public account shape (role derived safely). */
export function toOperatorAccount(u: RawUser): OperatorAccount {
  return {
    id: u.id,
    email: u.email ?? null,
    role: roleOf(u.app_metadata),
    name: nameOf(u.app_metadata),
    createdAt: u.created_at ?? null,
    lastSignInAt: u.last_sign_in_at ?? null,
  };
}

/** Number of accounts with the admin role — drives the last-admin guard. PURE. */
export function countAdmins(accounts: OperatorAccount[]): number {
  return accounts.filter((a) => a.role === 'admin').length;
}

/**
 * List every operator account, sorted by display name (email fallback for
 * legacy nameless accounts). Throws on a Supabase error. Follows nextPage across
 * ALL pages — countAdmins() (the last-admin guard's input) must see every admin,
 * not just the first page.
 */
export async function listOperatorAccounts(sb: SupabaseClient): Promise<OperatorAccount[]> {
  const all: RawUser[] = [];
  let page = 1;
  // Safety cap — GoTrue returns nextPage = page+1 or null, so this terminates,
  // but bound it anyway so a misbehaving server can't spin forever.
  for (let guard = 0; guard < 1000; guard++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    all.push(...((data?.users ?? []) as RawUser[]));
    const next = (data as { nextPage?: number | null } | null)?.nextPage;
    if (!next) break;
    page = next;
  }
  return all
    .map(toOperatorAccount)
    .sort((a, b) => (a.name ?? a.email ?? '').localeCompare(b.name ?? b.email ?? ''));
}
