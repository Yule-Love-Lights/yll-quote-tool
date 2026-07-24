// Audit-fix coverage for two HighLevel client behaviors (group g19-highlevel):
//  1. findOpportunityForContact must NOT resurrect a closed (won/lost/abandoned)
//     card — only an OPEN card is reused, otherwise null (caller creates fresh).
//  2. The public CrmContact shape returned by searchContacts/getContact must
//     never carry the raw HighLevel source record (redaction is the default).
//
// We mock global fetch + the required env vars; no live HighLevel calls.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  findOpportunityForContact,
  findOrCreateOpportunityForContact,
  searchContacts,
  upsertContact,
  upsertContactCustomField,
  createContactNote,
  createContact,
} from './highlevel';
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

// Like mockFetchOnce but returns the mock so callers can inspect the actual
// request (url + init) — needed to assert the endpoint/method/body shape.
function mockFetchCapture(json: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => json,
    text: async () => JSON.stringify(json),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
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

  // #172: GHL location settings can forbid a second opportunity per contact —
  // POST /opportunities/ 400s with a structured OPPORTUNITY_NO_DUPLICATE error
  // (meta.existingId) whenever the contact already has ANY card, including a
  // won/lost/abandoned one that findOpportunityForContact deliberately ignores.
  // Jason-approved: resurrect that card (reopen + restage + rename/revalue)
  // instead of failing the attach/send.
  describe('findOrCreateOpportunityForContact — duplicate-card resurrect (#172)', () => {
    // Routes a single fetch mock by method + path so a test can script the
    // search → create(400 dup) → update(resurrect) sequence in one place.
    function mockFetchRouted(
      handler: (url: string, init: RequestInit | undefined) => { status: number; json: unknown },
    ) {
      const fn = vi.fn(async (url: string, init?: RequestInit) => {
        const { status, json } = handler(url, init);
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => json,
          text: async () => JSON.stringify(json),
        };
      });
      vi.stubGlobal('fetch', fn);
      return fn;
    }

    const DUP_ERROR_BODY = {
      statusCode: 400,
      message: 'Can not create duplicate opportunity for the contact.',
      code: 'OPPORTUNITY_NO_DUPLICATE',
      meta: { existingId: 'opp_abandoned' },
      error: 'Bad Request',
      traceId: 'trace-1',
    };

    it('resurrects the existing card on OPPORTUNITY_NO_DUPLICATE: PUT status open + intended pipeline/stage/name/value', async () => {
      const fetchMock = mockFetchRouted((url, init) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url.includes('/opportunities/search')) {
          // Only a closed card exists — findOpportunityForContact ignores it.
          return {
            status: 200,
            json: { opportunities: [{ id: 'opp_abandoned', contactId: 'c1', pipelineId: 'p1', status: 'abandoned' }] },
          };
        }
        if (method === 'GET' && url.includes('/opportunities/opp_abandoned')) {
          // Read-before-write guard: the resurrect inspects the card first.
          return {
            status: 200,
            json: { opportunity: { id: 'opp_abandoned', contactId: 'c1', pipelineId: 'p1', status: 'abandoned' } },
          };
        }
        if (method === 'POST' && url.includes('/opportunities/')) {
          return { status: 400, json: DUP_ERROR_BODY };
        }
        if (method === 'PUT' && url.includes('/opportunities/opp_abandoned')) {
          return {
            status: 200,
            json: {
              opportunity: {
                id: 'opp_abandoned',
                contactId: 'c1',
                pipelineId: 'p1',
                pipelineStageId: 'stage_open',
                status: 'open',
                name: 'Diana Lopez-Smith',
                monetaryValue: 5000,
              },
            },
          };
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      });

      const result = await findOrCreateOpportunityForContact({
        contactId: 'c1',
        pipelineId: 'p1',
        fallbackStageId: 'stage_open',
        fallbackName: 'Diana Lopez-Smith',
        monetaryValue: 5000,
      });

      expect(result.created).toBe(false);
      expect(result.resurrected).toBe(true);
      expect(result.opportunity.id).toBe('opp_abandoned');
      expect(result.opportunity.status).toBe('open');

      const putCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PUT');
      expect(putCall).toBeTruthy();
      const [putUrl, putInit] = putCall!;
      expect(String(putUrl)).toContain('/opportunities/opp_abandoned');
      expect(JSON.parse((putInit as RequestInit).body as string)).toEqual({
        status: 'open',
        pipelineId: 'p1',
        pipelineStageId: 'stage_open',
        name: 'Diana Lopez-Smith',
        monetaryValue: 5000,
      });
    });

    it('REFUSES to resurrect an OPEN card (cross-pipeline active deal) — throws, no PUT', async () => {
      const fetchMock = mockFetchRouted((url, init) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url.includes('/opportunities/search')) {
          return { status: 200, json: { opportunities: [] } };
        }
        if (method === 'GET' && url.includes('/opportunities/opp_active')) {
          // The existing card is a LIVE deal in another pipeline.
          return {
            status: 200,
            json: { opportunity: { id: 'opp_active', contactId: 'c1', pipelineId: 'p_other', status: 'open' } },
          };
        }
        if (method === 'POST' && url.includes('/opportunities/')) {
          return {
            status: 400,
            json: { ...DUP_ERROR_BODY, meta: { existingId: 'opp_active' } },
          };
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      });

      await expect(
        findOrCreateOpportunityForContact({
          contactId: 'c1',
          pipelineId: 'p1',
          fallbackStageId: 'stage_open',
          fallbackName: 'Diana Lopez-Smith',
        }),
      ).rejects.toThrow(/ACTIVE opportunity/i);
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'PUT')).toBe(false);
    });

    it('a WON card resurrects like any other non-open card (repeat-customer rebook)', async () => {
      mockFetchRouted((url, init) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url.includes('/opportunities/search')) {
          return { status: 200, json: { opportunities: [] } };
        }
        if (method === 'GET' && url.includes('/opportunities/opp_won')) {
          return {
            status: 200,
            json: { opportunity: { id: 'opp_won', contactId: 'c1', pipelineId: 'p1', status: 'won' } },
          };
        }
        if (method === 'POST' && url.includes('/opportunities/')) {
          return { status: 400, json: { ...DUP_ERROR_BODY, meta: { existingId: 'opp_won' } } };
        }
        if (method === 'PUT' && url.includes('/opportunities/opp_won')) {
          return {
            status: 200,
            json: { opportunity: { id: 'opp_won', contactId: 'c1', pipelineId: 'p1', pipelineStageId: 'stage_open', status: 'open' } },
          };
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      });

      const result = await findOrCreateOpportunityForContact({
        contactId: 'c1',
        pipelineId: 'p1',
        fallbackStageId: 'stage_open',
        fallbackName: 'Diana Lopez-Smith',
      });
      expect(result.resurrected).toBe(true);
      expect(result.opportunity.id).toBe('opp_won');
    });

    it('resets monetaryValue to 0 on resurrect when the caller has no value (no stale dollars)', async () => {
      const fetchMock = mockFetchRouted((url, init) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url.includes('/opportunities/search')) {
          return { status: 200, json: { opportunities: [] } };
        }
        if (method === 'GET' && url.includes('/opportunities/opp_abandoned')) {
          return {
            status: 200,
            json: { opportunity: { id: 'opp_abandoned', contactId: 'c1', pipelineId: 'p1', status: 'abandoned', monetaryValue: 5400 } },
          };
        }
        if (method === 'POST' && url.includes('/opportunities/')) {
          return { status: 400, json: DUP_ERROR_BODY };
        }
        if (method === 'PUT' && url.includes('/opportunities/opp_abandoned')) {
          return { status: 200, json: { opportunity: { id: 'opp_abandoned', status: 'open' } } };
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      });

      await findOrCreateOpportunityForContact({
        contactId: 'c1',
        pipelineId: 'p1',
        fallbackStageId: 'stage_open',
        fallbackName: 'Diana Lopez-Smith',
        // no monetaryValue
      });
      const putCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PUT')!;
      expect(JSON.parse((putCall[1] as RequestInit).body as string).monetaryValue).toBe(0);
    });

    it('parses a TRUNCATED duplicate body (ghlFetch 2000-char cap) via the regex fallback', async () => {
      // Invalid JSON (closing braces cut off) but the discriminating fields survive.
      const truncated = '{"statusCode":400,"message":"Can not create duplicate opportunity for the contact.","code":"OPPORTUNITY_NO_DUPLICATE","meta":{"existingId":"opp_cut"';
      const fn = vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url.includes('/opportunities/search')) {
          return { ok: true, status: 200, json: async () => ({ opportunities: [] }), text: async () => '{"opportunities":[]}' };
        }
        if (method === 'GET' && url.includes('/opportunities/opp_cut')) {
          const json = { opportunity: { id: 'opp_cut', contactId: 'c1', pipelineId: 'p1', status: 'abandoned' } };
          return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
        }
        if (method === 'POST') {
          return { ok: false, status: 400, json: async () => { throw new Error('not json'); }, text: async () => truncated };
        }
        if (method === 'PUT' && url.includes('/opportunities/opp_cut')) {
          const json = { opportunity: { id: 'opp_cut', status: 'open' } };
          return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      });
      vi.stubGlobal('fetch', fn);

      const result = await findOrCreateOpportunityForContact({
        contactId: 'c1',
        pipelineId: 'p1',
        fallbackStageId: 'stage_open',
        fallbackName: 'Diana Lopez-Smith',
      });
      expect(result.resurrected).toBe(true);
      expect(result.opportunity.id).toBe('opp_cut');
    });

    it('rethrows the original error when the duplicate body is missing meta.existingId', async () => {
      mockFetchRouted((url, init) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url.includes('/opportunities/search')) {
          return { status: 200, json: { opportunities: [] } };
        }
        if (method === 'POST' && url.includes('/opportunities/')) {
          return {
            status: 400,
            json: {
              statusCode: 400,
              code: 'OPPORTUNITY_NO_DUPLICATE',
              message: 'Can not create duplicate opportunity for the contact.',
              meta: {},
            },
          };
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      });

      await expect(
        findOrCreateOpportunityForContact({
          contactId: 'c1',
          pipelineId: 'p1',
          fallbackStageId: 'stage_open',
          fallbackName: 'Diana Lopez-Smith',
        }),
      ).rejects.toThrow(/duplicate opportunity/i);
    });

    it('rethrows the original error when the 400 body is not JSON at all', async () => {
      const fn = vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url.includes('/opportunities/search')) {
          return { ok: true, status: 200, json: async () => ({ opportunities: [] }), text: async () => '{"opportunities":[]}' };
        }
        return { ok: false, status: 400, json: async () => { throw new Error('not json'); }, text: async () => 'Bad Request (not JSON)' };
      });
      vi.stubGlobal('fetch', fn);

      await expect(
        findOrCreateOpportunityForContact({
          contactId: 'c1',
          pipelineId: 'p1',
          fallbackStageId: 'stage_open',
          fallbackName: 'Diana Lopez-Smith',
        }),
      ).rejects.toThrow(/Bad Request/i);
    });

    it('rethrows a non-duplicate 400 unchanged (no resurrect attempted)', async () => {
      const fetchMock = mockFetchRouted((url, init) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url.includes('/opportunities/search')) {
          return { status: 200, json: { opportunities: [] } };
        }
        if (method === 'POST' && url.includes('/opportunities/')) {
          return { status: 400, json: { statusCode: 400, message: 'Some other validation error', error: 'Bad Request' } };
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      });

      await expect(
        findOrCreateOpportunityForContact({
          contactId: 'c1',
          pipelineId: 'p1',
          fallbackStageId: 'stage_open',
          fallbackName: 'Diana Lopez-Smith',
        }),
      ).rejects.toThrow(/Some other validation error/i);

      // Only the search + failed create — no PUT attempted.
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'PUT')).toBe(false);
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

  // ─── #leads website lead capture — the two new client functions ─────────
  describe('upsertContact', () => {
    it('POSTs /contacts/upsert with locationId + the given fields, and never sends tags', async () => {
      const fetchMock = mockFetchCapture({
        contact: { id: 'c1', firstName: 'Jordan', email: 'jordan@example.com' },
        new: true,
      });

      const result = await upsertContact({
        firstName: 'Jordan',
        lastName: 'Rivera',
        email: 'jordan@example.com',
        phone: '+16315550100',
        address1: '123 Main St',
        source: 'Website Form',
      });

      expect(result.contact.id).toBe('c1');
      expect(result.new).toBe(true);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toContain('/contacts/upsert');
      expect((init as RequestInit).method).toBe('POST');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.locationId).toBe('loc_1');
      expect(body.firstName).toBe('Jordan');
      expect(body.lastName).toBe('Rivera');
      expect(body.email).toBe('jordan@example.com');
      expect(body.phone).toBe('+16315550100');
      expect(body.source).toBe('Website Form');
      expect(body).not.toHaveProperty('tags');
    });
  });

  describe('upsertContactCustomField (F4 — CHECKBOX fields expect an array)', () => {
    it('PUTs customFields with an ARRAY value when given an array', async () => {
      const fetchMock = mockFetchCapture({ contact: { id: 'c1' } });

      await upsertContactCustomField('c1', 'field-123', ['Christmas', 'Permanent']);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toContain('/contacts/c1');
      expect((init as RequestInit).method).toBe('PUT');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.customFields).toEqual([{ id: 'field-123', value: ['Christmas', 'Permanent'] }]);
    });

    it('still PUTs a plain string value for a TEXT field (existing callers unaffected)', async () => {
      const fetchMock = mockFetchCapture({ contact: { id: 'c1' } });

      await upsertContactCustomField('c1', 'field-456', 'some text value');

      const [, init] = fetchMock.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.customFields).toEqual([{ id: 'field-456', value: 'some text value' }]);
    });
  });

  describe('createContactNote', () => {
    it('POSTs /contacts/{contactId}/notes with { body }', async () => {
      const fetchMock = mockFetchCapture({ id: 'note-1', body: 'hello world' });

      await createContactNote('c1', 'hello world');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toContain('/contacts/c1/notes');
      expect((init as RequestInit).method).toBe('POST');
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({ body: 'hello world' });
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
