// Tests for POST /api/leads (website lead-capture — replaces the old plugin
// that routed every lead into the Christmas pipeline). Covers validation,
// honeypot/timing spam handling, IP rate limiting, the GHL sync fail-open
// contract (a GHL error must never surface as a customer-facing failure),
// the landscape "deferred" pipeline case, and CORS.
//
// Supabase and the HighLevel client are mocked; no live calls. ghlPipelineMap
// is NOT mocked — christmas/permanent/event-wedding resolve against the real,
// hardcoded pipeline map so a drift there would be caught here too.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const hl = vi.hoisted(() => {
  class FakeHighLevelError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = 'HighLevelError';
      this.status = status;
    }
  }
  return {
    HighLevelError: FakeHighLevelError,
    upsertContact: vi.fn(async (_input: unknown) => ({
      contact: { id: 'contact-1', firstName: 'Jordan', email: 'jordan@example.com' },
      new: true,
    })),
    addContactTags: vi.fn(async (_contactId: string, _tags: string[]) => ({})),
    upsertContactCustomField: vi.fn(async (_contactId: string, _fieldId: string, _value: string) => {}),
    createContactNote: vi.fn(async (_contactId: string, _body: string) => ({})),
    findOrCreateOpportunityForContact: vi.fn(async (_input: unknown) => ({
      opportunity: { id: 'opp-1' },
      created: true,
    })),
    createOpportunity: vi.fn(async (_input: unknown) => ({ id: 'opp-should-not-be-called' })),
  };
});

vi.mock('@/lib/integrations/highlevel', () => ({
  upsertContact: hl.upsertContact,
  addContactTags: hl.addContactTags,
  upsertContactCustomField: hl.upsertContactCustomField,
  createContactNote: hl.createContactNote,
  findOrCreateOpportunityForContact: hl.findOrCreateOpportunityForContact,
  createOpportunity: hl.createOpportunity,
  HighLevelError: hl.HighLevelError,
}));

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

import { POST, OPTIONS } from './route';

// ── Fake Supabase query builder ─────────────────────────────────────────────
// Three call shapes the route makes:
//   count:  from('website_leads').select('id',{count,head}).eq().not().gte()  → awaited directly → { count, error }
//   insert: from('website_leads').insert(row).select('id').single()          → { data:{id}, error }
//           (the spam path insert()s without select/single — awaited directly)
//   update: from('website_leads').update(payload).eq('id', id)               → awaited directly → { error }
function makeSb(opts: {
  leadCount?: number;
  countError?: { message: string } | null;
  insertError?: { message: string } | null;
  updateError?: { message: string } | null;
} = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  let mode: 'count' | 'insert' | 'update' | null = null;

  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: (_cols: string, selOpts?: { count?: string; head?: boolean }) => {
      if (selOpts?.head) mode = 'count';
      return builder;
    },
    insert: (payload: Record<string, unknown>) => {
      mode = 'insert';
      inserted.push(payload);
      return builder;
    },
    update: (payload: Record<string, unknown>) => {
      mode = 'update';
      updated.push(payload);
      return builder;
    },
    eq: () => builder,
    not: () => builder,
    gte: () => builder,
    single: async () => ({
      data: { id: 'lead-1' },
      error: opts.insertError ?? null,
    }),
    then: (resolve: (v: unknown) => void) => {
      if (mode === 'count') {
        resolve({ data: null, count: opts.leadCount ?? 0, error: opts.countError ?? null });
      } else if (mode === 'update') {
        resolve({ error: opts.updateError ?? null });
      } else {
        resolve({ data: null, error: opts.insertError ?? null });
      }
      mode = null;
    },
  });
  return { client: builder, inserted, updated };
}

