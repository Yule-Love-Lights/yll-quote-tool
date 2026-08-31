import { describe, it, expect } from 'vitest';
import { displayName, initials, roleLabel } from './accountIdentity';

describe('displayName', () => {
  it('prefers the real name', () => {
    expect(displayName({ name: 'Naldo Vengeance', email: 'n@example.com', role: 'admin' })).toBe(
      'Naldo Vengeance',
    );
  });

  it('falls back to the email when there is no name', () => {
    expect(displayName({ name: null, email: 'n@example.com', role: 'operator' })).toBe(
      'n@example.com',
    );
    expect(displayName({ name: '   ', email: 'n@example.com', role: 'operator' })).toBe(
      'n@example.com',
    );
  });

  it('never returns an empty string, which would name nobody on screen', () => {
    expect(displayName({ name: null, email: null, role: null })).toBe('Signed in');
    expect(displayName({ name: '', email: '', role: null })).toBe('Signed in');
  });
});

describe('initials', () => {
  it('takes the first and last word of a full name', () => {
    expect(initials({ name: 'Naldo Vengeance', email: null, role: null })).toBe('NV');
    expect(initials({ name: 'Mary Jane Watson', email: null, role: null })).toBe('MW');
  });

  it('takes two letters from a single-word name', () => {
    expect(initials({ name: 'Jason', email: null, role: null })).toBe('JA');
  });

  it('falls back to the email, then to a neutral marker', () => {
    expect(initials({ name: null, email: 'ops@example.com', role: null })).toBe('OP');
    expect(initials({ name: null, email: null, role: null })).toBe('··');
  });
});

describe('roleLabel', () => {
  it('spells the role the way a person would say it', () => {
    expect(roleLabel('admin')).toBe('Admin');
    expect(roleLabel('operator')).toBe('Operator');
  });

  it('says nothing before the role resolves', () => {
    expect(roleLabel(null)).toBeNull();
  });
});
