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
  createInternalComment,
  createContact,
  listLocationCustomFields,
  createLocationCustomField,
  sendSms,
  updateOpportunity,
  getContactInternal,
  getContactDndState,
  parseContactDndState,
  getGhlUser,
  HighLevelError,
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
    // #264: safe even for tests that never called useFakeTimers (mirrors
    // valorVault.test.ts's own afterEach) — guards the new ghlFetch timeout
    // tests below from leaking fake timers into later tests in this file.
    vi.useRealTimers();
  });

  describe('getGhlUser (rep-assignment ruling, calls_merge_plan_2026-08.md)', () => {
    it('resolves email + name (firstName/lastName join) from GET /users/{userId}', async () => {
      const fetchMock = mockFetchCapture({ email: 'rep@x.com', firstName: 'Jane', lastName: 'Rep' });
      const result = await getGhlUser('ghl-user-1');

      expect(result).toEqual({ email: 'rep@x.com', name: 'Jane Rep' });
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toContain('/users/ghl-user-1');
    });

    it('prefers an explicit name field over the firstName/lastName join', async () => {
      mockFetchOnce({ email: 'rep@x.com', firstName: 'Jane', lastName: 'Rep', name: 'J. Rep (Display)' });
      const result = await getGhlUser('ghl-user-1');
      expect(result.name).toBe('J. Rep (Display)');
    });

    it('resolves a null name when neither name nor firstName/lastName is present', async () => {
      mockFetchOnce({ email: 'rep@x.com' });
      const result = await getGhlUser('ghl-user-1');
      expect(result).toEqual({ email: 'rep@x.com', name: null });
    });

    it('degrades to nulls on a non-OK response rather than throwing', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => { throw new Error('not json'); },
        text: async () => 'Not Found',
      }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await getGhlUser('missing-user');
      expect(result).toEqual({ email: null, name: null });
    });

    it('degrades to nulls when HighLevel is not configured, rather than throwing', async () => {
      delete process.env.HIGHLEVEL_API_KEY;
      const result = await getGhlUser('ghl-user-1');
      expect(result).toEqual({ email: null, name: null });
    });
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

  // #314: getContactInternal is the server-only counterpart that DOES carry
  // the raw record — proves the opt-in path actually surfaces customFields,
  // which the redacted default above (correctly) discards.
  describe('getContactInternal (#314 — server-only raw contact fetch)', () => {
    it('returns the raw HighLevel record including customFields', async () => {
      const hl: HighLevelContact = {
        id: 'c1',
        firstName: 'Jordan',
        customFields: [{ id: 'ed_field_1', value: '11/27/2026' }],
      };
      mockFetchOnce({ contact: hl });
      const contact = await getContactInternal('c1');
      expect(contact.id).toBe('c1');
      expect((contact.raw as HighLevelContact).customFields).toEqual([
        { id: 'ed_field_1', value: '11/27/2026' },
      ]);
    });
  });

  // 2026-09-02 incident: Settings → HighLevel's DND health check. The pure
  // parser is tested directly (no network); getContactDndState's own test
  // proves it wires ghlFetch's `{ contact }` envelope into that parser.
  describe('parseContactDndState (2026-09-02 incident — internal-alert DND health check)', () => {
    it('active Email DND → emailDnd:true, carrying the message + code', () => {
      const result = parseContactDndState({
        id: 'c1',
        dndSettings: { Email: { status: 'active', message: 'User clicked on the unsubscribe link', code: '105' } },
      });
      expect(result).toEqual({ emailDnd: true, message: 'User clicked on the unsubscribe link', code: '105' });
    });

    it('missing dndSettings entirely → emailDnd:false', () => {
      const result = parseContactDndState({ id: 'c1' });
      expect(result).toEqual({ emailDnd: false, message: undefined, code: undefined });
    });

    it('Email DND present but inactive → emailDnd:false', () => {
      const result = parseContactDndState({ id: 'c1', dndSettings: { Email: { status: 'inactive' } } });
      expect(result?.emailDnd).toBe(false);
    });

    it('malformed/absent contact → null', () => {
      expect(parseContactDndState(null)).toBeNull();
      expect(parseContactDndState(undefined)).toBeNull();
      expect(parseContactDndState('not-an-object')).toBeNull();
    });
  });

  describe('getContactDndState', () => {
    it('fetches /contacts/{id} and parses the envelope\'s contact.dndSettings.Email', async () => {
      const fetchMock = mockFetchCapture({
        contact: { id: 'c1', dndSettings: { Email: { status: 'active', message: 'unsubscribed', code: '105' } } },
      });
      const result = await getContactDndState('c1');
      expect(result).toEqual({ emailDnd: true, message: 'unsubscribed', code: '105' });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('/contacts/c1');
    });

    it('no contact in the response → null', async () => {
      mockFetchOnce({});
      const result = await getContactDndState('c1');
      expect(result).toBeNull();
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

  describe('listLocationCustomFields / createLocationCustomField (#200 tenure field)', () => {
    // Local non-ok fetch helper (mirrors the shape of mockFetchRouted, which
    // is scoped to a different describe block above) — needed here to prove
    // a 401/403 surfaces as a HighLevelError with .status set, which
    // ghlTenure.ts's scope-failure detection depends on.
    function mockFetchStatus(status: number, json: unknown) {
      const fn = vi.fn(async (_url: string, _init?: RequestInit) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => json,
        text: async () => JSON.stringify(json),
      }));
      vi.stubGlobal('fetch', fn);
      return fn;
    }

    it('GETs /locations/{locationId}/customFields?model=contact and returns the array', async () => {
      const fetchMock = mockFetchCapture({
        customFields: [{ id: 'f1', name: 'Years with YLL', dataType: 'TEXT' }],
      });

      const fields = await listLocationCustomFields();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toContain('/locations/loc_1/customFields');
      expect(String(url)).toContain('model=contact');
      expect((init as RequestInit).method ?? 'GET').toBe('GET');
      expect(fields).toEqual([{ id: 'f1', name: 'Years with YLL', dataType: 'TEXT' }]);
    });

    it('returns [] when the response carries no customFields key', async () => {
      mockFetchOnce({});
      expect(await listLocationCustomFields()).toEqual([]);
    });

    it('POSTs /locations/{locationId}/customFields with name + dataType + model:contact', async () => {
      const fetchMock = mockFetchCapture({ id: 'new-field-1', name: 'Years with YLL', dataType: 'TEXT' });

      const field = await createLocationCustomField({ name: 'Years with YLL', dataType: 'TEXT' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toContain('/locations/loc_1/customFields');
      expect((init as RequestInit).method).toBe('POST');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body).toEqual({ name: 'Years with YLL', dataType: 'TEXT', model: 'contact' });
      expect(field.id).toBe('new-field-1');
    });

    it('also accepts a {customField: {...}} wrapped create response', async () => {
      mockFetchOnce({ customField: { id: 'wrapped-1', name: 'Years with YLL', dataType: 'TEXT' } });
      const field = await createLocationCustomField({ name: 'Years with YLL', dataType: 'TEXT' });
      expect(field.id).toBe('wrapped-1');
    });

    it('throws a HighLevelError when the create response has no field id in either shape', async () => {
      mockFetchOnce({ ok: true });
      await expect(
        createLocationCustomField({ name: 'Years with YLL', dataType: 'TEXT' }),
      ).rejects.toBeInstanceOf(HighLevelError);
    });

    it('a 401 from the list endpoint surfaces as a HighLevelError with .status set (scope detection)', async () => {
      mockFetchStatus(401, { message: 'Forbidden' });
      await expect(listLocationCustomFields()).rejects.toMatchObject({ status: 401 });
    });

    it('a 403 from the create endpoint surfaces as a HighLevelError with .status set', async () => {
      mockFetchStatus(403, { message: 'Forbidden' });
      await expect(
        createLocationCustomField({ name: 'Years with YLL', dataType: 'TEXT' }),
      ).rejects.toMatchObject({ status: 403 });
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

  describe('createInternalComment', () => {
    // Local non-ok fetch helper -- mockFetchStatus above is scoped to a
    // different describe block, so this mirrors it rather than reaching
    // across scopes.
    function mockCommentFetchStatus(status: number, json: unknown) {
      const fn = vi.fn(async (_url: string, _init?: RequestInit) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => json,
        text: async () => JSON.stringify(json),
      }));
      vi.stubGlobal('fetch', fn);
      return fn;
    }

    it('POSTs /conversations/messages with type InternalComment, contactId, message, and no mentions', async () => {
      const fetchMock = mockFetchCapture({ conversationId: 'conv-1', messageId: 'msg-1' });

      await createInternalComment('c1', 'hello world');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toContain('/conversations/messages');
      expect((init as RequestInit).method).toBe('POST');
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        type: 'InternalComment',
        contactId: 'c1',
        message: 'hello world',
        mentions: [],
      });
    });

    it('a 400 (e.g. a rejected empty mentions array) surfaces as a HighLevelError with .status set', async () => {
      mockCommentFetchStatus(400, { message: 'mentions is required' });
      await expect(createInternalComment('c1', 'hello world')).rejects.toMatchObject({ status: 400 });
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

  // #264: ghlFetch (the one low-level fetch every function in this file
  // funnels through) previously had no timeout at all — a hung GHL
  // connection stalled the caller indefinitely, most acutely POST
  // /api/quotes/[id]/send. Tested through sendSms (the exact function that
  // route calls) + a second, unrelated function (updateOpportunity) to prove
  // this is a CENTRAL fix, not something duplicated per public function.
  describe('ghlFetch timeout (#264)', () => {
    // A fetch that only settles once the AbortController's signal actually
    // fires — mirrors valorVault.test.ts's "a hung request times out"
    // pattern. NOT a promise that never resolves at all: that would leave the
    // test passing even if ghlFetch never wired the signal into fetch() in
    // the first place.
    function hangingFetchMock() {
      return vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      }));
    }

    it('a hung connection rejects within the 10s deadline with a HighLevelError(timedOut: true) — never hangs', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', hangingFetchMock());

      // .catch() is attached SYNCHRONOUSLY (before advancing timers) so a
      // handler is already listening the instant the promise rejects — doing
      // this after advanceTimersByTimeAsync would flag a real (harmless)
      // unhandled-rejection in the gap, since the reject happens DURING the
      // advance, not during a later `expect(...).rejects` call.
      const errPromise = sendSms({ contactId: 'c1', message: 'hi' }).catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(10_000);
      const err = await errPromise;

      expect(err).toBeInstanceOf(HighLevelError);
      expect(err).toMatchObject({ timedOut: true });
      expect((err as Error).message).toMatch(/timed out after 10000ms/);
    });

    // #264 round 2, FIX 2: headers arriving fast previously let the timer get
    // cleared before the body was ever read — a fast-headers/slow-body
    // response hung unbounded (confirmed live against a real HTTP server
    // whose body never completes). This pins the SAME 10s deadline against
    // that specific phase: fetch() itself resolves immediately (ok:true), and
    // only .json() hangs until the abort fires.
    it('a hung response BODY (fast headers, stalled body) also times out within the deadline — not just a hung connection', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn((_url: string, init: RequestInit) => Promise.resolve({
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        }),
        text: async () => '',
      }));
      vi.stubGlobal('fetch', fetchMock);

      const errPromise = sendSms({ contactId: 'c1', message: 'hi' }).catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(10_000);
      const err = await errPromise;

      expect(err).toBeInstanceOf(HighLevelError);
      expect(err).toMatchObject({ timedOut: true });
      expect((err as Error).message).toMatch(/timed out after 10000ms \(reading the response body\)/);
    });

    it('the same deadline covers a second, unrelated GHL call (proves the central choke point)', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', hangingFetchMock());

      const errPromise = updateOpportunity('opp_1', { pipelineStageId: 'stage_1' }).catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(10_000);
      const err = await errPromise;

      expect(err).toMatchObject({ timedOut: true });
    });

    it('a NORMAL (non-abort) fetch rejection propagates unchanged — timedOut only fires on our own deadline', async () => {
      const networkErr = new TypeError('fetch failed: ECONNREFUSED');
      vi.stubGlobal('fetch', vi.fn(async () => { throw networkErr; }));

      await expect(sendSms({ contactId: 'c1', message: 'hi' })).rejects.toBe(networkErr);
    });
  });
});
