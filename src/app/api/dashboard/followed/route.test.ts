import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const store = vi.hoisted(() => ({
  markItemFollowed: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: vi.fn(async () => null),
  getOperator: vi.fn(async () => ({ id: 'op-1' })),
}));
vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: vi.fn(() => null) }));
vi.mock('@/lib/dashboard/inbox/store', () => ({ markItemFollowed: store.markItemFollowed }));

import { POST } from './route';

const ITEM = '11111111-2222-3333-4444-555555555555';

function req(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.markItemFollowed.mockResolvedValue({ ok: true });
});

describe('POST /api/dashboard/followed', () => {
  it('does NOT restamp by default, so a duplicate click cannot move the waiting clock', () => {
    return POST(req({ itemId: ITEM })).then(() => {
      const opts = store.markItemFollowed.mock.calls[0][3];
      expect(opts?.allowRestamp).not.toBe(true);
    });
  });

  it('restamps when the caller explicitly says this is another follow-up', async () => {
    // The "Followed again" button on an already-followed row. Without this the
    // click is a silent no-op: markItemFollowed refuses a second stamp, the
    // route turns that refusal into a 200, and the row never moves.
    await POST(req({ itemId: ITEM, again: true }));
    const opts = store.markItemFollowed.mock.calls[0][3];
    expect(opts?.allowRestamp).toBe(true);
  });

  it('ignores a non-boolean again value rather than trusting it', async () => {
    await POST(req({ itemId: ITEM, again: 'yes' }));
    const opts = store.markItemFollowed.mock.calls[0][3];
    expect(opts?.allowRestamp).not.toBe(true);
  });

  it('still rejects a bad itemId', async () => {
    const res = await POST(req({ itemId: 'not-a-uuid', again: true }));
    expect(res.status).toBe(400);
    expect(store.markItemFollowed).not.toHaveBeenCalled();
  });

  it('treats an already-followed refusal as success (duplicate click)', async () => {
    store.markItemFollowed.mockResolvedValue({ ok: false, error: 'Already marked followed', alreadyFollowed: true });
    const res = await POST(req({ itemId: ITEM }));
    expect(res.status).toBe(200);
  });

  it('surfaces a real failure', async () => {
    store.markItemFollowed.mockResolvedValue({ ok: false, error: 'boom' });
    const res = await POST(req({ itemId: ITEM }));
    expect(res.status).toBe(503);
  });
});
