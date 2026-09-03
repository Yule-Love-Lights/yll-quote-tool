// Tests for POST /api/dashboard/reply (dashboard-reply-double-submit).
//
// The route sends a REAL SMS/email via GHL. Before this fix, nothing on the
// server stopped a network retry or a second operator tab from firing the
// send twice — only the client's `sendBusy` disable protected it. These
// tests lock in a server-side atomic claim: a duplicate request landing
// within the dedupe window is short-circuited (409) BEFORE any GHL send,
// and a genuine send failure releases the claim so an immediate legitimate
// retry isn't blocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const {
  requireOperatorMock,
  getOperatorMock,
  getItemForReplyMock,
  markItemHandledLocalMock,
  markItemFollowedMock,
  recordWritebackMock,
  runHandledWritebackMock,
  sendSmsMock,
  sendEmailMock,
  sbRef,
} = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async (): Promise<unknown> => ({ id: 'op-1', email: 'op@yulelovelights.com', role: 'operator', name: 'Op' })),
  getItemForReplyMock: vi.fn(async (): Promise<unknown> => null),
  markItemHandledLocalMock: vi.fn(async (): Promise<unknown> => ({ ok: true, target: { source: 'ghl', externalId: 'ext-1', sourceMessageId: null, ghlContactId: 'ghl-1', displayName: 'Alice' } })),
  markItemFollowedMock: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  recordWritebackMock: vi.fn(async (): Promise<void> => {}),
  runHandledWritebackMock: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  sendSmsMock: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  sendEmailMock: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  sbRef: { current: null as unknown },
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
  getOperator: getOperatorMock,
}));
vi.mock('@/lib/rateLimit', () => ({
  rateLimitResponse: () => null,
}));
vi.mock('@/lib/dashboard/inbox/store', () => ({
  getItemForReply: getItemForReplyMock,
  markItemHandledLocal: markItemHandledLocalMock,
  markItemFollowed: markItemFollowedMock,
  recordWriteback: recordWritebackMock,
}));
vi.mock('@/lib/dashboard/inbox/sync', () => ({
  runHandledWriteback: runHandledWritebackMock,
}));
vi.mock('@/lib/integrations/highlevel', () => ({
  sendSms: sendSmsMock,
  sendEmail: sendEmailMock,
}));
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
}));

import { POST } from './route';

const ITEM_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const ITEM = {
  id: ITEM_ID,
  source: 'ghl',
  channel: 'sms',
  externalId: 'ext-1',
  ghlContactId: 'ghl-contact-1',
  customerName: 'Alice',
  quoteTotal: null,
};

/** A fake chainable Supabase query builder. `results` is consumed in call
 *  order: the claim-before-send update reads results[0], and (only on a
 *  release-after-failure) a second update reads results[1]. Chain objects
 *  are awaitable directly (mirrors `.eq(...)` used without `.select()`)
 *  AND support `.select().maybeSingle()` (mirrors the claim read-back). */
function makeSb(results: Array<{ data: unknown; error: unknown }>) {
  const updateCalls: Record<string, unknown>[] = [];
  let i = 0;
  const next = () => results[i++] ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: () => chain,
    update: (vals: Record<string, unknown>) => {
      updateCalls.push(vals);
      return chain;
    },
    eq: () => chain,
    or: () => chain,
    select: () => chain,
    maybeSingle: async () => next(),
    then: (resolve: (v: unknown) => void) => resolve(next()),
  });
  return { chain, updateCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getOperatorMock.mockResolvedValue({ id: 'op-1', email: 'op@yulelovelights.com', role: 'operator', name: 'Op' });
  getItemForReplyMock.mockResolvedValue({ ...ITEM });
  markItemHandledLocalMock.mockResolvedValue({
    ok: true,
    target: { source: 'ghl', externalId: 'ext-1', sourceMessageId: null, ghlContactId: 'ghl-contact-1', displayName: 'Alice' },
  });
  markItemFollowedMock.mockResolvedValue({ ok: true });
  sendSmsMock.mockResolvedValue({ ok: true });
  sendEmailMock.mockResolvedValue({ ok: true });
  // Default: claim succeeds (a fresh row, no prior claim).
  sbRef.current = makeSb([{ data: { id: ITEM_ID }, error: null }]).chain;
});