function makeReq(
  body: unknown,
  opts: { origin?: string | null; ip?: string | null } = {},
): NextRequest {
  return {
    json: async () => body,
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === 'origin') return opts.origin ?? null;
        if (name.toLowerCase() === 'x-forwarded-for') return opts.ip ?? '203.0.113.5';
        return null;
      },
    },
  } as unknown as NextRequest;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Jordan Rivera',
    email: 'jordan@example.com',
    phone: '+16315550100',
    address: '123 Main St',
    service: 'christmas',
    notes: 'Wants warm white',
    consent: true,
    utm: { utm_source: 'google' },
    landingUrl: 'https://yulelovelights.com/quote',
    formVariant: 'hero',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hl.upsertContact.mockResolvedValue({
    contact: { id: 'contact-1', firstName: 'Jordan', email: 'jordan@example.com' },
    new: true,
  });
  hl.findOrCreateOpportunityForContact.mockResolvedValue({
    opportunity: { id: 'opp-1' },
    created: true,
  });
  delete process.env.HIGHLEVEL_PIPELINE_ID_LANDSCAPE;
  delete process.env.HIGHLEVEL_STAGE_LANDSCAPE_ENTRY;
  delete process.env.HIGHLEVEL_CONTACT_FIELD_SERVICE;
});

