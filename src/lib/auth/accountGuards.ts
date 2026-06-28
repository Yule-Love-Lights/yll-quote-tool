// Pure account-management guards (ledger #81 Slice 3). No I/O — the route
// handlers fetch the current state (caller, target role, admin count) and pass
// it here, so the dangerous decisions (self-delete, last-admin, self-role-change)
// are unit-testable in isolation, away from the Supabase admin API.

import type { OperatorRole } from './supabaseServer';

type Result = { ok: true } | { ok: false; error: string };
const OK: Result = { ok: true };
const fail = (error: string): Result => ({ ok: false, error });

const ROLES: readonly OperatorRole[] = ['admin', 'operator'];

/** Validate the fields for a newly-created operator account. */
export function validateNewUser(input: { email: string; password: string; role: string }): Result {
  const email = input.email.trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('A valid email is required');
  if (typeof input.password !== 'string' || input.password.length < 8) {
    return fail('Password must be at least 8 characters');
  }
  if (!ROLES.includes(input.role as OperatorRole)) return fail("Role must be 'admin' or 'operator'");
  return OK;
}

/** Whether the caller may delete the target account. */
export function canDeleteUser(input: {
  callerId: string;
  targetId: string;
  targetRole: OperatorRole;
  adminCount: number;
}): Result {
  if (input.callerId === input.targetId) return fail('You cannot delete your own account');
  if (input.targetRole === 'admin' && input.adminCount <= 1) {
    return fail('Cannot delete the last admin');
  }
  return OK;
}

/** Whether the caller may change the target's role to newRole. */
export function canChangeRole(input: {
  callerId: string;
  targetId: string;
  currentRole: OperatorRole;
  newRole: OperatorRole;
  adminCount: number;
}): Result {
  if (input.newRole === input.currentRole) return OK; // no-op
  // An operator may never edit their OWN role — prevents self-lockout and
  // self-promotion (first admin is seeded out-of-band via the service role).
  if (input.callerId === input.targetId) return fail('You cannot change your own role');
  if (input.currentRole === 'admin' && input.newRole !== 'admin' && input.adminCount <= 1) {
    return fail('Cannot demote the last admin');
  }
  return OK;
}
