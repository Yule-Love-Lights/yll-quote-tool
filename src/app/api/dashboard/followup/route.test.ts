// Tests for POST /api/dashboard/followup (#252 slice E).
//
// Before this fix, clicking Done on a follow-up never touched its anchored
// inbox item — the "due today" strip cleared while the conversation stayed
// open (unresponded) everywhere else. These tests lock in the coupling: a
// follow-up marked done, anchored to a still-'unresponded' item, ALSO
// resolves that item through the exact machinery /api/dashboard/handled uses
// (markItemHandledLocal -> runHandledWriteback -> recordWriteback). An item
// that's already handled/completed/dismissed is left untouched, and a
// follow-up with no anchored item behaves exactly as before.
//
// shouldResolveAnchoredItem (the real gate, not mocked) is exercised here in
// combination with the mocked I/O calls — its own exhaustive input table
// (including the 'dismissed' follow-up case, which has no live UI caller
// today) lives in store.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const {
  requireOperatorMock,
  getOperatorMock,
  markFollowUpDoneMock,
  getItemStatusMock,
  markItemHandledLocalMock,
  recordWritebackMock,
  runHandledWritebackMock,
} = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async (): Promise<unknown> => ({ id: 'op-1', email: 'op@yulelovelights.com', role: 'operator', name: 'Op' })),
  markFollowUpDoneMock: vi.fn(async (): Promise<unknown> => ({ ok: true, inboxItemId: null })),
  getItemStatusMock: vi.fn(async (): Promise<unknown> => null),
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
// Real shouldResolveAnchoredItem is kept (importOriginal) so these tests
// exercise the actual gate, not a stand-in for it — only the I/O calls are
// mocked.
vi.mock('@/lib/dashboard/inbox/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dashboard/inbox/store')>();
  return {
    ...actual,
    markFollowUpDone: markFollowUpDoneMock,
    getItemStatus: getItemStatusMock,
    markItemHandledLocal: markItemHandledLocalMock,
    recordWriteback: recordWritebackMock,
  };
});
vi.mock('@/lib/dashboard/inbox/sync', () => ({
  runHandledWriteback: runHandledWritebackMock,
}));

import { POST } from './route';

const FOLLOWUP_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ITEM_ID = '11111111-2222-4333-8444-555555555555';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getOperatorMock.mockResolvedValue({ id: 'op-1', email: 'op@yulelovelights.com', role: 'operator', name: 'Op' });
  markFollowUpDoneMock.mockResolvedValue({ ok: true, inboxItemId: null });
  getItemStatusMock.mockResolvedValue(null);
  markItemHandledLocalMock.mockResolvedValue({
    ok: true,
    target: { source: 'ghl', externalId: 'ext-1', sourceMessageId: null, ghlContactId: 'ghl-1', displayName: 'Alice' },
  });
  recordWritebackMock.mockResolvedValue(undefined);
  runHandledWritebackMock.mockResolvedValue({ ok: true });
});

