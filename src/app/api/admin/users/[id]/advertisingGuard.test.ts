import { describe, expect, it } from 'vitest';

import { isAdvertisingAccount, isCrewAccount, roleOf } from '@/lib/auth/supabaseServer';

/**
 * The privilege-escalation this guard closes, for the advertising population
 * (advertising role hardening, Naldo's 2026-08-27 ruling). Same shape as
 * crewGuard.test.ts's isCrewAccount pin — see that file for the fuller
 * narrative; this pins the ADVERTISING half.
 *
 * Advertising and operators share one auth store. `roleOf` collapses ANY
 * non-admin role — including 'advertising' — to 'operator'. So before the
 * guard in route.ts, PATCH /api/admin/users/[id] with { role: 'admin' }
 * against an ADVERTISING login would:
 *
 *   1. read currentRole via roleOf  -> 'operator'   (advertising marker invisible)
 *   2. canChangeRole('operator' -> 'admin')          passes
 *   3. app_metadata = { ...existing, role: 'admin' } OVERWRITES role:'advertising'
 *   4. isAdvertisingAccount now false, getOperator returns a real admin
 *
 * No advertising account exists yet — this pins the primitives so the
 * collapse can never be introduced silently once one does. The route guard
 * itself is a plain `if (isAdvertisingAccount(...)) return 403`.
 */
describe('why the admin-users routes must check isAdvertisingAccount', () => {
  const advertisingMeta = { role: 'advertising', name: 'Ad Agency' };

  it('roleOf CANNOT distinguish an advertising login from an operator', () => {
    // This is the whole trap. roleOf is not a safe basis for any decision that
    // must not apply to advertising.
    expect(roleOf(advertisingMeta)).toBe('operator');
    expect(roleOf({ role: 'operator' })).toBe('operator');
  });

  it('isAdvertisingAccount CAN, and is the only thing that can', () => {
    expect(isAdvertisingAccount(advertisingMeta)).toBe(true);
    expect(isAdvertisingAccount({ role: 'operator' })).toBe(false);
    expect(isAdvertisingAccount({ role: 'admin' })).toBe(false);
  });

  it('the escalation is a single spread away, which is why the guard runs FIRST', () => {
    // Reproduces step 3 exactly: the spread preserves everything EXCEPT the one
    // field that made the account safe.
    const escalated = { ...advertisingMeta, role: 'admin' };
    expect(isAdvertisingAccount(advertisingMeta)).toBe(true);
    expect(isAdvertisingAccount(escalated)).toBe(false);
    expect(roleOf(escalated)).toBe('admin');
  });

  it('an advertising account is never admin while its marker survives', () => {
    expect(roleOf(advertisingMeta)).not.toBe('admin');
    expect(isAdvertisingAccount(advertisingMeta)).toBe(true);
  });

  it('advertising and crew are separate populations — neither marker satisfies the other check', () => {
    expect(isCrewAccount(advertisingMeta)).toBe(false);
    expect(isAdvertisingAccount({ role: 'crew' })).toBe(false);
  });
});
