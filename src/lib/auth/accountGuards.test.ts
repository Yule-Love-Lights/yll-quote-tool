import { describe, it, expect } from 'vitest';
import { validateNewUser, canDeleteUser, canChangeRole } from './accountGuards';

describe('validateNewUser', () => {
  it('accepts a well-formed admin or operator', () => {
    expect(validateNewUser({ email: 'a@x.com', password: 'longenough', role: 'admin', name: 'Ada' }).ok).toBe(true);
    expect(validateNewUser({ email: 'b@x.com', password: '12345678', role: 'operator', name: 'Bob' }).ok).toBe(true);
  });

  it('rejects a bad email', () => {
    expect(validateNewUser({ email: 'nope', password: 'longenough', role: 'operator', name: 'Bob' }).ok).toBe(false);
    expect(validateNewUser({ email: '', password: 'longenough', role: 'operator', name: 'Bob' }).ok).toBe(false);
  });

  it('rejects a short password (< 8 chars)', () => {
    expect(validateNewUser({ email: 'a@x.com', password: 'short', role: 'operator', name: 'Bob' }).ok).toBe(false);
  });

  it('rejects an unknown role', () => {
    expect(validateNewUser({ email: 'a@x.com', password: 'longenough', role: 'superuser', name: 'Bob' }).ok).toBe(false);
  });

  // Advertising role hardening (Naldo's 2026-08-27 ruling): advertising is a
  // SEPARATE population carved out by its own marker (ADVERTISING_ROLE /
  // isAdvertisingAccount in supabaseServer.ts), never a third OperatorRole
  // value. This door creates operator accounts ONLY — ROLES here is still
  // exactly ['admin', 'operator'] (unmodified), so 'advertising' already fails
  // the same way 'crew' does. This test pins that this door can never become a
  // route to creating an advertising (or crew) account by accident.
  it("rejects 'advertising' — this door creates operator accounts only, never advertising or crew", () => {
    expect(validateNewUser({ email: 'a@x.com', password: 'longenough', role: 'advertising', name: 'Ad Agency' }).ok).toBe(false);
  });

  it('rejects a missing/blank name (required on create)', () => {
    expect(validateNewUser({ email: 'a@x.com', password: 'longenough', role: 'operator', name: '' }).ok).toBe(false);
    expect(validateNewUser({ email: 'a@x.com', password: 'longenough', role: 'operator', name: '   ' }).ok).toBe(false);
  });

  it('accepts a name with surrounding whitespace (trimmed by the caller)', () => {
    expect(validateNewUser({ email: 'a@x.com', password: 'longenough', role: 'operator', name: '  Jane  ' }).ok).toBe(true);
  });

  it('rejects a name longer than 80 chars', () => {
    expect(validateNewUser({ email: 'a@x.com', password: 'longenough', role: 'operator', name: 'x'.repeat(81) }).ok).toBe(false);
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
