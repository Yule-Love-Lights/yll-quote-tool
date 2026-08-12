// Tests for POST /api/quotes/[id]/send — focused on the audit fix
// (send-route-ghl-sync-state, finding #32): the GHL pipeline stage-sync
// outcome must be persisted durably (ghl_stage_synced_at / ghl_sync_error),
// and a ?retryGhl reconcile must re-run ONLY the GHL block (no re-stamp, no
// re-message) for an already-sent quote whose card never advanced.
//
// Supabase + the HighLevel client are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { sbRef, hl, attachQuoteToCustomerMock, propagateMock } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  // #198: mocked so (a) the existing legacy_rebook fixture (no customer_id set)
  // doesn't hit the real attachQuoteToCustomer against this file's Supabase
  // fake (which lacks .maybeSingle()), and (b) the tag-propagation tests below
  // can assert on it directly.
  attachQuoteToCustomerMock: vi.fn(async () => null as null | { customerId: string; propertyId: string }),
  propagateMock: vi.fn(async () => {}),
  hl: {
    updateOpportunity: vi.fn(async () => ({ id: 'opp_1' })),
    createOpportunity: vi.fn(async () => ({ id: 'opp_new' })),
    findOpportunityForContact: vi.fn(async () => null as { id: string } | null),
    resurrectDuplicateOpportunity: vi.fn(async (_err: unknown, _input: unknown) => null as { id: string } | null),
    upsertContactCustomField: vi.fn(async () => undefined),
    sendSms: vi.fn(async () => undefined),
    sendEmail: vi.fn(async () => undefined),
    configured: { value: true },
  },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimitResponse: () => null,
}));

// #214: importOriginal keeps quoteRowToIdentity (pure sentinel translation)
// REAL — only the DB-touching fns are mocked.
vi.mock('@/lib/customers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/customers')>()),
  attachQuoteToCustomer: attachQuoteToCustomerMock,
  propagateQuoteTagsToCustomer: propagateMock,
}));

vi.mock('@/lib/integrations/highlevel', () => ({
  updateOpportunity: hl.updateOpportunity,
  createOpportunity: hl.createOpportunity,
  findOpportunityForContact: hl.findOpportunityForContact,
  resurrectDuplicateOpportunity: hl.resurrectDuplicateOpportunity,
  upsertContactCustomField: hl.upsertContactCustomField,
  sendSms: hl.sendSms,
  sendEmail: hl.sendEmail,
  isHighLevelConfigured: () => hl.configured.value,
  HighLevelError: class HighLevelError extends Error {
    status?: number;
    body?: string;
  },
}));

vi.mock('@/lib/integrations/quoteMessages', () => ({
  quoteEmailSubject: () => 'subj',
  quoteSmsBody: () => 'sms',
  quoteEmailHtml: () => '<p>email</p>',
}));

import { POST } from './route';

// Fake Supabase: read = from().select().eq().single(); each write =
// from().update(payload).eq() (awaited). Records every update payload so we
// can assert what was persisted.
//
// #187b: the fresh-send stamp now chains `.eq('view_only', false)
// .is('deposit_paid_at', null).select('id')` as a TOCTOU guard, so its
// `.then()` must resolve `data` too (not just `error`) — default is a single
// matched row `[{ id }]`; `opts.stampRace: true` simulates losing that race
// (0 rows) for the ONE update call that carries `quote_sent_at` (the stamp).
// Every other `.update()` in the route (GHL sync-state, quote-link field,
// etc.) never reads `.data`, so giving them a non-empty array too is harmless.
type Quote = Record<string, unknown> | null;
function makeSb(quote: Quote, opts: { stampRace?: boolean } = {}) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  const builder: Record<string, unknown> = {};
  let isUpdate = false;
  let lastUpdateIsStamp = false;
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    update: (payload: Record<string, unknown>) => {
      isUpdate = true;
      lastUpdateIsStamp = 'quote_sent_at' in payload;
      updatePayloads.push(payload);
      return builder;
    },
    eq: () => builder,
    is: () => builder,
    single: async () => ({ data: quote, error: quote ? null : { message: 'no row' } }),
    then: (resolve: (v: unknown) => void) => {
      let res: unknown;
      if (isUpdate) {
        const raceLost = lastUpdateIsStamp && opts.stampRace;
        res = { data: raceLost ? [] : [{ id: (quote as { id?: string } | null)?.id ?? ID }], error: null };
      } else {
        res = { data: quote, error: null };
      }
      isUpdate = false;
      resolve(res);
    },
  });
  return { client: builder, updatePayloads };
}

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeReq(retryGhl = false): NextRequest {
  const params = new URLSearchParams();
  if (retryGhl) params.set('retryGhl', '1');
  return {
    headers: { get: () => null },
    nextUrl: { origin: 'https://quote.example.com', searchParams: params },
    json: async () => { throw new Error('no body'); },
  } as unknown as NextRequest;
}

