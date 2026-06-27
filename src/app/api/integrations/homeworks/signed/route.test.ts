// Unit test for the home.works /signed webhook (audit fix: g21-route).
//
// Locks in the atomic idempotency guard: two concurrent signed deliveries for
// the same quote id must result in exactly ONE row stamp AND exactly ONE
// updateOpportunityStage call — the loser of the claim race short-circuits.
// Supabase + HighLevel are mocked; no DB or network.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// ── Mocks (hoisted so the vi.mock factories can see them) ───────────────────
const { sbRef, hl } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  hl: {
    updateOpportunityStage: vi.fn(async () => ({})),
    configured: { value: true },
  },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  // Each call returns a FRESH builder (a new client per request) so the two
  // concurrent POSTs don't share mutable chain state — the only shared state is
  // the `claimed` flag captured by makeSb, modeling the single DB row.
  getSupabaseServiceClient: () => (sbRef.current as () => unknown)(),
}));

vi.mock('@/lib/integrations/highlevel', () => ({
  updateOpportunityStage: hl.updateOpportunityStage,
  isHighLevelConfigured: () => hl.configured.value,
  HighLevelError: class HighLevelError extends Error {},
}));

// Rate limiter is a no-op here — we want to exercise the DB claim race.
vi.mock('@/lib/rateLimit', () => ({
  rateLimitResponse: () => null,
}));

import { POST } from './route';

// ── Fake Supabase query builder ─────────────────────────────────────────────
// Handles two chains the route uses:
//   read:  from().select().eq().single()                  -> { data: quote }
//   write: from().update().eq().is().select('id')         -> { data: claimRows }
// The builder is thenable; only the write path awaits it directly, so `then`
// resolves the claim result while `single()` resolves the read.
//
// `claimOnce` models the atomic UPDATE ... WHERE homeworks_signed_at IS NULL:
// the FIRST write claims the row (returns [{id}]); every subsequent write loses
// the race (returns []), exactly as Postgres would under concurrent retries.
type Quote = Record<string, unknown> | null;
function makeSb(quote: Quote) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  // Shared across every builder instance — models the single DB row. The first
  // conditional UPDATE claims it; later ones return 0 rows (race lost).
  let claimed = false;

  function newClient() {
    const builder: Record<string, unknown> = {};
    let isUpdate = false;
    Object.assign(builder, {
      from: () => builder,
      select: () => builder,
      update: (payload: Record<string, unknown>) => {
        isUpdate = true;
        updatePayloads.push(payload);
        return builder;
      },
      eq: () => builder,
      is: () => builder,
      single: async () => ({ data: quote, error: quote ? null : { message: 'no row' } }),
      then: (resolve: (v: unknown) => void) => {
        if (isUpdate) {
          isUpdate = false;
          const rows = claimed ? [] : [{ id: (quote as { id?: string })?.id ?? 'q1' }];
          claimed = true;
          resolve({ data: rows, error: null });
        } else {
          resolve({ data: quote, error: null });
        }
      },
    });
    return builder;
  }

  return { factory: newClient, updatePayloads };
}

const QUOTE_ID = '11111111-1111-4111-8111-111111111111';
const QUOTE = {
  id: QUOTE_ID,
  highlevel_opportunity_id: 'opp-1',
  homeworks_signed_at: null,
  homeworks_contract_id: null,
  customer_approved_at: null,
};

function makeReq(body: Record<string, unknown>): NextRequest {
  return {
    json: async () => body,
    headers: { get: (k: string) => (k.toLowerCase() === 'x-homeworks-secret' ? 'test-secret' : null) },
    url: 'https://quote.example.com/api/integrations/homeworks/signed',
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  hl.configured.value = true;
  process.env.HOMEWORKS_SIGNED_SECRET = 'test-secret';
  process.env.HIGHLEVEL_STAGE_QUOTE_SIGNED = 'stage-signed';
});

describe('home.works /signed — atomic idempotency', () => {
  it('two concurrent deliveries: exactly one stamps and one fires the stage move', async () => {
    // Both requests read the same not-yet-signed quote (the read short-circuit
    // misses for both), then race on the conditional UPDATE.
    const { factory, updatePayloads } = makeSb({ ...QUOTE });
    sbRef.current = factory;

    const [r1, r2] = await Promise.all([
      POST(makeReq({ quoteId: QUOTE_ID })),
      POST(makeReq({ quoteId: QUOTE_ID })),
    ]);
    const [j1, j2] = await Promise.all([r1.json(), r2.json()]);

    // Exactly one winner advanced the HL stage.
    expect(hl.updateOpportunityStage).toHaveBeenCalledTimes(1);
    expect(hl.updateOpportunityStage).toHaveBeenCalledWith('opp-1', 'stage-signed');

    // Exactly one response reports stageUpdated; the other is alreadySigned.
    const updated = [j1, j2].filter(j => j.stageUpdated === true);
    const already = [j1, j2].filter(j => j.alreadySigned === true);
    expect(updated).toHaveLength(1);
    expect(already).toHaveLength(1);

    // Both attempted the conditional stamp, but only one claimed the row.
    expect(updatePayloads.length).toBe(2);
  });

  it('rejects a request with the wrong secret (constant-time compare path)', async () => {
    const { factory } = makeSb({ ...QUOTE });
    sbRef.current = factory;

    const badReq = {
      json: async () => ({ quoteId: QUOTE_ID }),
      headers: { get: (k: string) => (k.toLowerCase() === 'x-homeworks-secret' ? 'wrong' : null) },
      url: 'https://quote.example.com/api/integrations/homeworks/signed',
    } as unknown as NextRequest;

    const res = await POST(badReq);
    expect(res.status).toBe(401);
    expect(hl.updateOpportunityStage).not.toHaveBeenCalled();
  });
});
