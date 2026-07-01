// Tests for GET /api/invoices/[id] (#83 billing invoice detail).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { getInvoiceDetail, setInvoiceTaxOverride, requireOperatorMock } = vi.hoisted(() => ({
  getInvoiceDetail: vi.fn(),
  setInvoiceTaxOverride: vi.fn(),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/invoices', () => ({ getInvoiceDetail, setInvoiceTaxOverride }));

import { GET, PATCH } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const req = {} as NextRequest;
const patchReq = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getInvoiceDetail.mockResolvedValue({ invoice: { id: ID, status: 'draft' }, jobNumber: 1000 });
  setInvoiceTaxOverride.mockResolvedValue({ id: ID, tax: 0, total: 4500, tax_overridden: true });
});

describe('GET /api/invoices/[id]', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await GET(req, ctx());
    expect(res.status).toBe(401);
    expect(getInvoiceDetail).not.toHaveBeenCalled();
  });

  it('400s on an invalid invoice id', async () => {
    const res = await GET(req, ctx('nope'));
    expect(res.status).toBe(400);
  });

  it('404s when the invoice is missing', async () => {
    getInvoiceDetail.mockResolvedValueOnce(null);
    const res = await GET(req, ctx());
    expect(res.status).toBe(404);
  });

  it('returns the detail when authorized', async () => {
    const res = await GET(req, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.invoice).toMatchObject({ id: ID });
  });
});

describe('PATCH /api/invoices/[id] — tax override', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await PATCH(patchReq({ taxOverridden: true }), ctx());
    expect(res.status).toBe(401);
    expect(setInvoiceTaxOverride).not.toHaveBeenCalled();
  });

  it('400s when taxOverridden is not a boolean', async () => {
    const res = await PATCH(patchReq({ taxOverridden: 'yes' }), ctx());
    expect(res.status).toBe(400);
    expect(setInvoiceTaxOverride).not.toHaveBeenCalled();
  });

  it('toggles the override when authorized', async () => {
    const res = await PATCH(patchReq({ taxOverridden: true }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(setInvoiceTaxOverride).toHaveBeenCalledWith(ID, true);
    expect(json.invoice).toMatchObject({ tax_overridden: true });
  });

  it('404s when the invoice is missing', async () => {
    setInvoiceTaxOverride.mockResolvedValueOnce(null);
    const res = await PATCH(patchReq({ taxOverridden: false }), ctx());
    expect(res.status).toBe(404);
  });

  // B3: setInvoiceTaxOverride throws on an already-paid invoice → the route must
  // surface a clean 409 (not a 500) so the UI can show a sensible message.
  it('409s when setInvoiceTaxOverride throws (invoice already paid)', async () => {
    setInvoiceTaxOverride.mockRejectedValueOnce(
      new Error('Cannot change the tax override on an already-paid invoice.'),
    );
    const res = await PATCH(patchReq({ taxOverridden: true }), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('invoice-paid');
    expect(json.error).toMatch(/paid/i);
  });
});