function makeReqWithBody(body: Record<string, unknown>, retryDelivery = false): NextRequest {
  const searchParams = new URLSearchParams();
  if (retryDelivery) searchParams.set('retryDelivery', '1');
  return {
    headers: { get: () => null },
    nextUrl: { origin: 'https://quote.example.com', searchParams },
    json: async () => body,
  } as unknown as NextRequest;
}
const params = Promise.resolve({ id: ID });

const FRESH_QUOTE = {
  id: ID,
  highlevel_opportunity_id: 'opp_1',
  highlevel_contact_id: 'contact_1',
  customer_name: 'Jordan Smith',
  total: 4200,
  result: { total: 4200, lineItems: [{ amount: 4200 }] },
  quote_sent_at: null,
  customer_approved_at: null,
  ghl_stage_synced_at: null,
  view_only: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  hl.configured.value = true;
  hl.findOpportunityForContact.mockResolvedValue(null);
  process.env.HIGHLEVEL_STAGE_QUOTE_SENT = 'stage_bid_sent';
  process.env.HIGHLEVEL_PIPELINE_ID = 'pipeline_1';
});

describe('POST /api/quotes/[id]/send — GHL sync state', () => {
  it('stamps ghl_stage_synced_at when the stage move succeeds', async () => {
    const { client, updatePayloads } = makeSb({ ...FRESH_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ghlSynced).toBe(true);
    // a sync-state write persisted ghl_stage_synced_at + cleared the error
    const syncWrite = updatePayloads.find((p) => 'ghl_stage_synced_at' in p);
    expect(syncWrite).toBeTruthy();
    expect(syncWrite!.ghl_sync_error).toBeNull();
    expect(typeof syncWrite!.ghl_stage_synced_at).toBe('string');
  });

  it('sets the Bid-Sent card value to the "Full Yule" ceiling when present (#107)', async () => {
    const { client } = makeSb({
      ...FRESH_QUOTE,
      total: 4200, // billed (selected roofline)
      result: { total: 4200, lineItems: [{ amount: 4200 }], fullYule: { total: 5000 } }, // ceiling
    });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    // the linked card is advanced to Bid Sent with the CEILING as its value
    expect(hl.updateOpportunity).toHaveBeenCalledWith(
      'opp_1',
      expect.objectContaining({ pipelineStageId: 'stage_bid_sent', monetaryValue: 5000 }),
    );
  });

  it('persists ghl_sync_error (and still stamps quote_sent_at) when the GHL stage move throws', async () => {
    hl.updateOpportunity.mockRejectedValueOnce(new Error('GHL 500'));
    const { client, updatePayloads } = makeSb({ ...FRESH_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ghlSynced).toBe(false);
    // quote_sent_at was still stamped (local send is recorded regardless)
    expect(updatePayloads.some((p) => 'quote_sent_at' in p)).toBe(true);
    // the failure reason was persisted and ghl_stage_synced_at was NOT set
    const errWrite = updatePayloads.find((p) => 'ghl_sync_error' in p && !('ghl_stage_synced_at' in p));
    expect(errWrite).toBeTruthy();
    expect(typeof errWrite!.ghl_sync_error).toBe('string');
  });

  it('?retryGhl re-runs ONLY the GHL block for an already-sent, unsynced quote — no re-stamp, no re-message', async () => {
    const alreadySent = {
      ...FRESH_QUOTE,
      quote_sent_at: '2026-06-26T00:00:00Z',
      ghl_stage_synced_at: null,
    };
    const { client, updatePayloads } = makeSb(alreadySent);
    sbRef.current = client;

    const res = await POST(makeReq(true), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ghlRetry).toBe(true);
    expect(json.ghlSynced).toBe(true);
    // original sent timestamp is preserved (no re-stamp)
    expect(json.sentAt).toBe('2026-06-26T00:00:00Z');
    expect(updatePayloads.some((p) => 'quote_sent_at' in p)).toBe(false);
    // the customer was NOT re-messaged on a reconcile
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.sendEmail).not.toHaveBeenCalled();
    // but the GHL stage move DID run + got persisted
    expect(hl.updateOpportunity).toHaveBeenCalled();
    expect(updatePayloads.some((p) => 'ghl_stage_synced_at' in p)).toBe(true);
  });

  it('blocks a real send when no HighLevel contact is linked (400 no-contact, never stamped)', async () => {
    const { client, updatePayloads } = makeSb({
      ...FRESH_QUOTE,
      highlevel_contact_id: null,
      highlevel_opportunity_id: null,
    });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe('no-contact');
    // not marked sent, and no GHL / messaging side effects fired
    expect(updatePayloads.some((p) => 'quote_sent_at' in p)).toBe(false);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
    expect(hl.createOpportunity).not.toHaveBeenCalled();
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('legacy_rebook (#156): routes the Bid-Sent move to the Neighbors pipeline, never the holiday env-configured stage', async () => {
    const { client } = makeSb({ ...FRESH_QUOTE, service_type: 'holiday', legacy_rebook: true });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    // Neighbors' hardcoded Bid Sent stage id — NOT 'stage_bid_sent' (the
    // HIGHLEVEL_STAGE_QUOTE_SENT holiday env var set in beforeEach).
    expect(hl.updateOpportunity).toHaveBeenCalledWith(
      'opp_1',
      expect.objectContaining({ pipelineStageId: '9ada8238-1e95-4242-b567-7edf3bef6c2c' }),
    );
  });

  it('still sends a TEST quote with no contact (simulated — contact not required)', async () => {
    const { client, updatePayloads } = makeSb({
      ...FRESH_QUOTE,
      highlevel_contact_id: null,
      highlevel_opportunity_id: null,
      is_test: true,
    });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    // stamped sent locally, but never touched a real GHL card or messaged anyone
    expect(updatePayloads.some((p) => 'quote_sent_at' in p)).toBe(true);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
    expect(hl.sendSms).not.toHaveBeenCalled();
  });

  it('an already-sent quote WITHOUT ?retryGhl still short-circuits (alreadySent) and reports the ORIGINAL sentAt, nothing re-delivered', async () => {
    const alreadySent = {
      ...FRESH_QUOTE,
      quote_sent_at: '2026-06-26T00:00:00Z',
      ghl_stage_synced_at: null,
      status: 'sent',
    };
    const { client, updatePayloads } = makeSb(alreadySent);
    sbRef.current = client;

    const res = await POST(makeReq(false), { params });
    const json = await res.json();

    expect(json.alreadySent).toBe(true);
    // #241: the builder UI reads sentAt off this response to tell staff WHEN
    // the quote was actually delivered (it must be the ORIGINAL timestamp,
    // not a re-stamp) — pin the contract the UI depends on.
    expect(json.sentAt).toBe('2026-06-26T00:00:00Z');
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.sendEmail).not.toHaveBeenCalled();
    expect(updatePayloads).toHaveLength(0);
  });

  // W1-017: a ?retryGhl reconcile must check the CURRENT status. A quote that was
  // sent-then-approved-then-booked (its GHL stage-sync never landed, so
  // ghl_stage_synced_at is still NULL and the retry affordance stays live) must NOT
  // have its card yanked back to "Bid Sent". Only a still-sent/viewed quote is
  // eligible; a booked quote short-circuits as alreadySent and never touches GHL.
  it('?retryGhl does NOT yank a since-BOOKED quote back to Bid Sent', async () => {
    const bookedButUnsynced = {
      ...FRESH_QUOTE,
      quote_sent_at: '2026-06-26T00:00:00Z',
      customer_approved_at: '2026-06-27T00:00:00Z',
      deposit_paid_at: '2026-06-28T00:00:00Z', // deriveStatus → 'booked'
      ghl_stage_synced_at: null, // original send-stage sync never landed
      status: 'booked',
    };
    const { client, updatePayloads } = makeSb(bookedButUnsynced);
    sbRef.current = client;

    const res = await POST(makeReq(true), { params });
    const json = await res.json();

    // The booked quote is not retry-eligible → short-circuit, no GHL yank-back.
    expect(json.alreadySent).toBe(true);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
    // never re-stamped the sync or the sent timestamp
    expect(updatePayloads.some((p) => 'ghl_stage_synced_at' in p)).toBe(false);
    expect(updatePayloads.some((p) => 'quote_sent_at' in p)).toBe(false);
  });
});

describe('POST /api/quotes/[id]/send — channel split', () => {
  const FULL_QUOTE = {
    ...FRESH_QUOTE,
    is_test: false,
  };

  beforeEach(() => {
    process.env.HIGHLEVEL_STAGE_QUOTE_SENT = 'stage_bid_sent';
    process.env.HIGHLEVEL_PIPELINE_ID = 'pipeline_1';
    hl.configured.value = true;
    hl.updateOpportunity.mockResolvedValue({ id: 'opp_1' });
  });

  it('channel:sms — calls sendSms but NOT sendEmail', async () => {
    const { client } = makeSb({ ...FULL_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReqWithBody({ channel: 'sms' }), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.channel).toBe('sms');
    expect(hl.sendSms).toHaveBeenCalledOnce();
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('channel:email — calls sendEmail but NOT sendSms', async () => {
    const { client } = makeSb({ ...FULL_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReqWithBody({ channel: 'email' }), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.channel).toBe('email');
    expect(hl.sendEmail).toHaveBeenCalledOnce();
    expect(hl.sendSms).not.toHaveBeenCalled();
  });

  it('no body (default) — calls both sendSms and sendEmail', async () => {
    const { client } = makeSb({ ...FULL_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.channel).toBe('both');
    expect(hl.sendSms).toHaveBeenCalledOnce();
    expect(hl.sendEmail).toHaveBeenCalledOnce();
  });

  it('channel:both — calls both sendSms and sendEmail', async () => {
    const { client } = makeSb({ ...FULL_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReqWithBody({ channel: 'both' }), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.channel).toBe('both');
    expect(hl.sendSms).toHaveBeenCalledOnce();
    expect(hl.sendEmail).toHaveBeenCalledOnce();
  });
});

describe('POST /api/quotes/[id]/send — changes_requested resend (Bug 1)', () => {
  it('treats a changes_requested quote as a fresh re-send: stamps status=sent, fires messaging', async () => {
    const changesRequested = {
      ...FRESH_QUOTE,
      quote_sent_at: '2026-06-26T00:00:00Z',
      ghl_stage_synced_at: '2026-06-26T00:00:01Z',
      status: 'changes_requested',
    };
    const { client, updatePayloads } = makeSb(changesRequested);
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    // Must NOT return alreadySent — this is a real re-send
    expect(json.alreadySent).toBeUndefined();
    expect(json.ok).toBe(true);
    // status re-stamped to 'sent'
    const stampWrite = updatePayloads.find((p) => 'status' in p && p.status === 'sent');
    expect(stampWrite).toBeTruthy();
    // messaging fired
    expect(hl.sendSms).toHaveBeenCalled();
    expect(hl.sendEmail).toHaveBeenCalled();
  });

  it('a plain sent/viewed quote still short-circuits (existing alreadySent guard unchanged)', async () => {
    const alreadySent = {
      ...FRESH_QUOTE,
      quote_sent_at: '2026-06-26T00:00:00Z',
      ghl_stage_synced_at: '2026-06-26T00:00:01Z',
      status: 'sent',
    };
    const { client } = makeSb(alreadySent);
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(json.alreadySent).toBe(true);
    expect(hl.sendSms).not.toHaveBeenCalled();
  });

  it('is_test changes_requested resend: stamps sent but never messages or moves GHL card', async () => {
    const changesRequested = {
      ...FRESH_QUOTE,
      highlevel_contact_id: null,
      highlevel_opportunity_id: null,
      quote_sent_at: '2026-06-26T00:00:00Z',
      ghl_stage_synced_at: null,
      status: 'changes_requested',
      is_test: true,
    };
    const { client, updatePayloads } = makeSb(changesRequested);
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const stampWrite = updatePayloads.find((p) => 'status' in p && p.status === 'sent');
    expect(stampWrite).toBeTruthy();
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });
});

describe('POST /api/quotes/[id]/send — #116 revive (declined/lost re-send)', () => {
  it('revives a DECLINED quote: re-stamps status=sent + quote_sent_at, fires messaging, echoes revived:true', async () => {
    const declined = {
      ...FRESH_QUOTE,
      quote_sent_at: '2026-06-20T00:00:00Z',
      ghl_stage_synced_at: '2026-06-20T00:00:01Z',
      status: 'declined',
      decline_reason: 'Went with a competitor',
    };
    const { client, updatePayloads } = makeSb(declined);
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.alreadySent).toBeUndefined();
    expect(json.revived).toBe(true);
    // status re-stamped to 'sent', quote_sent_at re-stamped to a fresh time
    const stampWrite = updatePayloads.find((p) => 'status' in p && p.status === 'sent');
    expect(stampWrite).toBeTruthy();
    expect(stampWrite!.quote_sent_at).not.toBe('2026-06-20T00:00:00Z');
    // messaging + GHL card move fired, same as any fresh send
    expect(hl.sendSms).toHaveBeenCalled();
    expect(hl.sendEmail).toHaveBeenCalled();
    expect(hl.updateOpportunity).toHaveBeenCalled();
  });

  it('revives a LOST quote the same way', async () => {
    const lost = {
      ...FRESH_QUOTE,
      quote_sent_at: '2026-06-20T00:00:00Z',
      status: 'lost',
    };
    const { client, updatePayloads } = makeSb(lost);
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.revived).toBe(true);
    const stampWrite = updatePayloads.find((p) => 'status' in p && p.status === 'sent');
    expect(stampWrite).toBeTruthy();
    expect(hl.sendSms).toHaveBeenCalled();
  });

  it('a revive write clears customer_approved_at + viewed_at (the deriveStatus resurrection proof)', async () => {
    // #124 lets declined fire from 'approved', so a declined row CAN carry a
    // stale customer_approved_at (and viewed_at, from the original send). If
    // the revive write didn't clear both, deriveStatus's timestamp fallback
    // would read 'approved'/'viewed' instead of 'sent' on the very next load
    // (see quoteStatus.test.ts — deriveStatus only trusts the persisted
    // status column for declined/cancelled/lost/changes_requested, NOT sent).
    const approvedThenDeclined = {
      ...FRESH_QUOTE,
      quote_sent_at: '2026-06-20T00:00:00Z',
      viewed_at: '2026-06-20T01:00:00Z',
      customer_approved_at: '2026-06-21T00:00:00Z',
      status: 'declined',
    };
    const { client, updatePayloads } = makeSb(approvedThenDeclined);
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);

    const stampWrite = updatePayloads.find((p) => 'status' in p && p.status === 'sent');
    expect(stampWrite).toBeTruthy();
    expect(stampWrite!.customer_approved_at).toBeNull();
    expect(stampWrite!.viewed_at).toBeNull();
  });

  it('refuses to revive a DECLINED quote with a deposit already paid — 409, fail closed, no writes', async () => {
    // Belt-and-braces: canRevive statuses shouldn't carry a paid deposit (the
    // decline routes guard on deposit_paid_at IS NULL), but a data-drifted row
    // must never sneak a paid quote back open.
    const paidButDeclined = {
      ...FRESH_QUOTE,
      quote_sent_at: '2026-06-20T00:00:00Z',
      deposit_paid_at: '2026-06-19T00:00:00Z',
      status: 'declined',
    };
    const { client, updatePayloads } = makeSb(paidButDeclined);
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(typeof json.error).toBe('string');
    expect(updatePayloads.length).toBe(0);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('a CANCELLED quote does NOT revive — still short-circuits alreadySent (rebook-only, #116)', async () => {
    const cancelled = {
      ...FRESH_QUOTE,
      quote_sent_at: '2026-06-20T00:00:00Z',
      ghl_stage_synced_at: '2026-06-20T00:00:01Z',
      status: 'cancelled',
    };
    const { client, updatePayloads } = makeSb(cancelled);
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(json.alreadySent).toBe(true);
    expect(json.revived).toBeUndefined();
    expect(updatePayloads.length).toBe(0);
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });

  it('double-click idempotency: a second revive call short-circuits as alreadySent (parity with changes_requested resend)', async () => {
    const declined = {
      ...FRESH_QUOTE,
      quote_sent_at: '2026-06-20T00:00:00Z',
      status: 'declined',
    };
    const { client } = makeSb(declined);
    sbRef.current = client;

    const first = await POST(makeReq(), { params });
    expect((await first.json()).revived).toBe(true);

    // Simulate the row as it reads immediately after the first revive:
    // status='sent', quote_sent_at re-stamped, customer_approved_at/viewed_at
    // cleared — a second call against THAT row must behave like any other
    // already-sent quote, not re-revive or double-message.
    const nowSent = { ...declined, status: 'sent', customer_approved_at: null, viewed_at: null };
    const { client: client2 } = makeSb(nowSent);
    sbRef.current = client2;
    vi.clearAllMocks();
    hl.configured.value = true;

    const second = await POST(makeReq(), { params });
    const json2 = await second.json();
    expect(json2.alreadySent).toBe(true);
    expect(hl.sendSms).not.toHaveBeenCalled();
  });

  it('an is_test declined quote revives like any test send: stamps sent, never messages or moves a real GHL card', async () => {
    const testDeclined = {
      ...FRESH_QUOTE,
      highlevel_contact_id: null,
      highlevel_opportunity_id: null,
      quote_sent_at: '2026-06-20T00:00:00Z',
      status: 'declined',
      is_test: true,
    };
    const { client, updatePayloads } = makeSb(testDeclined);
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.revived).toBe(true);
    const stampWrite = updatePayloads.find((p) => 'status' in p && p.status === 'sent');
    expect(stampWrite).toBeTruthy();
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });

  it('preserves decline_reason / approval_snapshot audit fields — the revive write never touches them', async () => {
    const declined = {
      ...FRESH_QUOTE,
      quote_sent_at: '2026-06-20T00:00:00Z',
      status: 'declined',
      decline_reason: 'Too expensive',
      approval_snapshot: { staffDeclined: { by: 'ops@example.com', at: '2026-06-20T00:00:00Z', reason: null } },
    };
    const { client, updatePayloads } = makeSb(declined);
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    // No write ever touches decline_reason or approval_snapshot — they're left
    // as historical audit trail (the row still HAS them; we just never wrote them).
    expect(updatePayloads.some((p) => 'decline_reason' in p)).toBe(false);
    expect(updatePayloads.some((p) => 'approval_snapshot' in p)).toBe(false);
  });
});

describe('POST /api/quotes/[id]/send — per-service-type pipeline (#GHL pipeline sync)', () => {
  it('a permanent quote moves its card in the PERMANENT pipeline, ignoring the legacy env vars', async () => {
    const { client } = makeSb({ ...FRESH_QUOTE, service_type: 'permanent' });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    // env vars (HIGHLEVEL_STAGE_QUOTE_SENT / HIGHLEVEL_PIPELINE_ID) are set in
    // beforeEach to 'stage_bid_sent' / 'pipeline_1' — a permanent quote must NOT
    // use them; it moves in its own hardcoded "Proposal Sent" stage instead.
    expect(hl.updateOpportunity).toHaveBeenCalledWith(
      'opp_1',
      expect.objectContaining({ pipelineStageId: '4e507d3d-a939-44c3-a448-250a4b0ed353' }),
    );
  });

  it('an event quote moves its card in the EVENT pipeline', async () => {
    const { client } = makeSb({ ...FRESH_QUOTE, service_type: 'event' });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).toHaveBeenCalledWith(
      'opp_1',
      expect.objectContaining({ pipelineStageId: 'b2262023-6986-4727-98e6-638ce45aedfe' }),
    );
  });

  it('a holiday quote (explicit or missing service_type) still honors the legacy env vars', async () => {
    const { client } = makeSb({ ...FRESH_QUOTE, service_type: 'holiday' });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).toHaveBeenCalledWith(
      'opp_1',
      expect.objectContaining({ pipelineStageId: 'stage_bid_sent' }),
    );
  });

  it('a fresh permanent-quote card is created in the permanent pipeline when none is linked', async () => {
    const { client } = makeSb({
      ...FRESH_QUOTE,
      service_type: 'permanent',
      highlevel_opportunity_id: null,
    });
    sbRef.current = client;
    hl.findOpportunityForContact.mockResolvedValueOnce(null);

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(hl.findOpportunityForContact).toHaveBeenCalledWith('contact_1', 'OqpjVflTdgmjmUQmbcSF');
    expect(hl.createOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: 'OqpjVflTdgmjmUQmbcSF',
        pipelineStageId: '4e507d3d-a939-44c3-a448-250a4b0ed353',
      }),
    );
  });

  // #172: GHL locations that forbid a second opportunity per contact 400 the
  // create when the contact's only card is won/lost/abandoned (the find above
  // skips non-open cards). The send route must resurrect that card at Bid
  // Sent instead of failing the stage sync.
  it('#172: a duplicate-card create resurrects the existing card at Bid Sent', async () => {
    const { client } = makeSb({ ...FRESH_QUOTE, highlevel_opportunity_id: null });
    sbRef.current = client;
    hl.findOpportunityForContact.mockResolvedValueOnce(null);
    hl.createOpportunity.mockRejectedValueOnce(new Error('OPPORTUNITY_NO_DUPLICATE'));
    hl.resurrectDuplicateOpportunity.mockResolvedValueOnce({ id: 'opp_abandoned' });

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ghlSynced).toBe(true);
    expect(hl.resurrectDuplicateOpportunity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pipelineStageId: 'stage_bid_sent' }),
    );
  });

  it('#172: a non-duplicate create failure still fails the stage sync (no resurrect)', async () => {
    const { client } = makeSb({ ...FRESH_QUOTE, highlevel_opportunity_id: null });
    sbRef.current = client;
    hl.findOpportunityForContact.mockResolvedValueOnce(null);
    hl.createOpportunity.mockRejectedValueOnce(new Error('GHL 500'));
    hl.resurrectDuplicateOpportunity.mockResolvedValueOnce(null);

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ghlSynced).toBe(false);
    // No card was linked and the helper declined — nothing may be PUT.
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });
});

