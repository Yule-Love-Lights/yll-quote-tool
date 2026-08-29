import { describe, it, expect } from 'vitest';
import { crewAppMetadata } from './crewAccounts';
import { isCrewAccount, roleOf } from './supabaseServer';

/**
 * Crew logins are retired (row 438) and nothing mints one any more. These tests
 * are NOT vestigial: they pin the reason the crew MARKER still has to be
 * recognised. If `roleOf` alone decided access, a crew account would read as an
 * operator, so the guards that refuse one must keep keying off `isCrewAccount`.
 */
describe('the crew marker, after crew logins were retired', () => {
  it('is still a distinct role, not an operator one', () => {
    expect(crewAppMetadata('SonSon')).toEqual({ role: 'crew', name: 'SonSon' });
    expect(isCrewAccount(crewAppMetadata('SonSon'))).toBe(true);
  });

  it('WOULD read as an operator if anything trusted roleOf alone — the reason the guards stay', () => {
    // This is the escalation in AGENTS.md: roleOf collapses every non-admin role
    // to 'operator'. isCrewAccount is the only thing that separates them, which
    // is why getOperator and the proxy both check it rather than roleOf.
    expect(roleOf(crewAppMetadata('SonSon'))).toBe('operator');
    expect(roleOf(crewAppMetadata('SonSon'))).not.toBe('admin');
  });
});
