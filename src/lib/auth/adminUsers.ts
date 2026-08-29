// Admin user-management data layer (ledger #81 Slice 3). Wraps the Supabase
// service-role admin API (auth.admin.*) into the small shape the operator
// accounts UI needs, plus the pure countAdmins() that feeds the last-admin guard.

import type { SupabaseClient } from '@supabase/supabase-js';
import { roleOf, nameOf, isCrewAccount, isAdvertisingAccount, type OperatorRole } from './supabaseServer';

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

/**
 * Map a Supabase auth user to the public account shape (role derived safely).
 *
 * ⚠️ `roleOf` flattens EVERY non-admin role to 'operator' — crew already relies
 * on being excluded upstream (see `listNonCrewOperators` below) rather than
 * labeled here, and the same is true for advertising: `isAdvertisingAccount`
 * is not consulted in this function, so the day an advertising login exists,
 * it will display here as an unlabeled 'operator' in Settings → Accounts, same
 * as every other display surface built on this shape. Whoever builds the
 * advertising creation door must add explicit labeling wherever this shape
 * reaches the UI — `listAllAccountsById`'s `isCrew` field (adding an
 * `isAdvertising` field the same way) is the precedent to copy, not a rename
 * of this function.
 */
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
/**
 * Every auth account keyed by id, crew logins INCLUDED, for surfaces that must
 * show a login's email whatever population it belongs to.
 *
 * `isCrew` is carried explicitly because `roleOf` flattens 'crew' to 'operator',
 * so the returned `role` alone cannot tell the two apart. Callers that must not
 * offer a crew login (the office picker) use `listNonCrewOperators` instead;
 * this one is for display and for resolving a linked login.
 */
export async function listAllAccountsById(
  sb: SupabaseClient,
): Promise<Map<string, OperatorAccount & { isCrew: boolean }>> {
  const rows = await listAllRawUsers(sb);
  return new Map(
    rows.map((u) => [u.id, { ...toOperatorAccount(u), isCrew: isCrewAccount(u.app_metadata) }]),
  );
}

/**
 * ⚠️ RULE FOR THE NEXT SHARED-STORE POPULATION: this filter must exclude every
 * population that is not a real operator, checked on the RAW app_metadata
 * before `roleOf`/`toOperatorAccount` flattens it. Crew and advertising are
 * excluded here for that reason (advertising role hardening, 2026-08-27) —
 * without this, an advertising login would be offered as an "eligible
 * operator" in the Staff panel's office-onboarding picker and could be linked
 * to a crew_members pay row exactly like a real operator. The next population
 * added to this store needs the same line added here.
 */
export async function listNonCrewOperators(sb: SupabaseClient): Promise<OperatorAccount[]> {
  return (await listAllRawUsers(sb))
    .filter((u) => !isCrewAccount(u.app_metadata) && !isAdvertisingAccount(u.app_metadata))
    .map(toOperatorAccount)
    .sort(byNameThenEmail);
}

/**
 * Case-insensitive email match against an already-fetched operator list.
 * PURE (no Supabase call) so the matching logic itself — case folding, no
 * match, an empty/null query — is testable without mocking listUsers.
 * Split out from findOperatorByEmail below so a caller that already has the
 * population in hand (e.g. matching many rep emails in one batch) doesn't
 * refetch it per lookup.
 */
export function matchOperatorByEmail(operators: OperatorAccount[], email: string | null): OperatorAccount | null {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return null;
  return operators.find((o) => o.email?.toLowerCase() === normalized) ?? null;
}

/**
 * Maps a rep's email (resolved from GHL, see src/lib/calls/pipeline.ts) to a
 * real operator account, for office_tasks.assigned_to
 * (calls_merge_plan_2026-08.md slice S6, rep-assignment ruling). Matches
 * against listNonCrewOperators — crew and advertising logins are excluded
 * for the same reason the office-onboarding picker excludes them (a rep's
 * email should never auto-assign a customer-facing crew/advertising account
 * an internal admin task just because the addresses happen to collide).
 * null on no match — never throws for a miss, only for a genuine Supabase
 * error (matching the caller's own single-lookup shape; a caller matching
 * MANY emails in one batch should call listNonCrewOperators once and reuse
 * matchOperatorByEmail directly instead of calling this per email).
 */
export async function findOperatorByEmail(sb: SupabaseClient, email: string | null): Promise<OperatorAccount | null> {
  if (!email?.trim()) return null;
  return matchOperatorByEmail(await listNonCrewOperators(sb), email);
}
