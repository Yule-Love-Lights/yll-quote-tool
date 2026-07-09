// Unit test for the HighLevel attach route (Audit fix #53). Locks in the
// "card created but not linked" contract: when the GHL opportunity is
// found/created but the local quotes-row write-back fails, the route must
// still return 200 BUT report `linked:false` (so the operator UI can offer a
// safe retry) and emit a console.error naming the quoteId + opportunityId so
// the orphaned GHL card is discoverable. On a clean write-back, `linked:true`.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// ── Mocks (hoisted so the vi.mock factories can see them) ───────────────────
const { sbRef, hl } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  hl: {
    findOrCreate: vi.fn(async () => ({ opportunity: { id: 'opp-1' }, created: false })),
  },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

vi.mock('@/lib/integrations/highlevel', () => ({
  findOrCreateOpportunityForContact: hl.findOrCreate,
  isHighLevelConfigured: () => true,
  HighLevelError: class HighLevelError extends Error {},
}));

// Rate limiter is a no-op in tests (never trips at this volume).
vi.mock('@/lib/rateLimit', () => ({
  rateLimitResponse: () => null,
}));

import { POST } from './route';

// ── Fake Supabase query builder ─────────────────────────────────────────────
// The route now does two chains:
//   read:  from('quotes').select().eq().maybeSingle()  → the quote row
//          (service_type drives the per-type pipeline resolution)
//   write: from().update().eq() awaited                → { error: updateErr }
function makeSb(
  quote: Record<string, unknown> | null,
  updateErr: { message: string } | null = null,
) {
  let isUpdate = false;
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    update: () => {
      isUpdate = true;
      return builder;
    },
    eq: () => {
      if (isUpdate) {
        isUpdate = false;
        return Promise.resolve({ error: updateErr });
      }
      return builder;
    },
    maybeSingle: async () => ({ data: quote, error: null }),
  });
  return builder;
}

const QUOTE_ID = '11111111-2222-4333-8444-555555555555';
const HOLIDAY_QUOTE = { id: QUOTE_ID, service_type: 'holiday' };

function makeReq(body: unknown): NextRequest {
  return {
    json: async () => body,
    headers: { get: () => null },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  hl.findOrCreate.mockResolvedValue({ opportunity: { id: 'opp-1' }, created: false });
  process.env.HIGHLEVEL_PIPELINE_ID = 'pipe-1';
  process.env.HIGHLEVEL_STAGE_QUOTE_CREATED = 'stage-created';
});

describe('HighLevel attach — write-back success', () => {
  it('returns 200 with linked:true when the quote row updates cleanly', async () => {
    sbRef.current = makeSb(HOLIDAY_QUOTE, null);

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.opportunityId).toBe('opp-1');
    expect(json.linked).toBe(true);
  });
});

describe('HighLevel attach — per-service-type pipeline (#GHL pipeline sync)', () => {
  it('a holiday quote still honors the legacy env vars (pipeline + entry stage)', async () => {
    sbRef.current = makeSb(HOLIDAY_QUOTE, null);

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    expect(res.status).toBe(200);
    expect(hl.findOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: 'pipe-1', // HIGHLEVEL_PIPELINE_ID
        fallbackStageId: 'stage-created', // HIGHLEVEL_STAGE_QUOTE_CREATED
      }),
    );
  });

  it('a PERMANENT quote lands in the permanent pipeline at its "New Lead" entry stage, ignoring env vars', async () => {
    sbRef.current = makeSb({ id: QUOTE_ID, service_type: 'permanent' }, null);

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    expect(res.status).toBe(200);
    expect(hl.findOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: 'OqpjVflTdgmjmUQmbcSF',
        fallbackStageId: 'c052d345-8e95-4716-a7e7-62e63937b5ea', // New Lead
      }),
    );
  });

  it('an EVENT quote lands in the event pipeline at its "Open" entry stage', async () => {
    sbRef.current = makeSb({ id: QUOTE_ID, service_type: 'event' }, null);

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    expect(res.status).toBe(200);
    expect(hl.findOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: 'YfCi5jy8Alc3oD5AfXmV',
        fallbackStageId: 'c6e089f5-c458-47a0-a7ae-25385df6a53f', // Open
      }),
    );
  });

  it('a quote whose row cannot be read defaults to the holiday pipeline (fail-open)', async () => {
    sbRef.current = makeSb(null, null); // maybeSingle → no row

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    expect(res.status).toBe(200);
    expect(hl.findOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ pipelineId: 'pipe-1', fallbackStageId: 'stage-created' }),
    );
  });
});

describe('HighLevel attach — write-back failure (the fix #53)', () => {
  it('returns 200 with linked:false and logs an error naming quoteId + opportunityId', async () => {
    sbRef.current = makeSb(HOLIDAY_QUOTE, { message: 'db down' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    const json = await res.json();

    // Still a 200 — the GHL card exists; retry is safe and re-attaches.
    expect(res.status).toBe(200);
    expect(json.opportunityId).toBe('opp-1');
    expect(json.linked).toBe(false);

    // The orphan must be discoverable in the logs.
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errSpy.mock.calls[0]);
    expect(logged).toContain(QUOTE_ID);
    expect(logged).toContain('opp-1');

    errSpy.mockRestore();
  });
});