describe('POST /api/quotes/[id]/send — quote-link custom field stamp', () => {
  beforeEach(() => {
    // FRESH_QUOTE carries no service_type, which resolves to the default
    // (holiday) — so the holiday-specific field var is what's read unless a
    // test overrides service_type.
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_quote_link_holiday';
  });

  it('stamps the exact portal URL onto the contact once the card move succeeds', async () => {
    const { client } = makeSb({ ...FRESH_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith(
      'contact_1',
      'field_quote_link_holiday',
      'https://quote.example.com/portal/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
  });

  it('a PERMANENT quote stamps using the PERMANENT var\'s id, not the holiday one', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_PERMANENT = 'field_quote_link_permanent';
    const { client } = makeSb({ ...FRESH_QUOTE, service_type: 'permanent' });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith(
      'contact_1',
      'field_quote_link_permanent',
      'https://quote.example.com/portal/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_PERMANENT;
  });

  it('skips silently (one warn, no throw) when HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY is unset', async () => {
    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = makeSb({ ...FRESH_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY not set'),
    );
    warn.mockRestore();
  });

  it('never stamps for a TEST quote', async () => {
    const { client } = makeSb({ ...FRESH_QUOTE, is_test: true, highlevel_contact_id: null, highlevel_opportunity_id: null });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
  });

  it('does not fail the send when the custom field stamp throws (best-effort)', async () => {
    hl.upsertContactCustomField.mockRejectedValueOnce(new Error('GHL down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = makeSb({ ...FRESH_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('quote-link custom field stamp failed'),
      expect.anything(),
    );
    err.mockRestore();
  });
});


describe('POST /api/quotes/[id]/send — portal and delivery gates', () => {
  // #176 — a staff-flagged browse-only quote can never be sent: a real send
  // would reuse/overwrite the contact's open GHL card and re-stamp their
  // quote-link field with the browse-only portal URL.
  it('409s (view-only) before any stamp, GHL call, or customer message', async () => {
    const { client, updatePayloads } = makeSb({ ...FRESH_QUOTE, view_only: true });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe('view-only');
    expect(updatePayloads).toHaveLength(0);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
    expect(hl.createOpportunity).not.toHaveBeenCalled();
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  // #187b TOCTOU: the fresh-send stamp write itself re-asserts view_only AND
  // deposit_paid_at, so a race landing AFTER the fast-path checks above (but
  // before this write) can't sneak a real stamp/GHL/message through.
  describe('#187b — fresh-send stamp TOCTOU guard', () => {
    it('409s and does no GHL/messaging work when view_only flips ON between fetch and stamp', async () => {
      const { client, updatePayloads } = makeSb({ ...FRESH_QUOTE }, { stampRace: true });
      sbRef.current = client;

      const res = await POST(makeReq(), { params });
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.code).toBe('send-conflict');
      // The stamp write was attempted (and lost the race) — no other update
      // (GHL sync-state, quote-link field, etc.) followed it.
      expect(updatePayloads).toHaveLength(1);
      expect(updatePayloads[0]).toMatchObject({ status: 'sent' });
      expect(hl.updateOpportunity).not.toHaveBeenCalled();
      expect(hl.createOpportunity).not.toHaveBeenCalled();
      expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
      expect(hl.sendSms).not.toHaveBeenCalled();
      expect(hl.sendEmail).not.toHaveBeenCalled();
    });

    it('409s when deposit_paid_at appears between fetch and stamp (belt-and-suspenders on a revive)', async () => {
      const declined = { ...FRESH_QUOTE, status: 'declined', quote_sent_at: '2026-06-01T00:00:00.000Z' };
      const { client, updatePayloads } = makeSb(declined, { stampRace: true });
      sbRef.current = client;

      const res = await POST(makeReq(), { params });
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.code).toBe('send-conflict');
      expect(updatePayloads).toHaveLength(1);
      expect(hl.updateOpportunity).not.toHaveBeenCalled();
      expect(hl.sendSms).not.toHaveBeenCalled();
      expect(hl.sendEmail).not.toHaveBeenCalled();
    });

    it('still sends normally when the stamp write does NOT lose the race', async () => {
      const { client, updatePayloads } = makeSb({ ...FRESH_QUOTE });
      sbRef.current = client;

      const res = await POST(makeReq(), { params });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(updatePayloads.some((p) => 'quote_sent_at' in p)).toBe(true);
    });
  });

  it('rejects a zero-line-item quote before stamping or contacting HighLevel', async () => {
    const { client, updatePayloads } = makeSb({
      ...FRESH_QUOTE,
      total: 0,
      result: { total: 0, lineItems: [] },
    });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe('empty-quote');
    expect(updatePayloads).toHaveLength(0);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('returns 502 when every requested customer channel fails', async () => {
    hl.sendSms.mockRejectedValueOnce(new Error('SMS down'));
    hl.sendEmail.mockRejectedValueOnce(new Error('Email down'));
    const { client, updatePayloads } = makeSb({ ...FRESH_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReqWithBody({ channel: 'both' }), { params });
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json).toMatchObject({
      ok: false,
      code: 'delivery-failed',
      locallySent: true,
      failedChannels: ['sms', 'email'],
    });
    expect(updatePayloads.some((p) => 'quote_sent_at' in p)).toBe(true);
  });

  it('returns success with a channel receipt when at least one requested channel delivers', async () => {
    hl.sendSms.mockRejectedValueOnce(new Error('SMS down'));
    const { client } = makeSb({ ...FRESH_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReqWithBody({ channel: 'both' }), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.smsSent).toBe(false);
    expect(json.emailSent).toBe(true);
    expect(json.failedChannels).toEqual(['sms']);
  });

  it('retries only customer delivery without re-stamping or moving the CRM card', async () => {
    const { client, updatePayloads } = makeSb({
      ...FRESH_QUOTE,
      quote_sent_at: '2026-07-18T12:00:00.000Z',
      ghl_stage_synced_at: '2026-07-18T12:00:01.000Z',
      status: 'sent',
    });
    sbRef.current = client;

    const res = await POST(makeReqWithBody({ channel: 'sms' }, true), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.deliveryRetry).toBe(true);
    expect(json.smsSent).toBe(true);
    expect(hl.sendEmail).not.toHaveBeenCalled();
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
    expect(updatePayloads.some((p) => 'quote_sent_at' in p)).toBe(false);
  });
});

describe('POST /api/quotes/[id]/send — NCE + YLL Neighbor tag propagation (#198)', () => {
  // #214: attach-first even when a cached customer_id exists — the cached
  // link can be stale after an identity edit (verify-or-reattach). Here the
  // re-resolution can't produce an answer (mock returns null), so the cached
  // id is the fallback and the tag still lands.
  it('re-verifies via attachQuoteToCustomer even when ALREADY linked, falling back to the cached id when re-resolution yields nothing', async () => {
    const { client } = makeSb({ ...FRESH_QUOTE, legacy_rebook: true, is_nce: true, customer_id: 'cust-1' });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(attachQuoteToCustomerMock).toHaveBeenCalledOnce();
    expect(propagateMock).toHaveBeenCalledWith('cust-1', { isNce: true, isYllNeighbor: true });
  });

  it('propagates to the RE-RESOLVED customer (not the cached id) when re-attach lands on a different row — the stale-link heal', async () => {
    attachQuoteToCustomerMock.mockResolvedValueOnce({ customerId: 'cust-right', propertyId: 'prop-1' });
    const { client } = makeSb({ ...FRESH_QUOTE, legacy_rebook: true, is_nce: true, customer_id: 'cust-stale' });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(propagateMock).toHaveBeenCalledWith('cust-right', { isNce: true, isYllNeighbor: true });
  });

  it('re-attaches via attachQuoteToCustomer when tagged but NOT yet linked, then propagates to the resolved customer', async () => {
    attachQuoteToCustomerMock.mockResolvedValueOnce({ customerId: 'cust-resolved', propertyId: 'prop-1' });
    const { client } = makeSb({
      ...FRESH_QUOTE,
      legacy_rebook: false,
      is_nce: true,
      customer_id: null,
      customer_email: 'jane@x.com',
    });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(attachQuoteToCustomerMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: ID, customer_email: 'jane@x.com' }),
    );
    expect(propagateMock).toHaveBeenCalledWith('cust-resolved', { isNce: true, isYllNeighbor: false });
  });

  it('does NOT attach or propagate when the quote carries neither tag', async () => {
    const { client } = makeSb({ ...FRESH_QUOTE, legacy_rebook: false, is_nce: false, customer_id: null });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
    expect(propagateMock).not.toHaveBeenCalled();
  });

  // Review fix (admin HIGH, S34 #198 review): a tagged TEST quote must never
  // run attach/propagation with test data — orphan real customer rows or a
  // merge-overwrite of a REAL customer's identity fields, then tagging that
  // real customer, would break the "test quotes never touch customers"
  // invariant #200's tenure push also depends on.
  it('does NOT attach or propagate for a TAGGED TEST quote, even unlinked — the send still succeeds', async () => {
    const { client } = makeSb({
      ...FRESH_QUOTE,
      is_test: true,
      legacy_rebook: true,
      is_nce: true,
      customer_id: null,
    });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
    expect(propagateMock).not.toHaveBeenCalled();
  });

  it('does NOT attach or propagate for a TAGGED TEST quote that IS already linked', async () => {
    const { client } = makeSb({
      ...FRESH_QUOTE,
      is_test: true,
      legacy_rebook: true,
      is_nce: true,
      customer_id: 'cust-1',
    });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
    expect(propagateMock).not.toHaveBeenCalled();
  });

  it('does NOT propagate when the re-attach attempt resolves to no customer', async () => {
    attachQuoteToCustomerMock.mockResolvedValueOnce(null); // no identity to link (e.g. address-only quote)
    const { client } = makeSb({ ...FRESH_QUOTE, is_nce: true, customer_id: null });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(propagateMock).not.toHaveBeenCalled();
  });

  it('does NOT re-run propagation on a ?retryGhl reconcile (no fresh stamp)', async () => {
    const { client } = makeSb({
      ...FRESH_QUOTE,
      is_nce: true,
      customer_id: 'cust-1',
      quote_sent_at: '2026-07-18T12:00:00.000Z',
      ghl_stage_synced_at: null,
      status: 'sent',
    });
    sbRef.current = client;

    const res = await POST(makeReq(true), { params }); // retryGhl=true
    expect(res.status).toBe(200);
    expect(propagateMock).not.toHaveBeenCalled();
  });

  it('still sends successfully when the re-attach attempt throws (best-effort)', async () => {
    attachQuoteToCustomerMock.mockRejectedValueOnce(new Error('customers table missing'));
    const { client } = makeSb({ ...FRESH_QUOTE, is_nce: true, customer_id: null });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(propagateMock).not.toHaveBeenCalled();
  });

  it('still sends successfully when propagation itself throws (best-effort)', async () => {
    propagateMock.mockRejectedValueOnce(new Error('customers table missing'));
    const { client } = makeSb({ ...FRESH_QUOTE, is_nce: true, customer_id: 'cust-1' });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });
});
