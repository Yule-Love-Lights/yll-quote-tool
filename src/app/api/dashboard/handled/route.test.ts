// Tests for POST /api/dashboard/handled.
//
// Row 320(c): the "Handled" button only ever renders on a listOpenItems row
// (bucket 'needs_reply', status==='unresponded' — InboxList.tsx / store.ts's
// applyBucketFilter). This locks in that markItemHandledLocal is called with
// expectedStatus:'unresponded' — the positive CAS that refuses a stale click
// racing a concurrent Mark-completed/Dismiss, instead of resurrecting the
// terminal row via the default negative `.neq('status','handled')` guard.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { requireOperatorMock, getOperatorMock, markItemHandledLocalMock, recordWritebackMock, runHandledWritebackMock } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async (): Promise<unknown> => ({ id: 'op-1', email: 'op@yulelovelights.com', role: 'operator', name: 'Op' })),
  markItemHandledLocalMock: vi.fn(async (): Promise<unknown> => ({
    ok: true,
    target: { source: 'ghl', externalId: 'ext-1', sourceMessageId: null, ghlContactId: 'ghl-1', displayName: 'Alice' },
  })),
  recordWritebackMock: vi.fn(async (): Promise<void> => {}),
  runHandledWritebackMock: vi.fn(async (): Promise<unknown> => ({ ok: true })),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
  getOperator: getOperatorMock,
}));
vi.mock('@/lib/rateLimit', () => ({
  rateLimitResponse: () => null,
}));
vi.mock('@/lib/dashboard/inbox/store', () => ({
  markItemHandledLocal: markItemHandledLocalMock,
  recordWriteback: recordWritebackMock,
}));
vi.mock('@/lib/dashboard/inbox/sync', () => ({
  runHandledWriteback: runHandledWritebackMock,
}));

import { POST } from './route';

const ITEM_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getOperatorMock.mockResolvedValue({ id: 'op-1', email: 'op@yulelovelights.com', role: 'operator', name: 'Op' });
  markItemHandledLocalMock.mockResolvedValue({
    ok: true,
    target: { source: 'ghl', externalId: 'ext-1', sourceMessageId: null, ghlContactId: 'ghl-1', displayName: 'Alice' },
  });
});

describe('POST /api/dashboard/handled', () => {
  it('marks handled with expectedStatus:"unresponded" — the button only ever renders on a needs_reply row', async () => {
    const res = await POST(makeReq({ itemId: ITEM_ID }));
    expect(res.status).toBe(200);
    expect(markItemHandledLocalMock).toHaveBeenCalledTimes(1);
    expect(markItemHandledLocalMock).toHaveBeenCalledWith(ITEM_ID, 'op-1', expect.any(Date), { expectedStatus: 'unresponded' });
  });

  it('a stale click racing a concurrent terminal transition is refused (409), not resurrected', async () => {
    markItemHandledLocalMock.mockResolvedValueOnce({ ok: false, error: 'Item not found or no longer unresponded' });
    const res = await POST(makeReq({ itemId: ITEM_ID }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json).toEqual({ error: 'Item not found or no longer unresponded' });
    expect(runHandledWritebackMock).not.toHaveBeenCalled();
  });

  it('400 for a non-uuid itemId', async () => {
    const res = await POST(makeReq({ itemId: 'nope' }));
    expect(res.status).toBe(400);
    expect(markItemHandledLocalMock).not.toHaveBeenCalled();
  });
});
