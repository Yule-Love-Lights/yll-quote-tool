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
// The route does a single write chain: from().update().eq() and awaits it.
// `updateErr` controls whether that write reports a failure.
function makeSb(updateErr: { message: string } | null) {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    update: () => builder,
    eq: async () => ({ error: updateErr }),
  });
  return builder;
}

const QUOTE_ID = '11111111-2222-4333-8444-555555555555';

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
    sbRef.current = makeSb(null);

    const res = await POST(makeReq({ quoteId: QUOTE_ID, contactId: 'contact-1' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.opportunityId).toBe('opp-1');
    expect(json.linked).toBe(true);
  });
});

describe('HighLevel attach — write-back failure (the fix #53)', () => {
  it('returns 200 with linked:false and logs an error naming quoteId + opportunityId', async () => {
    sbRef.current = makeSb({ message: 'db down' });
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
