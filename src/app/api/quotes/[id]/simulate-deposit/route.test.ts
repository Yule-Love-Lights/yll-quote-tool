// Tests for the simulate-deposit route (#93 / #81 W6-008). This route is
// reachable by an UNAUTHENTICATED customer-portal caller (capability-token auth
// model, same as /approve and /pay — no requireOperator call) so the is_test
// check IS the security boundary: it must REFUSE a non-test quote (403) before
// anything else runs, so an anon caller can only ever affect a test quote. Also:
// require approval (409), be idempotent when already paid, and on success
// atomically book + auto-create the Job (createJobFromQuote). Supabase and the
// jobs layer are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { type NextRequest } from 'next/server';

const { createJobFromQuote, accrueOnBooking, ensureReferralCode, pushTenureYearsToGhl } = vi.hoisted(() => ({
  createJobFromQuote: vi.fn(async () => ({ id: 'job-1' })),
  accrueOnBooking: vi.fn(async () => ({ accrued: false })),
  ensureReferralCode: vi.fn(async () => 'CODE1234'),
  pushTenureYearsToGhl: vi.fn(async () => ({ pushed: false })),
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
        or: () => b, // #124: booking-write status guard clause
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
vi.mock('@/lib/jobs', () => ({ createJobFromQuote }));
vi.mock('@/lib/referrals', () => ({ accrueOnBooking, ensureReferralCode }));
vi.mock('@/lib/integrations/ghlTenure', () => ({ pushTenureYearsToGhl }));

import { POST } from './route';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeReq(): NextRequest {
  return {} as unknown as NextRequest;
}
function ctx() {
  return { params: Promise.resolve({ id: ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  claimWins = true;
  quoteRow = {
    id: ID,
    is_test: true,
    customer_approved_at: '2026-06-28T00:00:00Z',
    deposit_paid_at: null,
    deposit_amount_usd: 500,
    approval_snapshot: { customerSelection: { currentDepositUsd: 500 } },
    customer_id: null,
  };
});

describe('POST /api/quotes/[id]/simulate-deposit (#93)', () => {
  it('#81 W6-008: refuses (403) an anonymous caller on a NON-test (real) quote — creates no job', async () => {
    // This route has no requireOperator call — the is_test check is the only
    // thing standing between an anonymous portal caller and a real quote.
    quoteRow = { ...quoteRow, is_test: false };
    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.code).toBe('not-test');
    expect(createJobFromQuote).not.toHaveBeenCalled();
  });

  it('409s when the test quote is not yet approved', async () => {
    quoteRow = { ...quoteRow, customer_approved_at: null };
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(409);
    expect(createJobFromQuote).not.toHaveBeenCalled();
  });

  it('#124: 409s when a test quote was DECLINED after approval (status=declined) — never re-books a dead quote', async () => {
    // approved→declined is legal (#124); a declined quote keeps customer_approved_at
    // (passing the approve gate) with deposit unpaid. The deriveStatus guard blocks it.
    quoteRow = { ...quoteRow, status: 'declined' };
    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('not-bookable');
    expect(createJobFromQuote).not.toHaveBeenCalled();
  });

  it('books + auto-creates the Job for an approved, unpaid test quote', async () => {
    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, booked: true, simulated: true });
    expect(createJobFromQuote).toHaveBeenCalledWith(ID);
    // #41 referral program: the simulated booking event fires the accrual too
    // (mirrors the real Valor webhook path this route is built to mirror).
    expect(accrueOnBooking).toHaveBeenCalledWith(ID);
  });

  it('still books even if the referral accrual throws (fail-open, #41)', async () => {
    accrueOnBooking.mockRejectedValueOnce(new Error('referrals table missing'));
    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, booked: true, simulated: true });
  });

  // #41 PR 2: stamp-at-booking — every future customer gets their referral
  // link live in GHL from the moment they book, not only when they later
  // view the booked page.
  it('stamps the referral code for the quote\'s OWN linked customer on booking', async () => {
    quoteRow = { ...quoteRow, customer_id: 'cust-1' };
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(200);
    expect(ensureReferralCode).toHaveBeenCalledWith('cust-1');
  });

  it('skips the referral code stamp when the quote has no linked customer (typical for a test quote)', async () => {
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(200);
    expect(ensureReferralCode).not.toHaveBeenCalled();
  });

  it('still books even if the referral code stamp throws (fail-open, #41 PR 2)', async () => {
    quoteRow = { ...quoteRow, customer_id: 'cust-1' };
    ensureReferralCode.mockRejectedValueOnce(new Error('referrals table missing'));
    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, booked: true, simulated: true });
  });

  // #200: GHL tenure mirror — wired for parity with the other two booking
  // sites, though a test quote's customer_id is normally null in practice.
  it('pushes the GHL tenure mirror for the quote\'s OWN linked customer on booking', async () => {
    quoteRow = { ...quoteRow, customer_id: 'cust-1' };
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(200);
    expect(pushTenureYearsToGhl).toHaveBeenCalledWith('cust-1');
  });

  it('skips the GHL tenure push when the quote has no linked customer (typical for a test quote)', async () => {
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(200);
    expect(pushTenureYearsToGhl).not.toHaveBeenCalled();
  });

  it('still books even if the GHL tenure push throws (fail-open, #200)', async () => {
    quoteRow = { ...quoteRow, customer_id: 'cust-1' };
    pushTenureYearsToGhl.mockRejectedValueOnce(new Error('GHL down'));
    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, booked: true, simulated: true });
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
