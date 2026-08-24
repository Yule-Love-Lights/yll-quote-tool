// #90 actor audit trail: POST /api/designs threads the authenticated operator id
// to createDesign as created_by.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { create, getByQuote, operatorRef } = vi.hoisted(() => ({
  create: vi.fn(async (): Promise<{ id: string } | null> => ({ id: 'd1' })),
  getByQuote: vi.fn(async (): Promise<{ id: string } | null> => null),
  operatorRef: { current: null as { id: string; email: string | null; role: string } | null },
}));

vi.mock('@/lib/designs', () => ({
  createDesign: create,
  getDesignByQuote: getByQuote,
  getDesignWithPhoto: vi.fn(async () => ({ id: 'd1' })),
  isValidDesignId: (value: unknown) => value === '22222222-2222-4222-8222-222222222222',
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: async () => null,
  getOperator: async () => operatorRef.current,
}));

import { POST } from './route';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ id: 'd1' });
  getByQuote.mockResolvedValue(null);
  operatorRef.current = null;
});

describe('POST /api/designs — created_by actor trail (#90)', () => {
  it('threads the authenticated operator id to createDesign', async () => {
    operatorRef.current = { id: 'op-1', email: 'a@b.com', role: 'operator' };
    const res = await POST(makeReq({}));
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ createdBy: 'op-1' }));
  });

  it('threads null when no operator session (dormant auth)', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ createdBy: null }));
  });
});

describe('POST /api/designs — quote-linked idempotency', () => {
  const quoteId = '22222222-2222-4222-8222-222222222222';

  it('reuses a design already linked to the quote', async () => {
    getByQuote.mockResolvedValue({ id: 'existing-design' });

    const res = await POST(makeReq({ quoteId }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      design: { id: 'existing-design' },
      garlandSectionsUnestimated: 0,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('returns the winning design when concurrent creation loses the unique-index race', async () => {
    getByQuote
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'winning-design' });
    create.mockResolvedValueOnce(null);

    const res = await POST(makeReq({ quoteId }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      design: { id: 'winning-design' },
      garlandSectionsUnestimated: 0,
    });
    expect(getByQuote).toHaveBeenCalledTimes(2);
  });

  it('does not reuse an existing row when the request carries a photo or seed', async () => {
    getByQuote.mockResolvedValue({ id: 'existing-design' });

    const res = await POST(makeReq({
      quoteId,
      photoBase64: 'new-photo',
      photoMediaType: 'image/png',
      seedDefaultYardstick: true,
    }));

    expect(res.status).toBe(200);
    expect(getByQuote).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      quoteId,
      photoBase64: 'new-photo',
      seedDefaultYardstick: true,
    }));
  });
});
