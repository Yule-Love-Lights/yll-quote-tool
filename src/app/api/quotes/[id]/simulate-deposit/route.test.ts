// Tests for the operator-gated simulate-deposit route (#93). It must: gate on
// requireOperator, REFUSE a non-test quote (400), require approval (409), be
// idempotent when already paid, and on success atomically book + auto-create the
// Job (createJobFromQuote). Auth, Supabase, and the jobs layer are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { requireOperatorMock, createJobFromQuote } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  createJobFromQuote: vi.fn(async () => ({ id: 'job-1' })),
}));

let quoteRow: Record<string, unknown> | null = null;
let claimWins = true;

function makeSb() {
  return {
    from() {
      const state = { op: 'select' as 'select' | 'update' };
      const b = {
        select: () => b,
        update: () => {
          state.op = 'update';
          return b;
        },
        eq: () => b,
        is: () => b,
        single: async () => ({ data: quoteRow, error: quoteRow ? null : { message: 'no row' } }),
        then: (resolve: (v: unknown) => void) =>
          resolve(
            state.op === 'update'
              ? { data: claimWins ? [{ id: 'q' }] : [], error: null }
              : { data: quoteRow, error: null },
          ),
      };
      return b;
    },
  };
}

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => makeSb(),
}));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/jobs', () => ({ createJobFromQuote }));

import { POST } from './route';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

function makeReq(): NextRequest {
  return {} as unknown as NextRequest;
}
function ctx() {
  return { params: Promise.resolve({ id: ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  claimWins = true;
  quoteRow = {
    id: ID,
    is_test: true,
    customer_approved_at: '2026-06-28T00:00:00Z',
    deposit_paid_at: null,
    deposit_amount_usd: 500,
    approval_snapshot: { customerSelection: { currentDepositUsd: 500 } },
  };
});

describe('POST /api/quotes/[id]/simulate-deposit (#93)', () => {
  it('returns the gate response (401) when the operator gate denies — no job created', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(401);
    expect(createJobFromQuote).not.toHaveBeenCalled();
  });

  it('400s and creates no job for a NON-test quote', async () => {
    quoteRow = { ...quoteRow, is_test: false };
    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('not-test');
    expect(createJobFromQuote).not.toHaveBeenCalled();
  });

  it('409s when the test quote is not yet approved', async () => {
    quoteRow = { ...quoteRow, customer_approved_at: null };
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(409);
    expect(createJobFromQuote).not.toHaveBeenCalled();
  });

  it('books + auto-creates the Job for an approved, unpaid test quote', async () => {
    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, booked: true, simulated: true });
    expect(createJobFromQuote).toHaveBeenCalledWith(ID);
  });

  it('is idempotent — already paid returns alreadyPaid and creates no new job', async () => {
    quoteRow = { ...quoteRow, deposit_paid_at: '2026-06-28T01:00:00Z' };
    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.alreadyPaid).toBe(true);
    expect(createJobFromQuote).not.toHaveBeenCalled();
  });

  it('does not create a job when it loses the atomic claim (concurrent click)', async () => {
    claimWins = false;
    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.alreadyPaid).toBe(true);
    expect(createJobFromQuote).not.toHaveBeenCalled();
  });
});
