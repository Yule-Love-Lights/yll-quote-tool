// Tests for POST /api/quotes/[id]/free-items (ledger #162). Operator-gated. Adds
// or removes a $0 free line item on an APPROVED / BOOKED quote's selection and
// appends a ZERO-DELTA amendment-trail entry. The auth gate + Supabase are
// mocked; freeItemEdit.ts + amend.ts (computeAmendment) run for real — the
// total-invariant is what we verify.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';
import { calculateQuote, type QuoteInputs } from '@/lib/pricing/pricingEngine';
import { buildPortalLineItems } from '@/lib/portal/adapter';

const { sbRef, requireOperatorMock, getOperatorMock } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
  getSupabaseClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
  getOperator: getOperatorMock,
}));

import { POST } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const req = (body: unknown) =>
  ({ json: async () => body, nextUrl: { origin: 'https://test.local' } }) as unknown as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

function emptyInputs(overrides: Partial<QuoteInputs> = {}): QuoteInputs {
  return {
    santasFootage: 0,
    santasDifficulty: 'medium',
    gingerbreadFootage: 0,
    gingerbreadDifficulty: 'medium',
    winterWonderlandFootage: 0,
    winterWonderlandDifficulty: 'medium',
    stakeLightingFootage: 0,
    stakeLightingDifficulty: 'medium',
    miniLightItems: [],
    spritzers: [],
    wreaths: [],
    garland: [],
    takedown: 'included',
    rushFee: false,
    ...overrides,
  };
}

type Row = Record<string, unknown>;
// `single()` serves the initial load; `maybeSingle()` serves the concurrency re-read.
function makeSb(
  quote: Row | null,
  fresh: Row | null = quote,
  updatedRows: unknown[] = [{ id: ID }],
) {
  const updates: { quotes: Row[] } = { quotes: [] };
  const eqCalls: Array<[string, unknown]> = [];
  let table = '';
  let updating = false;
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: (t: string) => {
      table = t;
      return b;
    },
    select: () => b,
    update: (payload: Row) => {
      updating = true;
      (updates as Record<string, Row[]>)[table].push(payload);
      return b;
    },
    eq: (column: string, value: unknown) => {
      eqCalls.push([column, value]);
      return b;
    },
    single: async () => ({ data: quote, error: quote ? null : { message: 'no rows' } }),
    maybeSingle: async () => ({ data: fresh, error: null }),
    then: (resolve: (v: unknown) => void) => {
      const value = updating ? { data: updatedRows, error: null } : { data: null, error: null };
      updating = false;
      resolve(value);
    },
  });
  return { client: b, updates, eqCalls };
}

function approvedQuote(overrides: Row = {}) {
  const inputs = emptyInputs({ santasFootage: 200, santasDifficulty: 'medium' }); // $2,000
  const result = calculateQuote(inputs);
  const { lineItems } = buildPortalLineItems(result, inputs);
  const selectedItemIds = lineItems.map((li) => li.id);
  return {
    id: ID,
    status: 'booked',
    customer_approved_at: '2026-01-01T00:00:00Z',
    deposit_paid_at: '2026-01-02T00:00:00Z',
    deposit_amount_usd: result.total / 2,
    total: result.total,
    result,
    inputs,
    approval_snapshot: {
      customerSelection: {
        packageId: 'C',
        selectedItemIds,
        currentTotalUsd: result.total,
        currentDepositUsd: result.total / 2,
      },
      amendments: [],
      pricing: { total: result.total },
    },
    customer_name: 'Test Person',
    is_test: true,
    ...overrides,
    __selectedItemIds: selectedItemIds,
    __result: result,
    __inputs: inputs,
  } as Row;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getOperatorMock.mockResolvedValue({ name: 'naldo' });
  sbRef.current = null;
});

