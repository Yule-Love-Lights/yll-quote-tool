// Tests for the non-lead submission path (#195).
//
// The important ones here are the SEPARATION tests: these forms must never
// touch the sales machinery. A newsletter signup that quietly acquired the
// 'new lead' tag would enrol a subscriber in SMS drips, which is exactly the
// outcome this whole table and route exist to prevent.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertContact = vi.fn();
const addContactTags = vi.fn();
const createOpportunity = vi.fn();
const findOrCreateOpportunityForContact = vi.fn();

vi.mock('@/lib/integrations/highlevel', () => ({
  upsertContact: (...args: unknown[]) => upsertContact(...args),
  addContactTags: (...args: unknown[]) => addContactTags(...args),
  createOpportunity: (...args: unknown[]) => createOpportunity(...args),
  findOrCreateOpportunityForContact: (...args: unknown[]) =>
    findOrCreateOpportunityForContact(...args),
}));

import {
  SITE_FORM_TYPES,
  SITE_FORM_TAGS,
  FORBIDDEN_SALES_TAGS,
  asSiteFormType,
  requiredFieldsFor,
  splitName,
  syncSubmissionToGhl,
} from './siteFormService';

beforeEach(() => {
  vi.clearAllMocks();
  upsertContact.mockResolvedValue({ contact: { id: 'contact_1' }, new: true });
  addContactTags.mockResolvedValue({ tags: [] });
});

describe('form type parsing', () => {
  it('accepts every known type and rejects anything else', () => {
    for (const t of SITE_FORM_TYPES) expect(asSiteFormType(t)).toBe(t);
    expect(asSiteFormType('christmas')).toBeNull();
    expect(asSiteFormType('')).toBeNull();
    expect(asSiteFormType(undefined)).toBeNull();
    expect(asSiteFormType(7)).toBeNull();
  });
});

describe('separation from the sales path', () => {
  it('never tags a submission with a sales tag', () => {
    const tags = Object.values(SITE_FORM_TAGS).map((t) => t.toLowerCase());
    for (const forbidden of FORBIDDEN_SALES_TAGS) {
      expect(tags).not.toContain(forbidden.toLowerCase());
    }
  });

  it('gives every form type its own distinct tag', () => {
    const tags = Object.values(SITE_FORM_TAGS);
    expect(new Set(tags).size).toBe(tags.length);
    expect(Object.keys(SITE_FORM_TAGS).sort()).toEqual([...SITE_FORM_TYPES].sort());
  });

  it('creates a tagged contact and NO opportunity', async () => {
    const result = await syncSubmissionToGhl({
      formType: 'newsletter',
      email: 'someone@example.com',
      name: 'Pat Smith',
    });

    expect(upsertContact).toHaveBeenCalledTimes(1);
    expect(addContactTags).toHaveBeenCalledWith('contact_1', ['newsletter-signup']);
    expect(result).toEqual({ contactId: 'contact_1', tags: ['newsletter-signup'] });

    // The whole point: no pipeline, no opportunity, ever.
    expect(createOpportunity).not.toHaveBeenCalled();
    expect(findOrCreateOpportunityForContact).not.toHaveBeenCalled();
  });

  it('applies the right tag for each form type', async () => {
    for (const type of SITE_FORM_TYPES) {
      vi.clearAllMocks();
      upsertContact.mockResolvedValue({ contact: { id: 'c' }, new: false });
      addContactTags.mockResolvedValue({ tags: [] });
      await syncSubmissionToGhl({ formType: type, email: 'a@b.com' });
      expect(addContactTags).toHaveBeenCalledWith('c', [SITE_FORM_TAGS[type]]);
      expect(createOpportunity).not.toHaveBeenCalled();
    }
  });

  it('sends only the submitter to GHL, never a nominee', async () => {
    await syncSubmissionToGhl({
      formType: 'nomination',
      email: 'nominator@example.com',
      name: 'Nora Nominator',
      phone: '5551110000',
    });

    const arg = upsertContact.mock.calls[0]![0] as Record<string, unknown>;
    const serialized = JSON.stringify(arg).toLowerCase();
    // The nominee's details are not part of this call's shape at all.
    expect(arg.email).toBe('nominator@example.com');
    expect(serialized).not.toContain('nominee');
    expect(Object.keys(arg).sort()).toEqual(
      ['email', 'firstName', 'lastName', 'phone', 'source'].sort(),
    );
  });

  it('skips tagging when GHL returns no contact id, without throwing', async () => {
    upsertContact.mockResolvedValue({ contact: {}, new: false });
    const result = await syncSubmissionToGhl({ formType: 'careers', email: 'a@b.com' });
    expect(result).toEqual({ contactId: null, tags: [] });
    expect(addContactTags).not.toHaveBeenCalled();
  });
});

describe('required fields per form type', () => {
  it('keeps the newsletter to email only, matching the footer form it replaces', () => {
    expect(requiredFieldsFor('newsletter')).toEqual({
      name: false,
      phone: false,
      consent: false,
    });
  });

  it('requires consent on applications and nominations', () => {
    for (const type of ['careers', 'intern', 'nomination'] as const) {
      expect(requiredFieldsFor(type).consent).toBe(true);
      expect(requiredFieldsFor(type).name).toBe(true);
    }
  });
});

describe('splitName', () => {
  it('handles empty, single and multi-part names', () => {
    expect(splitName(null)).toEqual({});
    expect(splitName('   ')).toEqual({});
    expect(splitName('Cher')).toEqual({ firstName: 'Cher' });
    expect(splitName('Pat Smith')).toEqual({ firstName: 'Pat', lastName: 'Smith' });
    expect(splitName('  Maria de la Cruz ')).toEqual({
      firstName: 'Maria de la',
      lastName: 'Cruz',
    });
  });
});