describe('POST /api/dashboard/reply — validation & gating', () => {
  it('returns the operator gate response when denied', async () => {
    const denied = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    requireOperatorMock.mockResolvedValueOnce(denied);
    const res = await POST(makeReq({ itemId: ITEM_ID, text: 'hi' }));
    expect(res.status).toBe(401);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it('400 for a non-uuid itemId', async () => {
    const res = await POST(makeReq({ itemId: 'nope', text: 'hi' }));
    expect(res.status).toBe(400);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it('400 for empty text', async () => {
    const res = await POST(makeReq({ itemId: ITEM_ID, text: '   ' }));
    expect(res.status).toBe(400);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it('404 when the item is not found', async () => {
    getItemForReplyMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ itemId: ITEM_ID, text: 'hi' }));
    expect(res.status).toBe(404);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/dashboard/reply — success', () => {
  it('sends via sms, claims the item first, and marks handled + followed', async () => {
    const { chain, updateCalls } = makeSb([{ data: { id: ITEM_ID }, error: null }]);
    sbRef.current = chain;
    const res = await POST(makeReq({ itemId: ITEM_ID, text: 'hello there' }));
    const json = await res.json();
    expect(res.status).toBe(200);
    // Finding 1 fix round: `resolved` reports whether markItemHandledLocal's
    // CAS actually landed — true here (the ordinary, uncontested path).
    expect(json).toEqual({ ok: true, resolved: true });
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    expect(markItemHandledLocalMock).toHaveBeenCalledTimes(1);
    expect(markItemFollowedMock).toHaveBeenCalledTimes(1);
    // Row 320(c): the stale-composer-race fix — a positive expectedStatus set
    // (not the default negative `.neq('status','handled')` guard) must reach
    // the write, or a status that moved to completed/dismissed since the
    // composer opened would get silently resurrected to 'handled'.
    expect(markItemHandledLocalMock).toHaveBeenCalledWith(ITEM_ID, 'op-1', expect.any(Date), {
      expectedStatus: ['unresponded', 'handled'],
    });
    // Row 311 fix-round FIX 1: a real send must pass allowRestamp:true, or the
    // caller-differentiation fix is inert — see markItemFollowed's doc comment.
    // Row 502: a sent reply is corroborated by construction, and now says
    // so. Asserting the exact opts object is deliberate: dropping `via`
    // would silently record a real reply as an unbacked manual stamp.
    expect(markItemFollowedMock).toHaveBeenCalledWith(ITEM_ID, 'op-1', expect.any(Date), {
      allowRestamp: true,
      via: 'reply',
    });
    // The pre-send claim wrote a claim timestamp before any send happened.
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    expect(updateCalls[0]).toHaveProperty('reply_claimed_at');
  });
});

describe('POST /api/dashboard/reply — Finding 1 (stale-composer race: CAS refused)', () => {
  it('still sends (cannot unsend) but reports resolved:false, refused:true, and skips the writeback, when the item was resolved elsewhere first', async () => {
    markItemHandledLocalMock.mockResolvedValueOnce({ ok: false, error: 'Item not found or no longer unresponded/handled', refused: true });
    const { chain } = makeSb([{ data: { id: ITEM_ID }, error: null }]);
    sbRef.current = chain;
    const res = await POST(makeReq({ itemId: ITEM_ID, text: 'hello there' }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    // Fix round 2 (MED): `refused:true` is what tells the client this is a
    // benign lost race, not an unknown failure — distinct from the sibling
    // test below (a real DB error) which must read refused:false.
    expect(json).toEqual({ ok: true, resolved: false, refused: true });
    // No target coordinates on a refused CAS — nothing to write back to.
    expect(runHandledWritebackMock).not.toHaveBeenCalled();
    expect(recordWritebackMock).not.toHaveBeenCalled();
    // The snooze attempt still fires — markItemFollowed's own status guard
    // refuses it harmlessly (a terminal item is not a legal Follow source).
    expect(markItemFollowedMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/dashboard/reply — fix round 2 (MED): a genuine backend error is NOT a refusal', () => {
  it('still sends (cannot unsend) but reports resolved:false, refused:false, when the status write fails for a reason OTHER than a lost race', async () => {
    markItemHandledLocalMock.mockResolvedValueOnce({ ok: false, error: 'connection reset', refused: false });
    const { chain } = makeSb([{ data: { id: ITEM_ID }, error: null }]);
    sbRef.current = chain;
    const res = await POST(makeReq({ itemId: ITEM_ID, text: 'hello there' }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    // The whole point of this fix round: this must NOT be indistinguishable
    // from the CAS-refused test above — refused:false is the signal that
    // tells the client the item's true status is UNCONFIRMED, not resolved.
    expect(json).toEqual({ ok: true, resolved: false, refused: false });
    expect(runHandledWritebackMock).not.toHaveBeenCalled();
    expect(recordWritebackMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/dashboard/reply — duplicate-send guard', () => {
  it('short-circuits with 409 when a claim is already in flight (no rows updated) and never calls GHL', async () => {
    const { chain } = makeSb([{ data: null, error: null }]); // 0 rows matched => already claimed
    sbRef.current = chain;
    const res = await POST(makeReq({ itemId: ITEM_ID, text: 'hello there' }));
    expect(res.status).toBe(409);
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(markItemHandledLocalMock).not.toHaveBeenCalled();
  });

  it('fails open (still sends) when the claim check itself errors', async () => {
    const { chain } = makeSb([{ data: null, error: { message: 'boom' } }]);
    sbRef.current = chain;
    const res = await POST(makeReq({ itemId: ITEM_ID, text: 'hello there' }));
    expect(res.status).toBe(200);
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when the send fails, so a genuine retry is not blocked by this response', async () => {
    sendSmsMock.mockRejectedValueOnce(new Error('GHL down'));
    const { chain, updateCalls } = makeSb([{ data: { id: ITEM_ID }, error: null }, { data: null, error: null }]);
    sbRef.current = chain;
    const res = await POST(makeReq({ itemId: ITEM_ID, text: 'hello there' }));
    expect(res.status).toBe(502);
    // Two updates: the claim, then the release (reply_claimed_at back to null).
    expect(updateCalls.length).toBe(2);
    expect(updateCalls[1]).toEqual(expect.objectContaining({ reply_claimed_at: null }));
    expect(markItemHandledLocalMock).not.toHaveBeenCalled();
  });
});
