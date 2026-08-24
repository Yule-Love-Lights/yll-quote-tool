import { roleOf } from '@/lib/auth/supabaseServer';

/**
 * Guards for creating a CREW login (row 279's shared-login store).
 *
 * Deliberately separate from `validateNewUser` in accountGuards.ts rather than
 * loosening it. That guard protects the OPERATOR surface and hard-rejects any
 * role outside admin/operator — which is exactly why it should keep doing so.
 * Widening it to accept 'crew' would mean one validator standing between two
 * populations with very different privileges, and a mistake there hands crew the
 * operator surface. Two doors, two guards.
 */

export type CrewAccountInput = {
  crewMemberId: string;
  email: string;
  password: string;
};

export type GuardResult = { ok: true } | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The credential half of the guard, on its own.
 *
 * Split out because the unified Staff panel creates the pay row and the login in
 * one step, so there is no existing crew member id to validate at that point.
 * `validateCrewAccount` still calls this and then adds the id check, so the
 * existing door's behavior is unchanged.
 */
export function validateCrewCredentials(input: { email: string; password: string }): GuardResult {
  const email = (input.email ?? '').trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: 'A valid email is required' };
  }
  if (typeof input.password !== 'string' || input.password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters' };
  }
  return { ok: true };
}

export function validateCrewAccount(input: CrewAccountInput): GuardResult {
  const credentials = validateCrewCredentials(input);
  if (!credentials.ok) return credentials;
  if (!UUID_RE.test((input.crewMemberId ?? '').trim())) {
    return { ok: false, error: 'A crew member must be selected' };
  }
  return { ok: true };
}

/**
 * The app_metadata written onto a crew login. `role: 'crew'` is the single fact
 * the whole separation rests on: `isCrewAccount` reads it, `getOperator` returns
 * null because of it, and the role-aware proxy confines the session because of
 * it. app_metadata is service-role-only, so a crew member cannot edit their way
 * out of it.
 */
export function crewAppMetadata(displayName: string): { role: 'crew'; name: string } {
  return { role: 'crew', name: displayName };
}

/**
 * Sanity check that the metadata we are about to write really does read as crew
 * and NOT as an operator. Cheap, and it fails loudly if someone later edits
 * crewAppMetadata into something roleOf would wave through.
 */
export function crewMetadataIsSafe(meta: unknown): boolean {
  const role = (meta as { role?: unknown } | null)?.role;
  // roleOf collapses everything non-admin to 'operator', so the ONLY thing that
  // makes this safe is the literal 'crew' marker isCrewAccount looks for.
  return role === 'crew' && roleOf(meta) === 'operator';
}
