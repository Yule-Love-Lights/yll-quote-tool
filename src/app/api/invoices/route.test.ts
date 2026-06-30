// Tests for the operator gate on the #83 billing invoices list (GET /api/invoices).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

const { listInvoicesForAdmin, requireOperatorMock } = vi.hoisted(() => ({
  listInvoicesForAdmin: vi.fn(async () => [{ id: 'i1', invoiceNumber: 1000 }]),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));
vi.mock('@/lib/invoices', () => ({ listInvoicesForAdmin }));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));

import { GET } from './route';

const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
});

describe('GET /api/invoices — operator billing list', () => {
  it('401s when the operator gate denies — never touches the data layer', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await GET();
    expect(res.status).toBe(401);
    expect(listInvoicesForAdmin).not.toHaveBeenCalled();
  });

  it('returns the invoices when authorized', async () => {
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.invoices).toEqual([{ id: 'i1', invoiceNumber: 1000 }]);
    expect(listInvoicesForAdmin).toHaveBeenCalledOnce();
  });
});
