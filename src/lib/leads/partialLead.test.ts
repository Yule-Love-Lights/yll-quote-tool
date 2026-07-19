// Tests for syncPartialLeadToGhl — the no-drip partial-lead sync. The load-
// bearing invariant: a partial NEVER gets the 'new lead' tag (which enrolls it
// in SMS drips) — only the neutral 'partial-lead' tag, and no opportunity/note.
// The household name-guard (don't overwrite a real contact's name with a
// half-typed one) and the one-identifier (email-only / phone-only) upsert are
// covered too.
//
// highlevel is mocked; splitLeadName / existingNameDiffers (from leadService)
// run for real.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const hl = vi.hoisted(() => ({
  upsertContact: vi.fn(async (_input: unknown) => ({ contact: { id: 'contact-1' }, new: true })),
  addContactTags: vi.fn(async (_id: string, _tags: string[]) => ({})),
  searchContacts: vi.fn(async (_q: string) => [] as Array<Record<string, unknown>>),
  // leadService (imported for splitLeadName/existingNameDiffers) references
  // these at module load — provide stubs so the import doesn't dangle.
  upsertContactCustomField: vi.fn(),
  createContactNote: vi.fn(),
  findOrCreateOpportunityForContact: vi.fn(),
}));

vi.mock('@/lib/integrations/highlevel', () => hl);

import { syncPartialLeadToGhl } from './partialLead';

beforeEach(() => {
  vi.clearAllMocks();
  hl.upsertContact.mockResolvedValue({ contact: { id: 'contact-1' }, new: true });
  hl.addContactTags.mockResolvedValue({});
  hl.searchContacts.mockResolvedValue([]);
});

describe('syncPartialLeadToGhl', () => {
  it('upserts the contact and adds ONLY the partial-lead tag (never new lead / a drip tag)', async () => {
    const res = await syncPartialLeadToGhl({
      name: 'Jane Smith',
      email: 'jane@example.com',
      phone: '+16315550100',
    });
    expect(res).toEqual({ status: 'synced', ghlContactId: 'contact-1' });
    expect(hl.upsertContact).toHaveBeenCalledTimes(1);
    const upsertArg = hl.upsertContact.mock.calls[0]![0] as Record<string, unknown>;
    expect(upsertArg.firstName).toBe('Jane');
    expect(upsertArg.lastName).toBe('Smith');
    expect(upsertArg.email).toBe('jane@example.com');
    // exactly one tag call, exactly the neutral tag
    expect(hl.addContactTags).toHaveBeenCalledTimes(1);
    expect(hl.addContactTags).toHaveBeenCalledWith('contact-1', ['partial-lead']);
    const allTags = hl.addContactTags.mock.calls.flatMap((c) => c[1] as string[]);
    expect(allTags).not.toContain('new lead');
  });

  it('never creates an opportunity or a note (no drip-adjacent side effects)', async () => {
    await syncPartialLeadToGhl({ name: 'Jane', email: 'jane@example.com', phone: '5551234567' });
    expect(hl.findOrCreateOpportunityForContact).not.toHaveBeenCalled();
    expect(hl.createContactNote).not.toHaveBeenCalled();
  });

  it('omits name fields when an existing contact has a DIFFERENT name (household guard)', async () => {
    hl.searchContacts.mockResolvedValue([
      { id: 'c-existing', fullName: 'Bob Jones', email: 'shared@example.com', phone: '' },
    ]);
    await syncPartialLeadToGhl({ name: 'Alice Jones', email: 'shared@example.com', phone: '5551234567' });
    const upsertArg = hl.upsertContact.mock.calls[0]![0] as Record<string, unknown>;
    expect(upsertArg.firstName).toBeUndefined();
    expect(upsertArg.lastName).toBeUndefined();
    expect(upsertArg.email).toBe('shared@example.com');
  });

  it('supports an email-only partial (no phone key sent)', async () => {
    await syncPartialLeadToGhl({ name: 'Jane', email: 'jane@example.com', phone: null });
    const upsertArg = hl.upsertContact.mock.calls[0]![0] as Record<string, unknown>;
    expect(upsertArg.email).toBe('jane@example.com');
    expect(upsertArg.phone).toBeUndefined();
  });

  it('supports a phone-only partial with no name (no name/email keys sent)', async () => {
    await syncPartialLeadToGhl({ name: null, email: null, phone: '+16315550100' });
    const upsertArg = hl.upsertContact.mock.calls[0]![0] as Record<string, unknown>;
    expect(upsertArg.phone).toBe('+16315550100');
    expect(upsertArg.email).toBeUndefined();
    expect(upsertArg.firstName).toBeUndefined();
  });

  it('returns status error (with the contact id) when tagging fails — the contact is not lost', async () => {
    hl.addContactTags.mockRejectedValue(new Error('tag boom'));
    const res = await syncPartialLeadToGhl({ name: 'Jane', email: 'jane@example.com', phone: '5551234567' });
    expect(res.status).toBe('error');
    expect(res.ghlContactId).toBe('contact-1');
    expect(res.syncError).toContain('tag boom');
  });

  it('propagates an upsert throw (no contact yet — the route keeps the row for retry)', async () => {
    hl.upsertContact.mockRejectedValue(new Error('upsert boom'));
    await expect(
      syncPartialLeadToGhl({ name: 'Jane', email: 'jane@example.com', phone: '5551234567' }),
    ).rejects.toThrow('upsert boom');
    expect(hl.addContactTags).not.toHaveBeenCalled();
  });

  it('fails open when the household search throws (still sends the name)', async () => {
    hl.searchContacts.mockRejectedValue(new Error('search down'));
    await syncPartialLeadToGhl({ name: 'Jane Smith', email: 'jane@example.com', phone: '5551234567' });
    const upsertArg = hl.upsertContact.mock.calls[0]![0] as Record<string, unknown>;
    expect(upsertArg.firstName).toBe('Jane');
  });
});
