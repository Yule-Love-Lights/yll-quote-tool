import { describe, it, expect } from 'vitest';
import { resolveIdentity, appendIdentifiers } from './identity';
import type { StoredContact } from './types';

function contact(over: Partial<StoredContact>): StoredContact {
  return { id: 'c1', ghlContactId: null, emails: [], phones: [], displayName: null, ...over };
}

describe('resolveIdentity — match order: ghl_contact_id → email → phone', () => {
  it('matches by ghl_contact_id first (canonical id)', () => {
    const existing = [contact({ id: 'A', ghlContactId: 'ghl-123' })];
    const r = resolveIdentity({ ghlContactId: 'ghl-123' }, existing);
    expect(r.contact?.id).toBe('A');
    expect(r.reason).toBe('ghl');
    expect(r.ambiguous).toBe(false);
  });

  it('ghl id wins even when email points at no one', () => {
    const existing = [contact({ id: 'A', ghlContactId: 'ghl-123' })];
    const r = resolveIdentity({ ghlContactId: 'ghl-123', emails: ['new@x.com'] }, existing);
    expect(r.contact?.id).toBe('A');
    expect(r.reason).toBe('ghl');
  });

  it('falls back to email (case-insensitive) when no ghl id match', () => {
    const existing = [contact({ id: 'B', emails: ['jane@example.com'] })];
    const r = resolveIdentity({ emails: ['Jane@Example.com'] }, existing);
    expect(r.contact?.id).toBe('B');
    expect(r.reason).toBe('email');
  });

  it('falls back to phone (normalized) when no ghl id and no email match', () => {
    const existing = [contact({ id: 'C', phones: ['+16315551234'] })];
    const r = resolveIdentity({ phones: ['(631) 555-1234'] }, existing);
    expect(r.contact?.id).toBe('C');
    expect(r.reason).toBe('phone');
  });

  it('returns no match for a brand-new unknown contact (GHL first-touch case)', () => {
    const existing = [contact({ id: 'Z', emails: ['other@x.com'] })];
    const r = resolveIdentity({ emails: ['new@x.com'], phones: ['+16310000000'] }, existing);
    expect(r.contact).toBeNull();
    expect(r.reason).toBeNull();
    expect(r.ambiguous).toBe(false);
  });
});

describe('resolveIdentity — never silently auto-merge ambiguous duplicates', () => {
  it('flags ambiguous when email matches one contact but phone matches a DIFFERENT one', () => {
    const existing = [
      contact({ id: 'A', emails: ['shared@x.com'] }),
      contact({ id: 'B', phones: ['+16315551234'] }),
    ];
    const r = resolveIdentity({ emails: ['shared@x.com'], phones: ['631-555-1234'] }, existing);
    expect(r.contact).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it('does NOT flag ambiguous when email + phone resolve to the SAME contact', () => {
    const existing = [contact({ id: 'A', emails: ['a@x.com'], phones: ['+16315551234'] })];
    const r = resolveIdentity({ emails: ['a@x.com'], phones: ['+16315551234'] }, existing);
    expect(r.contact?.id).toBe('A');
    expect(r.ambiguous).toBe(false);
  });

  it('flags ambiguous when one email matches two different contacts', () => {
    const existing = [
      contact({ id: 'A', emails: ['dup@x.com'] }),
      contact({ id: 'B', emails: ['dup@x.com'] }),
    ];
    const r = resolveIdentity({ emails: ['dup@x.com'] }, existing);
    expect(r.contact).toBeNull();
    expect(r.ambiguous).toBe(true);
  });
});

describe('appendIdentifiers — append-on-match, deduped + normalized', () => {
  it('unions emails + phones and fills ghl id / name when previously empty', () => {
    const existing = contact({ id: 'A', emails: ['a@x.com'], phones: ['+16315551234'] });
    const out = appendIdentifiers(existing, {
      emails: ['B@X.com'],
      phones: ['(631) 555-1234', '+16319999999'], // first dedupes to the existing one
      ghlContactId: 'ghl-7',
      displayName: 'Jane',
    });
    expect([...out.emails].sort()).toEqual(['a@x.com', 'b@x.com']);
    expect([...out.phones].sort()).toEqual(['+16315551234', '+16319999999']);
    expect(out.ghlContactId).toBe('ghl-7');
    expect(out.displayName).toBe('Jane');
  });

  it('never overwrites an existing ghl id or display name', () => {
    const existing = contact({ id: 'A', ghlContactId: 'ghl-orig', displayName: 'Orig' });
    const out = appendIdentifiers(existing, { ghlContactId: 'ghl-new', displayName: 'New' });
    expect(out.ghlContactId).toBe('ghl-orig');
    expect(out.displayName).toBe('Orig');
  });
});
