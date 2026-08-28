import { describe, it, expect, beforeEach, vi } from 'vitest';
import { type NextRequest } from 'next/server';

// Row 414 — the explicit staff override for the stale-invoice markers. The
// route's whole job is one atomic promise: the markers leave AND the audit
// entry naming who cleared them arrives, in the SAME snapshot write — or
// nothing happens at all. These tests run the REAL casSwapApprovalSnapshot
// against a fake that models PostgREST's serialized-filter comparison, so the
// concurrency is actually in the fixture (a mock that cannot lose a race
// proves nothing — the S51 lesson).

const { sbRef, requireOperatorMock, getOperatorMock, getInvoiceMock } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async (): Promise<unknown> => ({ id: 'op-1', email: 'jason@yulelovelights.com' })),
  getInvoiceMock: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
  getOperator: getOperatorMock,
}));
vi.mock('@/lib/invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/invoices')>();
  return { ...actual, getInvoice: getInvoiceMock };
});

import { POST } from './route';

const INVOICE_ID = '22222222-2222-4222-8222-222222222222';
const QUOTE_ID = '33333333-3333-4333-8333-333333333333';

const FROZEN = {
  currentTotalUsd: 7797.38,
  customerSelection: { depositRate: 0.4 },
  invoiceResyncFailed: { invoiceId: INVOICE_ID, attemptedTotal: 2400, at: '2026-08-01T00:00:00Z' },
};

type FakeRow = { id: string; approval_snapshot: unknown };

function makeFakeQuotes(row: FakeRow | null, opts: { readFails?: boolean } = {}) {
  const state = { snapshot: row?.approval_snapshot ?? null };
  const updates: Array<Record<string, unknown>> = [];
  let reads = 0;
  const hooks = { afterFirstRead: null as null | (() => void) };
  function from(table: string) {
    expect(table).toBe('quotes');
    const q = {
      op: 'select' as 'select' | 'update',
      payload: null as Record<string, unknown> | null,
      idMatch: true,
      casMatch: true,
    };
    const b = {
      select: () => b,
      update(payload: Record<string, unknown>) {
        q.op = 'update';
        q.payload = payload;
        return b;
      },
      eq(col: string, val: unknown) {
        if (col === 'id') q.idMatch = !!row && row.id === val;
        if (col === 'approval_snapshot')
          q.casMatch = typeof val === 'string' && JSON.stringify(state.snapshot) === val;
        return b;
      },
      async maybeSingle() {
        if (opts.readFails) return { data: null, error: { message: 'connection reset' } };
        const out = q.idMatch
          ? { data: { approval_snapshot: state.snapshot }, error: null }
          : { data: null, error: null };
        if (++reads === 1 && hooks.afterFirstRead) hooks.afterFirstRead();
        return out;
      },
      then(resolve: (v: unknown) => void) {
        if (q.op === 'update' && q.idMatch && q.casMatch) {
          updates.push(q.payload!);
          state.snapshot = (q.payload as { approval_snapshot: unknown }).approval_snapshot as
            | Record<string, unknown>
            | null;
          return resolve({ data: [{ id: row!.id }], error: null });
        }
        return resolve({ data: [], error: null });
      },
    };
    return b;
  }
  return { client: { from }, updates, state, hooks };
}

const req = () => ({}) as unknown as NextRequest;
const params = { params: Promise.resolve({ id: INVOICE_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorMock.mockResolvedValue({ id: 'op-1', email: 'jason@yulelovelights.com' });
  getInvoiceMock.mockResolvedValue({ id: INVOICE_ID, quote_id: QUOTE_ID, status: 'paid', balance: 0 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('POST /api/invoices/[id]/mark-reconciled (row 414)', () => {
  it('clears both markers and records who asserted it, in ONE atomic write', async () => {
    const fake = makeFakeQuotes({ id: QUOTE_ID, approval_snapshot: { ...FROZEN, paymentBlocked: { at: 'x' } } });
    sbRef.current = fake.client;
    const res = await POST(req(), params);
    expect(res.status).toBe(200);
    expect(fake.updates).toHaveLength(1);
    const written = fake.updates[0].approval_snapshot as Record<string, unknown>;
    // markers gone…
    expect(written.paymentBlocked).toBeUndefined();
    expect(written.invoiceResyncFailed).toBeUndefined();
    // …frozen agreement intact…
    expect(written.currentTotalUsd).toBe(7797.38);
    expect(written.customerSelection).toEqual({ depositRate: 0.4 });
    // …and the audit entry landed IN THE SAME write, naming the operator and
    // preserving the cleared payloads (the override must not destroy the only
    // record of what it overrode).
    const overrides = written.markerOverrides as Array<Record<string, unknown>>;
    expect(overrides).toHaveLength(1);
    expect(overrides[0].by).toBe('jason@yulelovelights.com');
    expect(overrides[0].action).toBe('mark-reconciled');
    expect((overrides[0].cleared as Record<string, unknown>).invoiceResyncFailed).toEqual(
      FROZEN.invoiceResyncFailed,
    );
  });

  it('409s no-markers when there is nothing to clear (the double-click case)', async () => {
    const fake = makeFakeQuotes({ id: QUOTE_ID, approval_snapshot: { currentTotalUsd: 100 } });
    sbRef.current = fake.client;
    const res = await POST(req(), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no-markers');
    expect(fake.updates).toHaveLength(0);
  });

  it('503s and writes NOTHING when the snapshot read fails — never coerces to {}', async () => {
    // The reviewed data-loss pattern (quoteAudit trap 2): an unconfirmed read
    // must stop the request, not become an empty object that replaces the
    // frozen agreement.
    const fake = makeFakeQuotes({ id: QUOTE_ID, approval_snapshot: FROZEN }, { readFails: true });
    sbRef.current = fake.client;
    const res = await POST(req(), params);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('read-failed');
    expect(fake.updates).toHaveLength(0);
  });

  it('409s concurrent-edit when the snapshot moved between read and write, changing nothing', async () => {
    // Real concurrency in the fixture: the CAS filter compares the serialized
    // snapshot, so a change landed after the route's read makes its write
    // claim zero rows — and the concurrent writer's snapshot must survive.
    const fake = makeFakeQuotes({ id: QUOTE_ID, approval_snapshot: FROZEN });
    fake.hooks.afterFirstRead = () => {
      fake.state.snapshot = { ...FROZEN, amendments: [{ reason: 'concurrent' }] };
    };
    sbRef.current = fake.client;
    const res = await POST(req(), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('concurrent-edit');
    expect((fake.state.snapshot as Record<string, unknown>).amendments).toEqual([
      { reason: 'concurrent' },
    ]);
  });

  it('409s no-quote for an invoice with no linked order', async () => {
    getInvoiceMock.mockResolvedValue({ id: INVOICE_ID, quote_id: null });
    sbRef.current = makeFakeQuotes(null).client;
    const res = await POST(req(), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no-quote');
  });

  it('404s an unknown invoice and 400s a malformed id', async () => {
    getInvoiceMock.mockResolvedValue(null);
    sbRef.current = makeFakeQuotes(null).client;
    expect((await POST(req(), params)).status).toBe(404);
    expect((await POST(req(), { params: Promise.resolve({ id: 'not-a-uuid' }) })).status).toBe(400);
  });
});
