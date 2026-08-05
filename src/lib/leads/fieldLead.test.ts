// Tests for syncFieldLeadToGhl — the captureLead GHL sync (Phase 3 of the
// 2026-07-19 text-ops plan). The load-bearing invariant is the OPPOSITE of
// partialLead.test.ts: THIS sync must add 'new lead' (the bot's confirm-yes
// gate already captured consent), alongside 'field-lead' + 'sms-consent' +
// the service tag, a note, and NO opportunity. The household name-guard and
// phone-only shape mirror partialLead.ts.
//
// highlevel is mocked; splitLeadName / existingNameDiffers / normalizePhoneForCompare
// / SERVICE_FIELD_VALUE (from leadService) run for real.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const hl = vi.hoisted(() => ({
  upsertContact: vi.fn(async (_input: unknown) => ({ contact: { id: 'contact-1' }, new: true })),
  addContactTags: vi.fn(async (_id: string, _tags: string[]) => ({})),
  createContactNote: vi.fn(async (_id: string, _body: string) => ({ id: 'note-1' })),
  searchContacts: vi.fn(async (_q: string) => [] as Array<Record<string, unknown>>),
  // leadService (imported for splitLeadName/existingNameDiffers/SERVICE_FIELD_VALUE)
  // references these at module load — provide stubs so the import doesn't dangle.
  upsertContactCustomField: vi.fn(),
  findOrCreateOpportunityForContact: vi.fn(),
}));

vi.mock('@/lib/integrations/highlevel', () => hl);

import { syncFieldLeadToGhl } from './fieldLead';

beforeEach(() => {
  vi.clearAllMocks();
  hl.upsertContact.mockResolvedValue({ contact: { id: 'contact-1' }, new: true });
  hl.addContactTags.mockResolvedValue({});
  hl.createContactNote.mockResolvedValue({ id: 'note-1' });
  hl.searchContacts.mockResolvedValue([]);
});

