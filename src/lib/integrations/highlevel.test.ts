// Audit-fix coverage for two HighLevel client behaviors (group g19-highlevel):
//  1. findOpportunityForContact must NOT resurrect a closed (won/lost/abandoned)
//     card — only an OPEN card is reused, otherwise null (caller creates fresh).
//  2. The public CrmContact shape returned by searchContacts/getContact must
//     never carry the raw HighLevel source record (redaction is the default).
//
// We mock global fetch + the required env vars; no live HighLevel calls.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { findOpportunityForContact, searchContacts, createContact } from './highlevel';
import type { HighLevelContact, HighLevelOpportunity } from './types';

function mockFetchOnce(json: unknown) {
  const fetchMock = vi.fn(async (_url?: string, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => json,
    text: async () => JSON.stringify(json),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('HighLevel client (audit fix g19-highlevel)', () => {
  beforeEach(() => {
    process.env.HIGHLEVEL_API_KEY = 'test-key';
    process.env.HIGHLEVEL_LOCATION_ID = 'loc_1';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('findOpportunityForContact', () => {
    it('returns null when the contact has only a closed (lost) card — no resurrection', async () => {
      const lost: HighLevelOpportunity = {
        id: 'opp_lost',
        contactId: 'c1',
        pipelineId: 'p1',
        status: 'lost',
      };
      mockFetchOnce({ opportunities: [lost] });
      const result = await findOpportunityForContact('c1', 'p1');
      expect(result).toBeNull();
    });

    it('returns null when all cards are won/abandoned (no open card)', async () => {
      mockFetchOnce({
        opportunities: [
          { id: 'o_won', contactId: 'c1', pipelineId: 'p1', status: 'won' },
          { id: 'o_ab', contactId: 'c1', pipelineId: 'p1', status: 'abandoned' },
        ],
      });
      expect(await findOpportunityForContact('c1', 'p1')).toBeNull();
    });

    it('reuses the open card when one exists', async () => {
      mockFetchOnce({
        opportunities: [
          { id: 'o_lost', contactId: 'c1', pipelineId: 'p1', status: 'lost' },
          { id: 'o_open', contactId: 'c1', pipelineId: 'p1', status: 'open' },
        ],
      });
      const result = await findOpportunityForContact('c1', 'p1');
      expect(result?.id).toBe('o_open');
    });

    it('returns null when there are no opportunities at all', async () => {
      mockFetchOnce({ opportunities: [] });
      expect(await findOpportunityForContact('c1', 'p1')).toBeNull();
    });
  });

  describe('toCrmContact redaction (via searchContacts)', () => {
    it('does not attach the raw source record by default', async () => {
      const hl: HighLevelContact = {
        id: 'c1',
        firstName: 'Jordan',
        lastName: 'Rivera',
        email: 'jordan@example.com',
        customFields: [{ id: 'cf1', value: 'secret' }],
        tags: ['vip'],
      };
      mockFetchOnce({ contacts: [hl] });
      const [contact] = await searchContacts('jordan');
      expect(contact).toBeDefined();
      expect(contact.firstName).toBe('Jordan');
      expect('raw' in contact).toBe(false);
    });
  });

  describe('createContact (#41 referral landing page)', () => {
    it('POSTs /contacts/ with locationId + the referral tag, and returns the redacted contact', async () => {
      const created: HighLevelContact = {
        id: 'c_new',
        name: 'Sam Rivera',
        phone: '5165550123',
        tags: ['referral'],
      } as HighLevelContact;
      const fetchMock = mockFetchOnce({ contact: created });

      const contact = await createContact({
        name: 'Sam Rivera',
        phone: '5165550123',
        tags: ['referral'],
        source: 'referral-landing-page',
      });

      expect(contact.id).toBe('c_new');
      expect('raw' in contact).toBe(false); // redaction is the default (mirrors toCrmContact)

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body).toMatchObject({
        locationId: 'loc_1',
        name: 'Sam Rivera',
        phone: '5165550123',
        tags: ['referral'],
        source: 'referral-landing-page',
      });
    });

    it('defaults source to ai-quote-tool and tags to [] when not provided', async () => {
      const fetchMock = mockFetchOnce({ contact: { id: 'c_new' } as HighLevelContact });
      await createContact({ email: 'sam@example.com' });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body).toMatchObject({ source: 'ai-quote-tool', tags: [] });
    });
  });
});
