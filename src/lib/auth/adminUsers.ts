// Admin user-management data layer (ledger #81 Slice 3). Wraps the Supabase
// service-role admin API (auth.admin.*) into the small shape the operator
// accounts UI needs, plus the pure countAdmins() that feeds the last-admin guard.

import type { SupabaseClient } from '@supabase/supabase-js';
import { roleOf, nameOf, isCrewAccount, type OperatorRole } from './supabaseServer';

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
 * Every raw auth user, following nextPage across ALL pages. Throws on a Supabase
 * error. Shared by the listers below so both see the complete population — the
 * last-admin guard (countAdmins) and the office-onboarding picker must never work
 * off a truncated first page.
 */
async function listAllRawUsers(sb: SupabaseClient): Promise<RawUser[]> {
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
  return all;
}

function byNameThenEmail(a: OperatorAccount, b: OperatorAccount): number {
  return (a.name ?? a.email ?? '').localeCompare(b.name ?? b.email ?? '');
}

/**
 * List every operator account, sorted by display name (email fallback for
 * legacy nameless accounts). Throws on a Supabase error.
 */
export async function listOperatorAccounts(sb: SupabaseClient): Promise<OperatorAccount[]> {
  return (await listAllRawUsers(sb)).map(toOperatorAccount).sort(byNameThenEmail);
}

/**
 * Operator/admin accounts ONLY — crew logins excluded.
 *
 * `roleOf` collapses every non-admin role (including 'crew') to 'operator', so
 * `listOperatorAccounts` and any OperatorAccount would present a crew login as an
 * "operator". The office-onboarding picker must never offer a crew login as an
 * office staffer, so the crew exclusion is done HERE, on the RAW app_metadata,
 * before the role is flattened — matching the standing pitfall about auditing
 * every consumer of the role primitive when a new population shares the store.
 */
export async function listNonCrewOperators(sb: SupabaseClient): Promise<OperatorAccount[]> {
  return (await listAllRawUsers(sb))
    .filter((u) => !isCrewAccount(u.app_metadata))
    .map(toOperatorAccount)
    .sort(byNameThenEmail);
}
