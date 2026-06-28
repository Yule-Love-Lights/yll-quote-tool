import { describe, it, expect } from 'vitest';
import { validateNewUser, canDeleteUser, canChangeRole } from './accountGuards';

describe('validateNewUser', () => {
  it('accepts a well-formed admin or operator', () => {
    expect(validateNewUser({ email: 'a@x.com', password: 'longenough', role: 'admin' }).ok).toBe(true);
    expect(validateNewUser({ email: 'b@x.com', password: '12345678', role: 'operator' }).ok).toBe(true);
  });

  it('rejects a bad email', () => {
    expect(validateNewUser({ email: 'nope', password: 'longenough', role: 'operator' }).ok).toBe(false);
    expect(validateNewUser({ email: '', password: 'longenough', role: 'operator' }).ok).toBe(false);
  });

  it('rejects a short password (< 8 chars)', () => {
    expect(validateNewUser({ email: 'a@x.com', password: 'short', role: 'operator' }).ok).toBe(false);
  });

  it('rejects an unknown role', () => {
    expect(validateNewUser({ email: 'a@x.com', password: 'longenough', role: 'superuser' }).ok).toBe(false);
  });
});

describe('canDeleteUser', () => {
  it('allows deleting another non-admin', () => {
    expect(canDeleteUser({ callerId: 'me', targetId: 'them', targetRole: 'operator', adminCount: 1 }).ok).toBe(true);
  });

  it('allows deleting another admin when more than one admin exists', () => {
    expect(canDeleteUser({ callerId: 'me', targetId: 'them', targetRole: 'admin', adminCount: 2 }).ok).toBe(true);
  });

  it('refuses self-deletion', () => {
    const r = canDeleteUser({ callerId: 'me', targetId: 'me', targetRole: 'admin', adminCount: 2 });
    expect(r.ok).toBe(false);
  });

  it('refuses deleting the last admin', () => {
    const r = canDeleteUser({ callerId: 'me', targetId: 'them', targetRole: 'admin', adminCount: 1 });
    expect(r.ok).toBe(false);
  });
});

describe('canChangeRole', () => {
  it('allows promoting/demoting another user when not the last admin', () => {
    expect(canChangeRole({ callerId: 'me', targetId: 'them', currentRole: 'operator', newRole: 'admin', adminCount: 1 }).ok).toBe(true);
    expect(canChangeRole({ callerId: 'me', targetId: 'them', currentRole: 'admin', newRole: 'operator', adminCount: 2 }).ok).toBe(true);
  });

  it('refuses changing your own role (self-lockout prevention)', () => {
    const r = canChangeRole({ callerId: 'me', targetId: 'me', currentRole: 'admin', newRole: 'operator', adminCount: 3 });
    expect(r.ok).toBe(false);
  });

  it('refuses demoting the last admin', () => {
    const r = canChangeRole({ callerId: 'me', targetId: 'them', currentRole: 'admin', newRole: 'operator', adminCount: 1 });
    expect(r.ok).toBe(false);
  });

  it('is a no-op-safe allow when the role is unchanged', () => {
    expect(canChangeRole({ callerId: 'me', targetId: 'them', currentRole: 'operator', newRole: 'operator', adminCount: 1 }).ok).toBe(true);
  });
});