describe('syncFieldLeadToGhl', () => {
  it('upserts the contact (phone-only — no email field exists on a field lead)', async () => {
    const res = await syncFieldLeadToGhl({
      name: 'John Smith',
      phone: '6315550100',
      address: '12 Oak St',
      service: 'permanent',
    });
    expect(res).toEqual({ status: 'synced', ghlContactId: 'contact-1' });
    expect(hl.upsertContact).toHaveBeenCalledTimes(1);
    const upsertArg = hl.upsertContact.mock.calls[0]![0] as Record<string, unknown>;
    expect(upsertArg.firstName).toBe('John');
    expect(upsertArg.lastName).toBe('Smith');
    expect(upsertArg.phone).toBe('6315550100');
    expect(upsertArg.address1).toBe('12 Oak St');
    expect(upsertArg).not.toHaveProperty('email');
  });

  it('adds EXACTLY the 4 drip tags, including new lead (the whole point — consent was confirmed)', async () => {
    await syncFieldLeadToGhl({ name: 'John Smith', phone: '6315550100', service: 'permanent' });
    expect(hl.addContactTags).toHaveBeenCalledTimes(1);
    expect(hl.addContactTags).toHaveBeenCalledWith('contact-1', [
      'new lead',
      'field-lead',
      'sms-consent',
      'web-lead-permanent',
    ]);
  });

  it.each([
    ['christmas'],
    ['permanent'],
    ['event-wedding'],
    ['landscape'],
  ] as const)('stamps web-lead-%s for that service', async (service) => {
    await syncFieldLeadToGhl({ name: 'John Smith', phone: '6315550100', service });
    const tags = hl.addContactTags.mock.calls[0]![1] as string[];
    expect(tags).toContain(`web-lead-${service}`);
  });

  it('creates a note (unlike partialLead, which never notes)', async () => {
    await syncFieldLeadToGhl({
      name: 'John Smith',
      phone: '6315550100',
      service: 'permanent',
      note: 'met at the fence, wants uplighting too',
    });
    expect(hl.createContactNote).toHaveBeenCalledTimes(1);
    const [contactId, body] = hl.createContactNote.mock.calls[0]!;
    expect(contactId).toBe('contact-1');
    expect(body).toContain('field lead');
    expect(body).toContain('met at the fence, wants uplighting too');
  });

  it('still creates a note when no free-text note was given', async () => {
    await syncFieldLeadToGhl({ name: 'John Smith', phone: '6315550100', service: 'christmas' });
    expect(hl.createContactNote).toHaveBeenCalledTimes(1);
  });

  it('never creates an opportunity (tag-for-automation, not a pipeline card)', async () => {
    await syncFieldLeadToGhl({ name: 'John Smith', phone: '6315550100', service: 'permanent' });
    expect(hl.findOrCreateOpportunityForContact).not.toHaveBeenCalled();
  });

  it('omits name fields when an existing contact has a DIFFERENT name (household guard)', async () => {
    hl.searchContacts.mockResolvedValue([
      { id: 'c-existing', fullName: 'Bob Jones', phone: '+16315550100' },
    ]);
    await syncFieldLeadToGhl({ name: 'Alice Jones', phone: '6315550100', service: 'permanent' });
    const upsertArg = hl.upsertContact.mock.calls[0]![0] as Record<string, unknown>;
    expect(upsertArg.firstName).toBeUndefined();
    expect(upsertArg.lastName).toBeUndefined();
    expect(upsertArg.phone).toBe('6315550100');
  });

  it('on a household mismatch: still enrolls (synced), reports the SAVED name, and leaves a discrepancy note', async () => {
    hl.searchContacts.mockResolvedValue([
      { id: 'c-existing', fullName: 'Bob Jones', phone: '+16315550100' },
    ]);
    const res = await syncFieldLeadToGhl({ name: 'Alice Jones', phone: '6315550100', service: 'permanent' });

    // Still enrolled — tags land regardless of the name-overwrite guard.
    expect(res.status).toBe('synced');
    expect(res.ghlContactId).toBe('contact-1');
    expect(hl.addContactTags).toHaveBeenCalledWith('contact-1', [
      'new lead',
      'field-lead',
      'sms-consent',
      'web-lead-permanent',
    ]);

    // The caller needs the EXISTING name to be honest with the crew — never
    // silently claim "Alice Jones" was saved when it wasn't.
    expect(res.savedContactName).toBe('Bob Jones');

    // Two notes: the household discrepancy trace FIRST, then the regular
    // field-lead context note — mirrors leadService.ts's ordering.
    expect(hl.createContactNote).toHaveBeenCalledTimes(2);
    const householdBody = hl.createContactNote.mock.calls[0]![1] as string;
    expect(householdBody).toContain('Alice Jones');
    expect(householdBody).toContain('Bob Jones');
    expect(householdBody).toContain('6315550100');
    const regularBody = hl.createContactNote.mock.calls[1]![1] as string;
    expect(regularBody).toContain('field lead');
  });

  it('does NOT set savedContactName or write a household note when there is no mismatch', async () => {
    const res = await syncFieldLeadToGhl({ name: 'John Smith', phone: '6315550100', service: 'permanent' });
    expect(res.savedContactName).toBeUndefined();
    expect(hl.createContactNote).toHaveBeenCalledTimes(1); // the regular note only
  });

  it('still sends name fields when the phone matches nobody', async () => {
    hl.searchContacts.mockResolvedValue([]);
    await syncFieldLeadToGhl({ name: 'Alice Jones', phone: '6315559999', service: 'permanent' });
    const upsertArg = hl.upsertContact.mock.calls[0]![0] as Record<string, unknown>;
    expect(upsertArg.firstName).toBe('Alice');
    expect(upsertArg.lastName).toBe('Jones');
  });

  it('supports phone-only with no address/note (only phone + name keys sent)', async () => {
    await syncFieldLeadToGhl({ name: 'John Smith', phone: '6315550100', service: 'landscape' });
    const upsertArg = hl.upsertContact.mock.calls[0]![0] as Record<string, unknown>;
    expect(upsertArg.phone).toBe('6315550100');
    expect(upsertArg.address1).toBeUndefined();
  });

  it('returns status error (with the contact id) when tagging fails — the contact is not lost', async () => {
    hl.addContactTags.mockRejectedValue(new Error('tag boom'));
    const res = await syncFieldLeadToGhl({ name: 'John Smith', phone: '6315550100', service: 'permanent' });
    expect(res.status).toBe('error');
    expect(res.ghlContactId).toBe('contact-1');
    expect(res.syncError).toContain('tag boom');
  });

  it('still returns status synced when only the note fails — the contact IS enrolled once tags land', async () => {
    hl.createContactNote.mockRejectedValue(new Error('note boom'));
    const res = await syncFieldLeadToGhl({ name: 'John Smith', phone: '6315550100', service: 'permanent' });
    expect(res.status).toBe('synced');
    expect(res.ghlContactId).toBe('contact-1');
    // Tags are the enrollment-critical step and already succeeded (this test
    // never touches hl.addContactTags) — a note hiccup must not hide that.
    expect(hl.addContactTags).toHaveBeenCalledTimes(1);
  });

  it('propagates an upsert throw (no contact yet)', async () => {
    hl.upsertContact.mockRejectedValue(new Error('upsert boom'));
    await expect(
      syncFieldLeadToGhl({ name: 'John Smith', phone: '6315550100', service: 'permanent' }),
    ).rejects.toThrow('upsert boom');
    expect(hl.addContactTags).not.toHaveBeenCalled();
  });

  it('fails open when the household search throws (still sends the name)', async () => {
    hl.searchContacts.mockRejectedValue(new Error('search down'));
    await syncFieldLeadToGhl({ name: 'John Smith', phone: '6315550100', service: 'permanent' });
    const upsertArg = hl.upsertContact.mock.calls[0]![0] as Record<string, unknown>;
    expect(upsertArg.firstName).toBe('John');
  });

  it('strips newlines WITHIN the note field (injection guard, mirrors buildLeadNoteBody)', async () => {
    // The header + note are legitimately two lines (like buildLeadNoteBody);
    // what must NOT happen is a crew-typed note value injecting an extra
    // line of its own via an embedded \n.
    await syncFieldLeadToGhl({
      name: 'John Smith',
      phone: '6315550100',
      service: 'permanent',
      note: 'line one\nFAKE STATUS: approved',
    });
    const body = hl.createContactNote.mock.calls[0]![1] as string;
    const noteLine = body.split('\n').find((l) => l.startsWith('Note:'));
    expect(noteLine).toBe('Note: line one FAKE STATUS: approved');
  });
});