describe('POST /api/dashboard/followup — validation & gating', () => {
  it('returns the operator gate response when denied', async () => {
    const denied = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    requireOperatorMock.mockResolvedValueOnce(denied);
    const res = await POST(makeReq({ id: FOLLOWUP_ID }));
    expect(res.status).toBe(401);
    expect(markFollowUpDoneMock).not.toHaveBeenCalled();
  });

  it('400 for a non-uuid id', async () => {
    const res = await POST(makeReq({ id: 'nope' }));
    expect(res.status).toBe(400);
    expect(markFollowUpDoneMock).not.toHaveBeenCalled();
  });

  it('503 when markFollowUpDone fails', async () => {
    markFollowUpDoneMock.mockResolvedValueOnce({ ok: false, error: 'Supabase service role not configured' });
    const res = await POST(makeReq({ id: FOLLOWUP_ID }));
    expect(res.status).toBe(503);
    expect(getItemStatusMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/dashboard/followup — #252 slice E anchored-item coupling', () => {
  it('(1) done + anchored + unresponded item -> item handled AND write-back invoked', async () => {
    markFollowUpDoneMock.mockResolvedValueOnce({ ok: true, inboxItemId: ITEM_ID });
    getItemStatusMock.mockResolvedValueOnce('unresponded');

    const res = await POST(makeReq({ id: FOLLOWUP_ID }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(markFollowUpDoneMock).toHaveBeenCalledWith(FOLLOWUP_ID, 'op-1');
    expect(getItemStatusMock).toHaveBeenCalledWith(ITEM_ID);
    expect(markItemHandledLocalMock).toHaveBeenCalledTimes(1);
    // Row 366: the positive status the gate checked is carried into the write
    // as its CAS — without it, an item that moves to completed/dismissed in the
    // read→write gap is silently resurrected to 'handled'.
    expect(markItemHandledLocalMock).toHaveBeenCalledWith(ITEM_ID, 'op-1', expect.any(Date), {
      expectedStatus: 'unresponded',
    });
    expect(runHandledWritebackMock).toHaveBeenCalledTimes(1);
    expect(runHandledWritebackMock).toHaveBeenCalledWith(
      { source: 'ghl', externalId: 'ext-1', sourceMessageId: null, ghlContactId: 'ghl-1', displayName: 'Alice' },
      'op@yulelovelights.com',
    );
    expect(recordWritebackMock).toHaveBeenCalledWith(ITEM_ID, { ok: true });
  });

  it('(2) done + item already handled -> item untouched (no double-stamp, via the real status guard)', async () => {
    markFollowUpDoneMock.mockResolvedValueOnce({ ok: true, inboxItemId: ITEM_ID });
    getItemStatusMock.mockResolvedValueOnce('handled');

    const res = await POST(makeReq({ id: FOLLOWUP_ID }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true }); // the follow-up Done action itself still succeeds
    expect(getItemStatusMock).toHaveBeenCalledWith(ITEM_ID);
    expect(markItemHandledLocalMock).not.toHaveBeenCalled();
    expect(runHandledWritebackMock).not.toHaveBeenCalled();
    expect(recordWritebackMock).not.toHaveBeenCalled();
  });

  it('(2b) done + item already completed -> item untouched', async () => {
    markFollowUpDoneMock.mockResolvedValueOnce({ ok: true, inboxItemId: ITEM_ID });
    getItemStatusMock.mockResolvedValueOnce('completed');

    await POST(makeReq({ id: FOLLOWUP_ID }));

    expect(markItemHandledLocalMock).not.toHaveBeenCalled();
  });

  it('(2c) done + item already dismissed -> item untouched', async () => {
    markFollowUpDoneMock.mockResolvedValueOnce({ ok: true, inboxItemId: ITEM_ID });
    getItemStatusMock.mockResolvedValueOnce('dismissed');

    await POST(makeReq({ id: FOLLOWUP_ID }));

    expect(markItemHandledLocalMock).not.toHaveBeenCalled();
  });

  it('(3) done + no anchored item -> today\'s behavior (no status lookup, no item touch)', async () => {
    markFollowUpDoneMock.mockResolvedValueOnce({ ok: true, inboxItemId: null });

    const res = await POST(makeReq({ id: FOLLOWUP_ID }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(getItemStatusMock).not.toHaveBeenCalled();
    expect(markItemHandledLocalMock).not.toHaveBeenCalled();
    expect(runHandledWritebackMock).not.toHaveBeenCalled();
  });

  // #323 CAS revival: a LOST race returns inboxItemId: null from
  // markFollowUpDone (the loser never touched the row), which is exactly
  // scenario (3)'s shape at the route boundary — the route can't tell a lost
  // race apart from a manual no-anchor follow-up, and doesn't need to: either
  // way there is nothing here to resolve, so it must not attempt to (no
  // double-resolve, no double dashboard_activity log for the anchored item).
  it('#323: a lost CAS race (inboxItemId: null) never attempts the anchor resolution', async () => {
    markFollowUpDoneMock.mockResolvedValueOnce({ ok: true, inboxItemId: null });

    const res = await POST(makeReq({ id: FOLLOWUP_ID }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(getItemStatusMock).not.toHaveBeenCalled();
    expect(markItemHandledLocalMock).not.toHaveBeenCalled();
    expect(runHandledWritebackMock).not.toHaveBeenCalled();
    expect(recordWritebackMock).not.toHaveBeenCalled();
  });

  // (4) "a follow-up DISMISSED (not done) must NOT touch the item": this route
  // is the ONLY caller of markFollowUpDone today and it only ever sets
  // follow_ups.status='done' — there is no live dismiss action to drive
  // end-to-end. The contract is proved directly at the gate instead:
  // store.test.ts's shouldResolveAnchoredItem suite asserts
  // shouldResolveAnchoredItem('dismissed', <any item status>) === false, so a
  // future dismiss caller reusing this same gate inherits the guarantee.

  it('best-effort: an anchored-item resolve failure never fails the follow-up Done response', async () => {
    markFollowUpDoneMock.mockResolvedValueOnce({ ok: true, inboxItemId: ITEM_ID });
    getItemStatusMock.mockResolvedValueOnce('unresponded');
    markItemHandledLocalMock.mockRejectedValueOnce(new Error('db exploded'));

    const res = await POST(makeReq({ id: FOLLOWUP_ID }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true });
  });

  it('a REFUSED anchored-item CAS (someone else resolved it in the gap) skips the write-back, logs, and still returns 200', async () => {
    // Row 366 fix round: with the positive CAS, this refusal is now the normal
    // outcome of a lost race — the item moved to completed/dismissed between the
    // status read and the write, so it must NOT be stamped handled, and nothing
    // downstream may run as if it had been.
    markFollowUpDoneMock.mockResolvedValueOnce({ ok: true, inboxItemId: ITEM_ID });
    getItemStatusMock.mockResolvedValueOnce('unresponded');
    markItemHandledLocalMock.mockResolvedValueOnce({ ok: false, error: 'Item not found or no longer unresponded' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(makeReq({ id: FOLLOWUP_ID }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(runHandledWritebackMock).not.toHaveBeenCalled();
    expect(recordWritebackMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to operator id for the write-back label when email is absent', async () => {
    getOperatorMock.mockResolvedValueOnce({ id: 'op-2', email: null, role: 'operator', name: null });
    markFollowUpDoneMock.mockResolvedValueOnce({ ok: true, inboxItemId: ITEM_ID });
    getItemStatusMock.mockResolvedValueOnce('unresponded');

    await POST(makeReq({ id: FOLLOWUP_ID }));

    expect(runHandledWritebackMock).toHaveBeenCalledWith(expect.anything(), 'op-2');
  });
});
