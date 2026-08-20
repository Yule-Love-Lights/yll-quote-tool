import { describe, expect, it } from 'vitest';

import { isCrewAccount, roleOf } from '@/lib/auth/supabaseServer';
import { crewAppMetadata } from '@/lib/auth/crewAccounts';

/**
 * The privilege-escalation this guard closes (S58 wrap review, security lens).
 *
 * Crew and operators share one auth store. `roleOf` collapses ANY non-admin role
 * — including 'crew' — to 'operator'. So before the guard, PATCH
 * /api/admin/users/[id] with { role: 'admin' } against a CREW login:
 *
 *   1. read currentRole via roleOf  -> 'operator'   (crew marker invisible)
 *   2. canChangeRole('operator' -> 'admin')          passes
 *   3. app_metadata = { ...existing, role: 'admin' } OVERWRITES role:'crew'
 *   4. isCrewAccount now false, getOperator returns a real admin
 *
 * The crew member's login becomes a full admin with access to /customers and
 * every PII surface, while crew_members.auth_user_id still points at it as their
 * pay identity.
 *
 * These tests pin the PRIMITIVES that made it possible, so the collapse can
 * never be reintroduced silently. The route guard itself is a plain
 * `if (isCrewAccount(...)) return 403`.
 */
describe('why the admin-users routes must check isCrewAccount', () => {
  const crewMeta = crewAppMetadata('SonSon');

  it('roleOf CANNOT distinguish a crew login from an operator', () => {
    // This is the whole trap. roleOf is not a safe basis for any decision that
    // must not apply to crew.
    expect(roleOf(crewMeta)).toBe('operator');
    expect(roleOf({ role: 'operator' })).toBe('operator');
  });

  it('isCrewAccount CAN, and is the only thing that can', () => {
    expect(isCrewAccount(crewMeta)).toBe(true);
    expect(isCrewAccount({ role: 'operator' })).toBe(false);
    expect(isCrewAccount({ role: 'admin' })).toBe(false);
  });

  it('the escalation is a single spread away, which is why the guard runs FIRST', () => {
    // Reproduces step 3 exactly: the spread preserves everything EXCEPT the one
    // field that made the account safe.
    const escalated = { ...crewMeta, role: 'admin' };
    expect(isCrewAccount(crewMeta)).toBe(true);
    expect(isCrewAccount(escalated)).toBe(false);
    expect(roleOf(escalated)).toBe('admin');
  });

  it('a crew account is never admin while its marker survives', () => {
    expect(roleOf(crewMeta)).not.toBe('admin');
    expect(isCrewAccount(crewMeta)).toBe(true);
  });
});