describe('POST /api/quotes/[id]/free-items', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(req({ action: 'add', label: 'Free spritzers' }), ctx());
    expect(res.status).toBe(401);
  });

  it('409s when the quote is not yet approved (no selection to edit)', async () => {
    const draft = approvedQuote({ customer_approved_at: null, status: 'sent', approval_snapshot: null });
    sbRef.current = makeSb(draft).client;
    const res = await POST(req({ action: 'add', label: 'Free spritzers' }), ctx());
    expect(res.status).toBe(409);
  });

  it('400s when adding without a label', async () => {
    sbRef.current = makeSb(approvedQuote()).client;
    const res = await POST(req({ action: 'add', label: '   ' }), ctx());
    expect(res.status).toBe(400);
  });

  it('adds a $0 free item: grows the selection, appends a ZERO-delta amendment, leaves total unchanged', async () => {
    const quote = approvedQuote();
    const before = (quote.__selectedItemIds as string[]).length;
    const { client, updates } = makeSb(quote);
    sbRef.current = client;

    const res = await POST(req({ action: 'add', label: 'Free spritzers', quantity: 2 }), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe('add');
    expect(typeof body.portalId).toBe('string');

    expect(updates.quotes).toHaveLength(1);
    const payload = updates.quotes[0] as {
      approval_snapshot: {
        customerSelection: { selectedItemIds: string[]; currentTotalUsd: number };
        amendments: Array<{ delta: number }>;
      };
      result: { total: number; lineItems: unknown[] };
      inputs: { customLineItems: Array<{ amount: number }> };
    };
    // selection grew by the one $0 line
    expect(payload.approval_snapshot.customerSelection.selectedItemIds).toHaveLength(before + 1);
    // a zero-delta amendment was appended
    expect(payload.approval_snapshot.amendments).toHaveLength(1);
    expect(payload.approval_snapshot.amendments[0].delta).toBe(0);
    // money is invariant
    expect(payload.result.total).toBe((quote.__result as { total: number }).total);
    expect(payload.approval_snapshot.customerSelection.currentTotalUsd).toBe(
      (quote.__result as { total: number }).total,
    );
    // the $0 custom line was recorded on inputs
    expect(payload.inputs.customLineItems.some((c) => c.amount === 0)).toBe(true);
  });

  it('removes a $0 free item added earlier', async () => {
    // Seed a quote that already carries a $0 free line in its selection.
    const inputs = emptyInputs({
      santasFootage: 200,
      santasDifficulty: 'medium',
      customLineItems: [{ id: 'free-x', label: 'Free spritzers', amount: 0, quantity: 2 }],
    });
    const result = calculateQuote(inputs);
    const { lineItems } = buildPortalLineItems(result, inputs);
    const freeLine = lineItems.find((li) => li.stableId === 'free-x')!;
    const selectedItemIds = lineItems.map((li) => li.id);
    const quote = {
      ...approvedQuote(),
      inputs,
      result,
      approval_snapshot: {
        customerSelection: { packageId: 'C', selectedItemIds, currentTotalUsd: result.total },
        amendments: [],
        pricing: { total: result.total },
      },
    } as Row;
    const { client, updates } = makeSb(quote);
    sbRef.current = client;

    const res = await POST(req({ action: 'remove', portalId: freeLine.id }), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const payload = updates.quotes[0] as {
      approval_snapshot: { customerSelection: { selectedItemIds: string[] } };
    };
    expect(payload.approval_snapshot.customerSelection.selectedItemIds).not.toContain(freeLine.id);
  });

  it('records the zero-delta entry against the CURRENT agreed total after a prior amend (not the stale approval total)', async () => {
    // A quote already amended UP to +$1,000 via the real amend flow. A later
    // free-item edit must anchor its zero-delta entry to the running agreed total
    // (the last amendment's new_total), NOT the frozen approval currentTotalUsd —
    // otherwise resolveAgreedTotal would read the stale lower figure and the next
    // amend/settlement would mis-bill.
    const inputs = emptyInputs({ santasFootage: 200, santasDifficulty: 'medium' });
    const result = calculateQuote(inputs);
    const { lineItems } = buildPortalLineItems(result, inputs);
    const selectedItemIds = lineItems.map((li) => li.id);
    const runningTotal = result.total + 1000;
    const priorAmend = {
      amended_at: '2026-01-03T00:00:00Z',
      by: 'staff',
      reason: 'added a wreath',
      previous_total: result.total,
      new_total: runningTotal,
      previous_balance: 0,
      new_balance: 0,
      deposit_applied: result.total / 2,
      delta: 1000,
      line_item_changes: [],
    };
    const quote = {
      ...approvedQuote(),
      inputs,
      result,
      approval_snapshot: {
        customerSelection: { packageId: 'C', selectedItemIds, currentTotalUsd: result.total },
        amendments: [priorAmend],
        pricing: { total: result.total },
      },
    } as Row;
    const { client, updates } = makeSb(quote);
    sbRef.current = client;

    const res = await POST(req({ action: 'add', label: 'Free spritzers' }), ctx());
    expect(res.status).toBe(200);
    const payload = updates.quotes[0] as {
      approval_snapshot: { amendments: Array<{ delta: number; previous_total: number; new_total: number }> };
    };
    expect(payload.approval_snapshot.amendments).toHaveLength(2);
    const appended = payload.approval_snapshot.amendments[1];
    expect(appended.delta).toBe(0);
    expect(appended.new_total).toBe(runningTotal);
    expect(appended.previous_total).toBe(runningTotal);
  });

  it('is idempotent under a repeated add (retry) — no second line, no second amendment', async () => {
    // The free line is already persisted + selected. An identical re-POST (a
    // double-click / retry) must be a pure no-op: no DB write at all.
    const inputs = emptyInputs({
      santasFootage: 200,
      santasDifficulty: 'medium',
      customLineItems: [{ id: 'free-x', label: 'Free spritzers', amount: 0, quantity: 1 }],
    });
    const result = calculateQuote(inputs);
    const { lineItems } = buildPortalLineItems(result, inputs);
    const selectedItemIds = lineItems.map((li) => li.id);
    const quote = {
      ...approvedQuote(),
      inputs,
      result,
      approval_snapshot: {
        customerSelection: { packageId: 'C', selectedItemIds, currentTotalUsd: result.total },
        amendments: [],
        pricing: { total: result.total },
      },
    } as Row;
    const { client, updates } = makeSb(quote);
    sbRef.current = client;

    const res = await POST(req({ action: 'add', label: 'Free spritzers', quantity: 1 }), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.alreadyPresent).toBe(true);
    expect(updates.quotes).toHaveLength(0); // no write on a no-op
  });

  it('409s an atomic compare-and-swap loss instead of overwriting a concurrent amendment', async () => {
    const quote = approvedQuote();
    const { client, updates, eqCalls } = makeSb(quote, quote, []);
    sbRef.current = client;

    const res = await POST(req({ action: 'add', label: 'Free spritzers' }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('concurrent-edit');
    expect(updates.quotes).toHaveLength(1);
    expect(eqCalls).toContainEqual([
      'approval_snapshot',
      JSON.stringify(quote.approval_snapshot),
    ]);
  });

  it('409s when trying to remove a priced (non-$0) line', async () => {
    const quote = approvedQuote();
    const priced = buildPortalLineItems(
      quote.__result as never,
      quote.__inputs as never,
    ).lineItems.find((li) => li.price > 0)!;
    sbRef.current = makeSb(quote).client;
    const res = await POST(req({ action: 'remove', portalId: priced.id }), ctx());
    expect(res.status).toBe(409);
  });
});