describe('POST /api/leads — validation (case i)', () => {
  it('400s on missing name', async () => {
    const { client } = makeSb();
    sbRef.current = client;
    const res = await POST(makeReq(validBody({ name: '' })));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(typeof json.error).toBe('string');
  });

  it('400s on an invalid email', async () => {
    sbRef.current = makeSb().client;
    const res = await POST(makeReq(validBody({ email: 'not-an-email' })));
    expect(res.status).toBe(400);
  });

  it('400s on missing phone', async () => {
    sbRef.current = makeSb().client;
    const res = await POST(makeReq(validBody({ phone: '' })));
    expect(res.status).toBe(400);
  });

  it('400s on missing formVariant', async () => {
    sbRef.current = makeSb().client;
    const res = await POST(makeReq(validBody({ formVariant: '' })));
    expect(res.status).toBe(400);
  });

  it('400s on an unrecognized service', async () => {
    sbRef.current = makeSb().client;
    const res = await POST(makeReq(validBody({ service: 'holiday' })));
    expect(res.status).toBe(400);
  });

  it('400s when consent is not a boolean', async () => {
    sbRef.current = makeSb().client;
    const res = await POST(makeReq(validBody({ consent: 'yes' })));
    expect(res.status).toBe(400);
  });

  it('400s (never 500) on invalid JSON', async () => {
    sbRef.current = makeSb().client;
    const req = {
      json: async () => {
        throw new Error('bad json');
      },
      headers: { get: () => null },
    } as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/leads — per-service GHL pipeline routing (case a)', () => {
  it.each([
    ['christmas', 'sC6JEcxlGnNDasanlXDN'],
    ['permanent', 'OqpjVflTdgmjmUQmbcSF'],
    ['event-wedding', 'YfCi5jy8Alc3oD5AfXmV'],
  ])('%s → pipeline %s', async (service, pipelineId) => {
    sbRef.current = makeSb().client;
    const res = await POST(makeReq(validBody({ service })));
    expect(res.status).toBe(200);
    expect(hl.findOrCreateOpportunityForContact).toHaveBeenCalledWith(
      expect.objectContaining({ pipelineId }),
    );
  });
});

describe('POST /api/leads — tags (case b)', () => {
  it('sends exactly [\'new lead\', \'web-lead-<service>\'] — never the 3 legacy tags', async () => {
    sbRef.current = makeSb().client;
    await POST(makeReq(validBody({ service: 'permanent' })));
    expect(hl.addContactTags).toHaveBeenCalledWith('contact-1', ['new lead', 'web-lead-permanent']);
    const [, tags] = hl.addContactTags.mock.calls[0]!;
    expect(tags).not.toContain('heroform');
    expect(tags).not.toContain('stickyform');
    expect(tags).not.toContain('quotesectionform');
  });
});

describe('POST /api/leads — existing open opportunity (case c)', () => {
  it('reuses it — createOpportunity is never called directly', async () => {
    hl.findOrCreateOpportunityForContact.mockResolvedValue({
      opportunity: { id: 'opp-existing' },
      created: false,
    });
    sbRef.current = makeSb().client;

    const res = await POST(makeReq(validBody()));
    expect(res.status).toBe(200);
    expect(hl.findOrCreateOpportunityForContact).toHaveBeenCalledTimes(1);
    expect(hl.createOpportunity).not.toHaveBeenCalled();
  });
});

describe('POST /api/leads — honeypot (case d)', () => {
  it('returns 200 ok, saves the row as spam, makes zero GHL calls', async () => {
    const { client, inserted } = makeSb();
    sbRef.current = client;

    const res = await POST(makeReq(validBody({ company: 'I am a bot' })));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.sync_status).toBe('spam');
    expect(hl.upsertContact).not.toHaveBeenCalled();
    expect(hl.addContactTags).not.toHaveBeenCalled();
    expect(hl.findOrCreateOpportunityForContact).not.toHaveBeenCalled();
  });
});

describe('POST /api/leads — too-fast submit (case e)', () => {
  it('returns 200 ok, saves the row as spam, makes zero GHL calls', async () => {
    const { client, inserted } = makeSb();
    sbRef.current = client;

    const renderedAt = new Date(Date.now() - 500).toISOString(); // 0.5s ago
    const res = await POST(makeReq(validBody({ renderedAt })));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.sync_status).toBe('spam');
    expect(hl.upsertContact).not.toHaveBeenCalled();
  });

  it('a normal render-to-submit gap (>3s) is NOT spam', async () => {
    sbRef.current = makeSb().client;
    const renderedAt = new Date(Date.now() - 10_000).toISOString(); // 10s ago
    const res = await POST(makeReq(validBody({ renderedAt })));
    expect(res.status).toBe(200);
    expect(hl.upsertContact).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/leads — rate limit (case f)', () => {
  it('the 6th lead from one IP in an hour → 429 (5 already exist)', async () => {
    sbRef.current = makeSb({ leadCount: 5 }).client;
    const res = await POST(makeReq(validBody(), { ip: '198.51.100.9' }));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(typeof json.error).toBe('string');
    expect(hl.upsertContact).not.toHaveBeenCalled();
  });

  it('the 5th lead still goes through (only 4 already exist)', async () => {
    sbRef.current = makeSb({ leadCount: 4 }).client;
    const res = await POST(makeReq(validBody(), { ip: '198.51.100.9' }));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/leads — GHL failure fail-open (case g)', () => {
  it('returns 200 ok; the row keeps sync_status pending and gets a sync_error', async () => {
    hl.upsertContact.mockRejectedValue(new hl.HighLevelError('GHL is down', 502));
    const { client, updated } = makeSb();
    sbRef.current = client;

    const res = await POST(makeReq(validBody()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(updated).toHaveLength(1);
    expect(updated[0]!.sync_status).toBeUndefined(); // never touched — stays 'pending' from the insert
    expect(updated[0]!.sync_error).toContain('GHL is down');
  });
});

describe('POST /api/leads — landscape deferred (case h)', () => {
  it('returns 200 ok; the row is marked deferred naming the missing env vars', async () => {
    const { client, updated } = makeSb();
    sbRef.current = client;

    const res = await POST(makeReq(validBody({ service: 'landscape' })));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(updated).toHaveLength(1);
    expect(updated[0]!.sync_status).toBe('deferred');
    expect(String(updated[0]!.sync_error)).toContain('HIGHLEVEL_PIPELINE_ID_LANDSCAPE');
    expect(hl.findOrCreateOpportunityForContact).not.toHaveBeenCalled();
  });
});

describe('POST /api/leads — name split (case j)', () => {
  it('"Mary Jane Van Der Berg" → firstName "Mary", lastName "Jane Van Der Berg"', async () => {
    sbRef.current = makeSb().client;
    await POST(makeReq(validBody({ name: 'Mary Jane Van Der Berg' })));
    expect(hl.upsertContact).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Mary', lastName: 'Jane Van Der Berg' }),
    );
  });
});

describe('POST /api/leads — CORS (case k)', () => {
  it('echoes Access-Control-Allow-Origin for a matching origin', async () => {
    sbRef.current = makeSb().client;
    const res = await POST(makeReq(validBody(), { origin: 'https://yulelovelights.com' }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://yulelovelights.com');
  });

  it('also echoes for the www subdomain', async () => {
    sbRef.current = makeSb().client;
    const res = await POST(makeReq(validBody(), { origin: 'https://www.yulelovelights.com' }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://www.yulelovelights.com');
  });

  it('sends no allow-origin header for a non-matching origin', async () => {
    sbRef.current = makeSb().client;
    const res = await POST(makeReq(validBody(), { origin: 'https://evil.example.com' }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('OPTIONS returns the preflight headers for a matching origin', async () => {
    const req = makeReq({}, { origin: 'https://yulelovelights.com' });
    const res = await OPTIONS(req);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://yulelovelights.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
});
