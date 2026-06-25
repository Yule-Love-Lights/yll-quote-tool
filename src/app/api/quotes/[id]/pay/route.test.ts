// Tests for the deposit /pay endpoint (#38, hosted-page flow). The card never
// touches our server, so the only logic to prove here is the GUARDS + that the
// deposit amount comes from the frozen approval snapshot (never the client) +
// the return URLs point back at this quote. Supabase + the Valor client mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { sbRef, valor } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  valor: {
    createHostedPageSale: vi.fn(async () => ({
      url: 'https://securelink.valorpaytech.com/hosted/abc123',
      uid: 'uid_1',
      raw: {},
    })),
    configured: { value: true },
  },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

vi.mock('@/lib/integrations/valor', () => ({
  createHostedPageSale: valor.createHostedPageSale,
  isValorConfigured: () => valor.configured.value,
  ValorError: class ValorError extends Error {},
}));

import { POST } from './route';

// Fake Supabase builder: read = from().select().eq().single(); the order-ref
// stamp = from().update().eq() (awaited). Thenable resolves the stamp.
type Quote = Record<string, unknown> | null;
function makeSb(quote: Quote, stampError: { message: string } | null = null) {
  const updatePayloads: Array<Record<string, unknown>> = [];
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
    single: async () => ({ data: quote, error: quote ? null : { message: 'no row' } }),
    then: (resolve: (v: unknown) => void) => {
      const res = isUpdate ? { error: stampError } : { data: quote, error: null };
      isUpdate = false;
      resolve(res);
    },
  });
  return { client: builder, updatePayloads };
}

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeReq(): NextRequest {
  return {
    headers: { get: () => null },
    nextUrl: { origin: 'https://quote.example.com' },
  } as unknown as NextRequest;
}
const params = Promise.resolve({ id: ID });

const APPROVED_QUOTE = {
  id: ID,
  customer_name: 'Jordan Smith',
  customer_email: 'jordan@example.com',
  customer_approved_at: '2026-06-25T00:00:00Z',
  deposit_paid_at: null,
  valor_order_ref: null,
  approval_snapshot: { customerSelection: { currentDepositUsd: 1350 } },
};

beforeEach(() => {
  vi.clearAllMocks();
  valor.configured.value = true;
  process.env.VALOR_IS_DEMO = 'false';
});

describe('POST /api/quotes/[id]/pay', () => {
  it('returns a hosted-page URL for the snapshot deposit amount (never the client)', async () => {
    const { client, updatePayloads } = makeSb({ ...APPROVED_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.redirectUrl).toBe('https://securelink.valorpaytech.com/hosted/abc123');
    expect(json.amountUsd).toBe(1350);
    expect(json.orderRef).toMatch(/^q[0-9a-f]{16}$/);
    // amount handed to Valor came from the snapshot, not the request body; the
    // success/failure return URLs point back at this quote's pages
    expect(valor.createHostedPageSale).toHaveBeenCalledWith(
      expect.objectContaining({
        amountUsd: 1350,
        successUrl: `https://quote.example.com/portal/${ID}/approved`,
        failureUrl: `https://quote.example.com/portal/${ID}`,
      }),
    );
    // order ref + intended amount stamped before we send them to the hosted page
    expect(updatePayloads[0]).toMatchObject({ deposit_amount_usd: 1350 });
    expect(updatePayloads[0].valor_order_ref).toMatch(/^q[0-9a-f]{16}$/);
  });

  it('reuses an existing order ref so the webhook mapping stays stable', async () => {
    const { client } = makeSb({ ...APPROVED_QUOTE, valor_order_ref: 'qexisting00000000' });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();
    expect(json.orderRef).toBe('qexisting00000000');
  });

  it('503s when Valor is not configured', async () => {
    valor.configured.value = false;
    const { client } = makeSb({ ...APPROVED_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();
    expect(res.status).toBe(503);
    expect(json.code).toBe('valor-not-configured');
  });

  it('409s when the deposit is already paid', async () => {
    const { client } = makeSb({ ...APPROVED_QUOTE, deposit_paid_at: '2026-06-25T01:00:00Z' });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('already-paid');
    expect(valor.createHostedPageSale).not.toHaveBeenCalled();
  });

  it('409s when the quote has not been approved yet (no snapshot deposit)', async () => {
    const { client } = makeSb({
      ...APPROVED_QUOTE,
      customer_approved_at: null,
      approval_snapshot: null,
    });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('approve-first');
    expect(valor.createHostedPageSale).not.toHaveBeenCalled();
  });

  it('404s when the quote does not exist', async () => {
    const { client } = makeSb(null);
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(404);
  });
});
