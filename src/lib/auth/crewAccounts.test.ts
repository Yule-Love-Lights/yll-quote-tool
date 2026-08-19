import { describe, expect, it } from 'vitest';

import { crewAppMetadata, crewMetadataIsSafe, validateCrewAccount } from './crewAccounts';
import { isCrewAccount, roleOf } from './supabaseServer';
import { validateNewUser } from './accountGuards';

const OK_INPUT = {
  crewMemberId: '11111111-2222-3333-4444-555555555555',
  email: 'sonson@example.com',
  password: 'a-good-password',
};

describe('validateCrewAccount', () => {
  it('accepts a well-formed crew account', () => {
    expect(validateCrewAccount(OK_INPUT)).toEqual({ ok: true });
  });

  it('requires a real email', () => {
    expect(validateCrewAccount({ ...OK_INPUT, email: 'nope' }).ok).toBe(false);
    expect(validateCrewAccount({ ...OK_INPUT, email: '' }).ok).toBe(false);
  });

  it('requires a password of at least 8 characters', () => {
    expect(validateCrewAccount({ ...OK_INPUT, password: 'short' }).ok).toBe(false);
  });

  it('requires a crew member uuid, so a login cannot be created unattached', () => {
    expect(validateCrewAccount({ ...OK_INPUT, crewMemberId: '' }).ok).toBe(false);
    expect(validateCrewAccount({ ...OK_INPUT, crewMemberId: 'not-a-uuid' }).ok).toBe(false);
  });
});

describe('crew metadata is what the whole separation rests on', () => {
  it('marks the account with the literal crew role', () => {
    expect(crewAppMetadata('SonSon')).toEqual({ role: 'crew', name: 'SonSon' });
  });

  it('produces metadata that isCrewAccount recognises', () => {
    expect(isCrewAccount(crewAppMetadata('SonSon'))).toBe(true);
  });

  it('crewMetadataIsSafe rejects anything that would read as an operator', () => {
    expect(crewMetadataIsSafe(crewAppMetadata('SonSon'))).toBe(true);
    // The failure mode it guards: metadata that roleOf waves through and
    // isCrewAccount does not catch, i.e. a login with the operator surface.
    expect(crewMetadataIsSafe({ role: 'operator', name: 'X' })).toBe(false);
    expect(crewMetadataIsSafe({ role: 'admin', name: 'X' })).toBe(false);
    expect(crewMetadataIsSafe({ name: 'X' })).toBe(false);
    expect(crewMetadataIsSafe(null)).toBe(false);
  });

  it('a crew account is never admin, however roleOf collapses it', () => {
    // roleOf still says 'operator' for crew metadata — that is exactly why
    // getOperator has to check isCrewAccount rather than trusting roleOf.
    expect(roleOf(crewAppMetadata('SonSon'))).toBe('operator');
    expect(roleOf(crewAppMetadata('SonSon'))).not.toBe('admin');
    expect(isCrewAccount(crewAppMetadata('SonSon'))).toBe(true);
  });
});

describe('the two doors stay separate', () => {
  it("the OPERATOR guard still refuses 'crew', and must keep refusing it", () => {
    // If this ever starts passing, one validator is standing between two
    // populations with different privileges — the thing crewAccounts.ts exists
    // to avoid.
    const result = validateNewUser({
      email: 'x@example.com',
      password: 'a-good-password',
      role: 'crew',
      name: 'SonSon',
    });
    expect(result.ok).toBe(false);
  });
});
