// Tests for POST /api/quotes/[id]/send — focused on the audit fix
// (send-route-ghl-sync-state, finding #32): the GHL pipeline stage-sync
// outcome must be persisted durably (ghl_stage_synced_at / ghl_sync_error),
// and a ?retryGhl reconcile must re-run ONLY the GHL block (no re-stamp, no
// re-message) for an already-sent quote whose card never advanced.
//
// Supabase + the HighLevel client are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { sbRef, hl, attachQuoteToCustomerMock, propagateMock, queueQuoteBuildSessionCompletionMock } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  // #198: mocked so (a) the existing legacy_rebook fixture (no customer_id set)
  // doesn't hit the real attachQuoteToCustomer against this file's Supabase
  // fake (which lacks .maybeSingle()), and (b) the tag-propagation tests below
  // can assert on it directly.
  attachQuoteToCustomerMock: vi.fn(async () => null as null | { customerId: string; propertyId: string }),
  propagateMock: vi.fn(async () => {}),
  queueQuoteBuildSessionCompletionMock: vi.fn(),
  hl: {
    updateOpportunity: vi.fn(async () => ({ id: 'opp_1' })),
    createOpportunity: vi.fn(async () => ({ id: 'opp_new' })),
    findOpportunityForContact: vi.fn(async () => null as { id: string } | null),
    resurrectDuplicateOpportunity: vi.fn(async (_err: unknown, _input: unknown) => null as { id: string } | null),
    // #237: typed with its real (contactId, fieldId, value) signature (was
    // zero-arg) so the event-date failure-is-soft test below can
    // discriminate its mockImplementation by fieldId.
    upsertContactCustomField: vi.fn(async (_contactId: string, _fieldId: string, _value: string | string[]) => undefined as void),
    // #250: typed to allow tests to resolve a GHL-shaped { messageId } so the
    // quote_deliveries provider_message_id capture can be asserted.
    sendSms: vi.fn(async () => undefined as { messageId?: string } | undefined),
    sendEmail: vi.fn(async () => undefined as { messageId?: string } | undefined),
    configured: { value: true },
    // #237: the event-date custom-field push (src/lib/integrations/
    // ghlEventDate.ts) resolves its field id through these two — real module,
    // mocked GHL client, same as everything else in this file. Default: an
    // already-existing "Event Date" field, so most tests never need the
    // create path.
    listLocationCustomFields: vi.fn(async () => [{ id: 'ed_field_1', name: 'Event Date' }] as Array<{ id: string; name: string }>),
    createLocationCustomField: vi.fn(async (_input: { name: string; dataType: string }) => ({
      id: 'ed_field_created',
      name: 'Event Date',
    })),
  },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
  getSupabaseClient: () => sbRef.current,
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimitResponse: () => null,
}));

vi.mock('@/lib/quoteBuildTiming', () => ({
  queueQuoteBuildSessionCompletion: queueQuoteBuildSessionCompletionMock,
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
  // #237: event-date custom-field resolution (see ghlEventDate.ts).
  listLocationCustomFields: hl.listLocationCustomFields,
  createLocationCustomField: hl.createLocationCustomField,
  // #264 round 2: constructor now mirrors the real class exactly (message,
  // status, body, timedOut) so a test can construct a timed-out error the
  // same way ghlFetch does, instead of hand-setting fields after the fact.
  HighLevelError: class HighLevelError extends Error {
    constructor(message: string, public status?: number, public body?: string, public timedOut?: boolean) {
      super(message);
      this.name = 'HighLevelError';
    }
  },
}));

vi.mock('@/lib/integrations/quoteMessages', () => ({
  quoteEmailSubject: () => 'subj',
  quoteSmsBody: () => 'sms',
  quoteEmailHtml: () => '<p>email</p>',
}));

import { POST } from './route';
import { HighLevelError } from '@/lib/integrations/highlevel';
// #237: resolveEventDateFieldId caches the resolved field id at module scope
// (mirrors ghlTenure.ts) — reset it every test so one test's resolution
// doesn't silently skip another test's listLocationCustomFields call.
import { resetEventDateFieldCacheForTests } from '@/lib/integrations/ghlEventDate';
import { DELIVERY_TIMEOUT_ERROR_PREFIX } from '@/lib/quoteDeliveries';

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
//
// #250: `.insert()` support for quote_deliveries. `from(table)` records the
// table name so an insert can be attributed; `opts.insertError` simulates a
// logging-table failure (must never fail the send — see the tests below).
type Quote = Record<string, unknown> | null;
function makeSb(
  quote: Quote,
  opts: { stampRace?: boolean; insertError?: string } = {},
) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  const insertPayloads: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const builder: Record<string, unknown> = {};
  let isUpdate = false;
  let isInsert = false;
  let lastUpdateIsStamp = false;
  let lastTable = '';
  Object.assign(builder, {
    from: (table: string) => {
      lastTable = table;
      return builder;
    },
    select: () => builder,
    update: (payload: Record<string, unknown>) => {
      isUpdate = true;
      lastUpdateIsStamp = 'quote_sent_at' in payload;
      updatePayloads.push(payload);
      return builder;
    },
    insert: (payload: Record<string, unknown>) => {
      isInsert = true;
      insertPayloads.push({ table: lastTable, payload });
      return builder;
    },
    eq: () => builder,
    is: () => builder,
    // #264: real route code now chains `.abortSignal(signal)` on every direct
    // query (see withDbTimeout in route.ts) — no-op passthrough here, same
    // shape as eq()/is() above; the timeout behavior itself is covered by
    // highlevel.test.ts (ghlFetch) and quoteDeliveries.test.ts (the DB insert),
    // not re-proven per call site in this file.
    abortSignal: () => builder,
    single: async () => ({ data: quote, error: quote ? null : { message: 'no row' } }),
    then: (resolve: (v: unknown) => void) => {
      let res: unknown;
      if (isInsert) {
        res = opts.insertError
          ? { data: null, error: { message: opts.insertError } }
          : { data: null, error: null };
      } else if (isUpdate) {
        const raceLost = lastUpdateIsStamp && opts.stampRace;
        res = { data: raceLost ? [] : [{ id: (quote as { id?: string } | null)?.id ?? ID }], error: null };
      } else {
        res = { data: quote, error: null };
      }
      isUpdate = false;
      isInsert = false;
      resolve(res);
    },
  });
  return { client: builder, updatePayloads, insertPayloads };
}

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TIMER_ID = '11111111-2222-4333-8444-555555555555';

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
  resetEventDateFieldCacheForTests();
});

describe('POST /api/quotes/[id]/send — quote build timing', () => {
  it('completes the supplied timer once on the first real local-send stamp', async () => {
    const { client } = makeSb({ ...FRESH_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReqWithBody({ quoteBuildTimerId: TIMER_ID }), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(queueQuoteBuildSessionCompletionMock).toHaveBeenCalledOnce();
    expect(queueQuoteBuildSessionCompletionMock).toHaveBeenCalledWith({
      quoteId: ID,
      timerId: TIMER_ID,
      sentAt: json.sentAt,
    });
  });

  it.each([
    ['test send', { ...FRESH_QUOTE, is_test: true, highlevel_contact_id: null, highlevel_opportunity_id: null }, false],
    ['already sent', { ...FRESH_QUOTE, quote_sent_at: '2026-08-20T12:00:00.000Z', status: 'sent' }, false],
    ['changes-requested resend', { ...FRESH_QUOTE, quote_sent_at: '2026-08-20T12:00:00.000Z', status: 'changes_requested' }, false],
    ['delivery retry', { ...FRESH_QUOTE, quote_sent_at: '2026-08-20T12:00:00.000Z', status: 'sent' }, true],
  ])('does not add a timing sample for a %s', async (_label, quote, retryDelivery) => {
    const { client } = makeSb(quote);
    sbRef.current = client;

    await POST(makeReqWithBody({ quoteBuildTimerId: TIMER_ID }, retryDelivery), { params });

    expect(queueQuoteBuildSessionCompletionMock).not.toHaveBeenCalled();
  });

  it('ignores a malformed optional timer id instead of blocking customer delivery', async () => {
    const { client } = makeSb({ ...FRESH_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReqWithBody({ quoteBuildTimerId: 'bad' }), { params });

    expect(res.status).toBe(200);
    expect(queueQuoteBuildSessionCompletionMock).toHaveBeenCalledWith(
      expect.objectContaining({ quoteId: ID, timerId: null }),
    );
  });
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

describe('POST /api/quotes/[id]/send — #116 revive (declined/abandoned re-send)', () => {
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

  it('revives an ABANDONED quote the same way', async () => {
    const abandoned = {
      ...FRESH_QUOTE,
      quote_sent_at: '2026-06-20T00:00:00Z',
      status: 'abandoned',
    };
    const { client, updatePayloads } = makeSb(abandoned);
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
    // status column for declined/cancelled/abandoned/changes_requested, NOT sent).
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

  // Row 271: a FRESH send still runs ghlStageChain concurrently with the
  // (failing) customer delivery — a split failure (bad phone/bounced email,
  // but the GHL card move succeeds) must be visible on the 502 body, not
  // just the 200 body, or the operator's "no message was delivered" alert
  // hides that the CRM card already moved to Bid Sent.
  it('502 delivery-failed body carries the real GHL stage outcome on a FRESH send', async () => {
    hl.sendSms.mockRejectedValueOnce(new Error('SMS down'));
    hl.sendEmail.mockRejectedValueOnce(new Error('Email down'));
    const { client } = makeSb({ ...FRESH_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReqWithBody({ channel: 'both' }), { params });
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.deliveryRetry).toBe(false);
    // FRESH_QUOTE already carries highlevel_opportunity_id: 'opp_1', and
    // hl.updateOpportunity's default mock resolves — so the card move
    // actually succeeded even though every customer channel failed.
    expect(json.stageUpdated).toBe(true);
    expect(json.stageError).toBeUndefined();
    expect(json.opportunityId).toBe('opp_1');
    expect(json.ghlSynced).toBe(true);
  });

  // Row 271 retry variant: ghlStageChain returns immediately for
  // isDeliveryRetry (route.ts, ~line 495) without touching stageUpdated/
  // stageError/opportunityId — they stay at their pre-chain values. That's
  // the honest answer for a delivery-only retry: it never attempted the
  // stage move at all (not "attempted and failed"), so stageUpdated:false /
  // stageError:undefined here means "not touched this call," matching what
  // the same retry's 200 body already reports today.
  it('502 delivery-failed body on a delivery-only RETRY reports the stage as untouched, not failed', async () => {
    hl.sendSms.mockRejectedValueOnce(new Error('SMS down'));
    const { client } = makeSb({
      ...FRESH_QUOTE,
      quote_sent_at: '2026-07-18T12:00:00.000Z',
      ghl_stage_synced_at: '2026-07-18T12:00:01.000Z',
      status: 'sent',
    });
    sbRef.current = client;

    const res = await POST(makeReqWithBody({ channel: 'sms' }, true), { params });
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.deliveryRetry).toBe(true);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
    expect(json.stageUpdated).toBe(false);
    expect(json.stageError).toBeUndefined();
    // opportunityId is untouched by ghlStageChain on a retry — it still
    // reflects whatever was already on the row (FRESH_QUOTE's 'opp_1'), not
    // a fresh resolution from this call.
    expect(json.opportunityId).toBe('opp_1');
    // ghlSynced still reflects the row's PERSISTED sync state on a retry
    // (this fixture's ghl_stage_synced_at is already set from a prior send),
    // same expression the 200 body uses — stageUpdated:false alone would
    // otherwise wrongly read as "never synced."
    expect(json.ghlSynced).toBe(true);
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

  // #241 defect 2 (review MEDIUM): isDeliveryRetry is only honored while
  // currentStatus is 'sent'/'viewed' (W1-017's same guard, reused). A quote
  // that progressed to approved/booked/deposit-paid between the original
  // send and a Force-Redeliver click falls through to the plain alreadySent
  // short-circuit below — same as a fresh send would. Pin that a retry gets
  // NO special pass around that guard: it must never deliver, and the
  // response must carry nothing that looks like a receipt, so the client
  // can tell "retry also did nothing" apart from "retry delivered."
  it('a retryDelivery request against a since-BOOKED quote also short-circuits as alreadySent — never delivers', async () => {
    const bookedButRetried = {
      ...FRESH_QUOTE,
      quote_sent_at: '2026-07-18T12:00:00.000Z',
      customer_approved_at: '2026-07-19T00:00:00.000Z',
      deposit_paid_at: '2026-07-20T00:00:00.000Z', // deriveStatus → 'booked'
      ghl_stage_synced_at: '2026-07-18T12:00:01.000Z',
      status: 'booked',
    };
    const { client, updatePayloads } = makeSb(bookedButRetried);
    sbRef.current = client;

    const res = await POST(makeReqWithBody({ channel: 'both' }, true), { params });
    const json = await res.json();

    expect(json.alreadySent).toBe(true);
    expect(json.deliveryRetry).toBeUndefined();
    expect(json.smsSent).toBeUndefined();
    expect(json.emailSent).toBeUndefined();
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.sendEmail).not.toHaveBeenCalled();
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
    expect(updatePayloads).toHaveLength(0);
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

describe('POST /api/quotes/[id]/send — quote delivery log (#250)', () => {
  it('writes a "sent" quote_deliveries row for each channel on a successful fresh send', async () => {
    hl.sendSms.mockResolvedValueOnce({ messageId: 'sms_msg_1' });
    hl.sendEmail.mockResolvedValueOnce({ messageId: 'email_msg_1' });
    const { client, insertPayloads } = makeSb({ ...FRESH_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);

    const deliveryRows = insertPayloads.filter((p) => p.table === 'quote_deliveries');
    expect(deliveryRows).toHaveLength(2);
    expect(deliveryRows).toContainEqual({
      table: 'quote_deliveries',
      payload: {
        quote_id: ID,
        channel: 'sms',
        outcome: 'sent',
        provider_message_id: 'sms_msg_1',
        error: null,
      },
    });
    expect(deliveryRows).toContainEqual({
      table: 'quote_deliveries',
      payload: {
        quote_id: ID,
        channel: 'email',
        outcome: 'sent',
        provider_message_id: 'email_msg_1',
        error: null,
      },
    });
  });

  // Row 269 fix round 2 (delta-verify HIGH): this mock was originally a
  // generic `new Error('SMS down')` — under the WIDENED hedge discriminator
  // (timeoutHedgedErrorMessage in route.ts now hedges anything that isn't a
  // status-bearing HighLevelError, not just HighLevelError#timedOut), a
  // generic non-HighLevelError error is itself an outcome-unknown case and
  // would now get hedged too, which would have silently invalidated this
  // test's "confirmed failure" premise. Switched to a HighLevelError carrying
  // a real HTTP status (the brief's own example: a rejected phone number),
  // which is the genuine "GHL definitively rejected it" case this test means
  // to demonstrate — and stays unhedged under the new logic, proving the
  // round-1 over-gating fix still works on its actual target.
  it('writes a "failed" row with the error for a channel that fails, and a "sent" row for the one that succeeds', async () => {
    hl.sendSms.mockRejectedValueOnce(new HighLevelError('HighLevel POST /conversations/messages → 400: SMS down', 400));
    hl.sendEmail.mockResolvedValueOnce({ messageId: 'email_msg_1' });
    const { client, insertPayloads } = makeSb({ ...FRESH_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);

    const deliveryRows = insertPayloads.filter((p) => p.table === 'quote_deliveries');
    const smsRow = deliveryRows.find((p) => p.payload.channel === 'sms');
    const emailRow = deliveryRows.find((p) => p.payload.channel === 'email');
    expect(smsRow?.payload).toMatchObject({
      quote_id: ID,
      channel: 'sms',
      outcome: 'failed',
      provider_message_id: null,
    });
    expect(smsRow?.payload.error).toContain('SMS down');
    // A real HTTP-status rejection is a DEFINITIVE answer from GHL — proves
    // it is NOT hedged (the sibling TIMED-OUT/ambiguous tests below prove the
    // opposite cases ARE hedged).
    expect((smsRow?.payload.error as string).startsWith(DELIVERY_TIMEOUT_ERROR_PREFIX)).toBe(false);
    expect(emailRow?.payload).toMatchObject({
      quote_id: ID,
      channel: 'email',
      outcome: 'sent',
      provider_message_id: 'email_msg_1',
      error: null,
    });
  });

  // #264 round 2, FIX 8: closes the untested-contract gap — proves a timed-out
  // send (HighLevelError#timedOut, the exact shape ghlFetch throws) logs an
  // 'error' string starting with the EXPORTED DELIVERY_TIMEOUT_ERROR_PREFIX
  // (src/lib/quoteDeliveries.ts), not just some ad hoc "timeout" substring —
  // a future reporting query matches on the real exported contract.
  it('a TIMED-OUT send logs outcome:"failed" with an error starting with DELIVERY_TIMEOUT_ERROR_PREFIX (honesty hedge)', async () => {
    hl.sendSms.mockRejectedValueOnce(
      new HighLevelError('HighLevel POST /conversations/messages timed out after 10000ms (connecting)', undefined, undefined, true),
    );
    hl.sendEmail.mockResolvedValueOnce({ messageId: 'email_msg_1' });
    const { client, insertPayloads } = makeSb({ ...FRESH_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);

    const deliveryRows = insertPayloads.filter((p) => p.table === 'quote_deliveries');
    const smsRow = deliveryRows.find((p) => p.payload.channel === 'sms');
    expect(smsRow?.payload.outcome).toBe('failed');
    expect((smsRow?.payload.error as string).startsWith(DELIVERY_TIMEOUT_ERROR_PREFIX)).toBe(true);
    expect(smsRow?.payload.error as string).toContain('delivery outcome unknown');
    // The sibling "failed" test above (real HTTP-status rejection) pins the
    // unhedged case explicitly; this test pins the hedged one — together they
    // prove the discriminator, not just one side of it.
  });

  // Row 269 fix round 2 (delta-verify HIGH — the fix this test targets): a
  // NON-timeout, NON-HTTP-status failure (a socket reset, DNS failure,
  // connection refused — anything ghlFetch's own `catch (err) { if
  // (controller.signal.aborted) throw timeoutError(...); throw err; }`
  // rethrows raw when OUR abort wasn't the cause) must be hedged exactly like
  // a real timeout, because we never learned GHL's true answer either way.
  // Round 1 read this as a CONFIRMED failure (HighLevelError#timedOut was
  // false) and granted a plain window.confirm redeliver — the exact gap this
  // round closes. Modeled here as a bare non-HighLevelError Error (no
  // `status`, no `timedOut`), the realistic shape of a raw fetch()-thrown
  // network failure that never reached HighLevelError's !res.ok branch.
  it('a NON-timeout, NON-HTTP-status failure (e.g. a socket reset) is hedged exactly like a timeout', async () => {
    hl.sendSms.mockRejectedValueOnce(new Error('fetch failed: socket hang up'));
    hl.sendEmail.mockResolvedValueOnce({ messageId: 'email_msg_1' });
    const { client, insertPayloads } = makeSb({ ...FRESH_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);

    const deliveryRows = insertPayloads.filter((p) => p.table === 'quote_deliveries');
    const smsRow = deliveryRows.find((p) => p.payload.channel === 'sms');
    expect(smsRow?.payload.outcome).toBe('failed');
    expect((smsRow?.payload.error as string).startsWith(DELIVERY_TIMEOUT_ERROR_PREFIX)).toBe(true);
    expect(smsRow?.payload.error as string).toContain('socket hang up');
  });

  // Same NON-timeout/NON-HTTP-status ambiguity, on the GHL STAGE-move path
  // (stageErrorMessage, which shares timeoutHedgedErrorMessage with
  // deliveryErrorMessage — see FIX 7's comment on that helper) — proves the
  // widening applies to BOTH callers, not just the delivery path.
  it('a NON-timeout, NON-HTTP-status GHL stage-move failure hedges ghl_sync_error the same way', async () => {
    hl.updateOpportunity.mockRejectedValueOnce(new Error('fetch failed: ECONNRESET'));
    const { client, updatePayloads } = makeSb({ ...FRESH_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);

    const errWrite = updatePayloads.find((p) => 'ghl_sync_error' in p && !('ghl_stage_synced_at' in p));
    expect(errWrite).toBeTruthy();
    expect((errWrite!.ghl_sync_error as string).startsWith(DELIVERY_TIMEOUT_ERROR_PREFIX)).toBe(true);
    expect(errWrite!.ghl_sync_error as string).toContain('ECONNRESET');
  });

  // Sibling to the stage-move hedge test above: a REAL HTTP-status rejection
  // on the stage-move path (e.g. GHL 500ing the update with a real response)
  // stays unhedged — the discriminator is symmetric across both callers of
  // timeoutHedgedErrorMessage.
  it('a real HTTP-status GHL stage-move rejection does NOT hedge ghl_sync_error', async () => {
    hl.updateOpportunity.mockRejectedValueOnce(new HighLevelError('HighLevel PUT /opportunities/opp_1 → 500: server error', 500));
    const { client, updatePayloads } = makeSb({ ...FRESH_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);

    const errWrite = updatePayloads.find((p) => 'ghl_sync_error' in p && !('ghl_stage_synced_at' in p));
    expect(errWrite).toBeTruthy();
    expect((errWrite!.ghl_sync_error as string).startsWith(DELIVERY_TIMEOUT_ERROR_PREFIX)).toBe(false);
    expect(errWrite!.ghl_sync_error as string).toContain('server error');
  });

  it('writes a "failed" row for BOTH channels when the whole requested delivery fails (502)', async () => {
    hl.sendSms.mockRejectedValueOnce(new Error('SMS down'));
    hl.sendEmail.mockRejectedValueOnce(new Error('Email down'));
    const { client, insertPayloads } = makeSb({ ...FRESH_QUOTE });
    sbRef.current = client;

    const res = await POST(makeReqWithBody({ channel: 'both' }), { params });
    expect(res.status).toBe(502);

    const deliveryRows = insertPayloads.filter((p) => p.table === 'quote_deliveries');
    expect(deliveryRows).toHaveLength(2);
    expect(deliveryRows.every((p) => p.payload.outcome === 'failed')).toBe(true);
  });

  it('a quote_deliveries insert failure does NOT fail the send (best-effort logging)', async () => {
    hl.sendSms.mockResolvedValueOnce({ messageId: 'sms_msg_1' });
    hl.sendEmail.mockResolvedValueOnce({ messageId: 'email_msg_1' });
    const { client } = makeSb({ ...FRESH_QUOTE }, { insertError: 'relation "quote_deliveries" does not exist' });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.smsSent).toBe(true);
    expect(json.emailSent).toBe(true);
  });

  it('logs delivery rows on a ?retryDelivery=1 re-delivery, the same as a fresh send', async () => {
    hl.sendSms.mockResolvedValueOnce({ messageId: 'retry_msg_1' });
    const { client, insertPayloads } = makeSb({
      ...FRESH_QUOTE,
      quote_sent_at: '2026-07-18T12:00:00.000Z',
      ghl_stage_synced_at: '2026-07-18T12:00:01.000Z',
      status: 'sent',
    });
    sbRef.current = client;

    const res = await POST(makeReqWithBody({ channel: 'sms' }, true), { params });
    expect(res.status).toBe(200);

    const deliveryRows = insertPayloads.filter((p) => p.table === 'quote_deliveries');
    expect(deliveryRows).toHaveLength(1);
    expect(deliveryRows[0].payload).toMatchObject({
      quote_id: ID,
      channel: 'sms',
      outcome: 'sent',
      provider_message_id: 'retry_msg_1',
    });
  });

  it('does NOT log a delivery row for a TEST quote (never really sent)', async () => {
    const { client, insertPayloads } = makeSb({ ...FRESH_QUOTE, is_test: true });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(insertPayloads.filter((p) => p.table === 'quote_deliveries')).toHaveLength(0);
  });

  it('does NOT log a delivery row on a ?retryGhl reconcile (no customer message sent)', async () => {
    const { client, insertPayloads } = makeSb({
      ...FRESH_QUOTE,
      quote_sent_at: '2026-06-26T00:00:00Z',
      ghl_stage_synced_at: null,
    });
    sbRef.current = client;

    const res = await POST(makeReq(true), { params });
    expect(res.status).toBe(200);
    expect(insertPayloads.filter((p) => p.table === 'quote_deliveries')).toHaveLength(0);
  });
});

// Row 269: the alreadySent short-circuit now reads quote_deliveries so the
// caller can scope its redeliver offer to only the channel(s) that didn't
// confirm-deliver on the original send, instead of a blind 'both'.
describe('POST /api/quotes/[id]/send — row 269 channelOutcomes on alreadySent', () => {
  // The base makeSb fake above has no .order() (it never needed one — every
  // OTHER query in this route is .eq().single() or a plain .update()/.insert()
  // awaited directly), so a query built with fetchLatestDeliveryOutcomes'
  // .select().eq().order().abortSignal() shape would throw synchronously on
  // that fake — which fetchLatestDeliveryOutcomes catches and turns into
  // channelOutcomes being omitted (proven by the "omits" test below, using the
  // base fake unmodified). This helper adds a SEPARATE branch for the
  // 'quote_deliveries' table only, so a test can assert what happens when
  // that read actually succeeds — the 'quotes' table keeps using the exact
  // same base builder everything else in this file already relies on.
  function makeSbWithDeliveries(quote: Quote, deliveryRows: Array<Record<string, unknown>>) {
    const base = makeSb(quote);
    const client = {
      ...base.client,
      from: (table: string) => {
        if (table === 'quote_deliveries') {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  abortSignal: async () => ({ data: deliveryRows, error: null }),
                }),
              }),
            }),
          };
        }
        return (base.client as { from: (t: string) => unknown }).from(table);
      },
    };
    return { client, updatePayloads: base.updatePayloads };
  }

  it('includes channelOutcomes (latest attempt per channel) when the read succeeds', async () => {
    const alreadySent = { ...FRESH_QUOTE, quote_sent_at: '2026-08-14T12:00:00Z' };
    const { client } = makeSbWithDeliveries(alreadySent, [
      // Newest-first, as the real quote_id/created_at index returns them.
      { channel: 'sms', outcome: 'sent', error: null, created_at: '2026-08-14T12:00:01Z' },
      { channel: 'email', outcome: 'failed', error: 'timeout — delivery outcome unknown (GHL may have still delivered it): socket hang up', created_at: '2026-08-14T12:00:02Z' },
      // An older sms row — must be ignored in favor of the newer one above.
      { channel: 'sms', outcome: 'failed', error: 'rate limited', created_at: '2026-08-13T00:00:00Z' },
    ]);
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(json.alreadySent).toBe(true);
    expect(json.channelOutcomes).toEqual({
      sms: { outcome: 'sent', error: null, at: '2026-08-14T12:00:01Z' },
      email: {
        outcome: 'failed',
        error: 'timeout — delivery outcome unknown (GHL may have still delivered it): socket hang up',
        at: '2026-08-14T12:00:02Z',
      },
    });
  });

  it('omits channelOutcomes entirely when the read fails (falls back to today\'s behavior)', async () => {
    const alreadySent = { ...FRESH_QUOTE, quote_sent_at: '2026-08-14T12:00:00Z' };
    // The base fake (no .order()) — fetchLatestDeliveryOutcomes' query throws
    // synchronously against it, caught internally, resolves null.
    const { client } = makeSb(alreadySent);
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(json.alreadySent).toBe(true);
    expect(json.channelOutcomes).toBeUndefined();
  });

  it('both channels null when no delivery was ever logged for this quote (legacy pre-#250 row)', async () => {
    const alreadySent = { ...FRESH_QUOTE, quote_sent_at: '2026-08-14T12:00:00Z' };
    const { client } = makeSbWithDeliveries(alreadySent, []);
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(json.alreadySent).toBe(true);
    expect(json.channelOutcomes).toEqual({ sms: null, email: null });
  });

  it('the RETRY-path alreadySent short-circuit (quote moved past sent/viewed) also carries channelOutcomes — same return site', async () => {
    // Mirrors the existing "retryDelivery against a since-BOOKED quote"
    // fixture elsewhere in this file (deposit_paid_at set makes isDeliveryRetry
    // false, falling through to the plain alreadySent short-circuit).
    const booked = {
      ...FRESH_QUOTE,
      quote_sent_at: '2026-08-01T00:00:00.000Z',
      customer_approved_at: '2026-08-02T00:00:00.000Z',
      deposit_paid_at: '2026-08-05T00:00:00.000Z', // deriveStatus → 'booked'
      ghl_stage_synced_at: '2026-08-01T00:00:01.000Z',
      status: 'booked',
    };
    const { client } = makeSbWithDeliveries(booked, [
      { channel: 'sms', outcome: 'sent', error: null, created_at: '2026-08-01T00:00:01Z' },
      { channel: 'email', outcome: 'sent', error: null, created_at: '2026-08-01T00:00:02Z' },
    ]);
    sbRef.current = client;

    const res = await POST(makeReqWithBody({ channel: 'both' }, true), { params });
    const json = await res.json();

    expect(json.alreadySent).toBe(true);
    expect(json.channelOutcomes).toEqual({
      sms: { outcome: 'sent', error: null, at: '2026-08-01T00:00:01Z' },
      email: { outcome: 'sent', error: null, at: '2026-08-01T00:00:02Z' },
    });
  });
});

// #264 round 2, FIX 1 (HIGH): tagPropagation is NOT a rare path — prod:
// 149/182 sent quotes (82%) carry legacy_rebook=true. Its own DB calls
// (attachQuoteToCustomer et al, in src/lib/customers.ts) are mocked here via
// attachQuoteToCustomerMock, so a hang there is simulated directly rather
// than through a real Supabase client.
describe('POST /api/quotes/[id]/send — tagPropagation deadline (#264 round 2, FIX 1)', () => {
  it('a HUNG attachQuoteToCustomer does not stall the response past the 15s deadline', async () => {
    vi.useFakeTimers();
    try {
      // Never resolves — simulates a hung DB call inside the shared
      // customers.ts find-or-create chain tagPropagation calls into.
      attachQuoteToCustomerMock.mockImplementationOnce(() => new Promise(() => {}));
      hl.sendSms.mockResolvedValueOnce({ messageId: 'sms_msg_1' });
      hl.sendEmail.mockResolvedValueOnce({ messageId: 'email_msg_1' });
      const { client } = makeSb({ ...FRESH_QUOTE, legacy_rebook: true });
      sbRef.current = client;

      const resPromise = POST(makeReq(), { params });
      await vi.advanceTimersByTimeAsync(15_000);
      const res = await resPromise;

      // The route responded WITHOUT waiting for the still-hung
      // attachQuoteToCustomer call (it's now an orphaned, never-settling
      // promise in the background — exactly the documented, verified-safe
      // tradeoff; see the comment above TAG_PROPAGATION_DEADLINE_MS).
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      // The customer's own delivery is unaffected by tagPropagation hanging —
      // proves the four allSettled tasks are genuinely independent.
      expect(json.smsSent).toBe(true);
      expect(json.emailSent).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Ledger #237: push an EVENT quote's staff-entered event date to its linked
// GHL contact's "Event Date" custom field on send. The real ghlEventDate.ts
// module runs in these tests (not mocked) against the same mocked
// @/lib/integrations/highlevel client every other test in this file uses —
// listLocationCustomFields/createLocationCustomField default to an
// already-existing "Event Date" field (id 'ed_field_1'; see the hl mock
// above), so these tests exercise the real find/format/push logic end to
// end through the route, not just "was a spy called."
describe('POST /api/quotes/[id]/send — event-date GHL push (#237)', () => {
  it('fires for an event quote: pushes MM/DD/YYYY (not the raw ISO input) to the resolved field', async () => {
    const { client } = makeSb({
      ...FRESH_QUOTE,
      service_type: 'event',
      inputs: { event: { eventDate: '2026-12-25' } },
    });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(hl.listLocationCustomFields).toHaveBeenCalledTimes(1);
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('contact_1', 'ed_field_1', '12/25/2026');
  });

  // Positive gate (`=== 'event'`, never `!== 'event'`): the other three
  // service types must never even attempt field resolution, let alone a
  // write — asserted via listLocationCustomFields, which nothing else in
  // this route calls (the quote-link stamp resolves its field id from an env
  // var, not a GHL list call).
  it.each(['holiday', 'permanent', 'permanent_bistro'])(
    'does NOT fire for a %s quote, even with a well-formed event date on the row',
    async (serviceType) => {
      const { client } = makeSb({
        ...FRESH_QUOTE,
        service_type: serviceType,
        inputs: { event: { eventDate: '2026-12-25' } },
      });
      sbRef.current = client;

      const res = await POST(makeReq(), { params });
      expect(res.status).toBe(200);
      expect(hl.listLocationCustomFields).not.toHaveBeenCalled();
      // No custom-field write ever carries a pushed-date-shaped value.
      expect(hl.upsertContactCustomField).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        '12/25/2026',
      );
    },
  );

  it('a missing event date does nothing, quietly: no field lookup, no write, send still succeeds', async () => {
    const { client } = makeSb({
      ...FRESH_QUOTE,
      service_type: 'event',
      inputs: { event: {} }, // eventDate absent — the real-world "staff never filled it in" shape
    });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    // formatEventDateForGhl short-circuits on the blank value BEFORE any GHL
    // call — this proves the no-op happens at the cheapest possible point,
    // not just that the end result looks fine.
    expect(hl.listLocationCustomFields).not.toHaveBeenCalled();
    expect(hl.upsertContactCustomField).not.toHaveBeenCalledWith(
      'contact_1',
      expect.anything(),
      expect.stringMatching(/\d{2}\/\d{2}\/\d{4}/),
    );
  });

  it('a blank-string event date (the untouched-input shape from quoteForm.ts) is treated the same as missing', async () => {
    const { client } = makeSb({
      ...FRESH_QUOTE,
      service_type: 'event',
      inputs: { event: { eventDate: '' } },
    });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(hl.listLocationCustomFields).not.toHaveBeenCalled();
  });

  it('failure is soft: a GHL error on the custom-field write never fails or delays the send', async () => {
    hl.upsertContactCustomField.mockImplementation(async (_contactId: string, fieldId: string) => {
      if (fieldId === 'ed_field_1') {
        throw new HighLevelError('GHL 500', 500, 'server error');
      }
      // Any other field (e.g. a quote-link stamp, if one fires) succeeds
      // normally — isolates this test to the event-date write specifically.
      return undefined;
    });
    const { client } = makeSb({
      ...FRESH_QUOTE,
      service_type: 'event',
      inputs: { event: { eventDate: '2026-12-25' } },
    });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    // The send itself completed successfully — a GHL hiccup on this
    // best-effort field push must never surface as a failed/delayed send.
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.stageUpdated).toBe(true);
    // The failed write was actually attempted (proves this test exercised
    // the real failure path, not a silently-skipped one).
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('contact_1', 'ed_field_1', '12/25/2026');
    // FIX A (#237 fix round, staff-lens HIGH): "soft" used to mean the
    // outcome was discarded entirely — the operator had no way to learn the
    // date never synced. It must now be a non-empty string the UI can render
    // (see QuoteBuilder.tsx's eventDateSyncWarning banner).
    expect(typeof json.eventDateSyncError).toBe('string');
    expect(json.eventDateSyncError.length).toBeGreaterThan(0);
  });

  it('never touches a real GHL contact for a Test Quote, even for a well-formed event quote', async () => {
    const { client } = makeSb({
      ...FRESH_QUOTE,
      service_type: 'event',
      is_test: true,
      inputs: { event: { eventDate: '2026-12-25' } },
    });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(hl.listLocationCustomFields).not.toHaveBeenCalled();
  });

  // FIX A (#237 fix round, staff-lens HIGH): the happy-path counterpart to
  // the failure-is-soft test above — a successful push must NOT manufacture
  // a warning.
  it('eventDateSyncError is undefined (not present, not empty string) when the push succeeds', async () => {
    // vi.clearAllMocks() (beforeEach) clears call history but NOT a prior
    // test's mockImplementation override — the "failure is soft" test above
    // sets one. Reset explicitly so this test's outcome doesn't depend on
    // file execution order.
    hl.upsertContactCustomField.mockResolvedValue(undefined);
    const { client } = makeSb({
      ...FRESH_QUOTE,
      service_type: 'event',
      inputs: { event: { eventDate: '2026-12-25' } },
    });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.eventDateSyncError).toBeUndefined();
  });

  // FIX A (#237 fix round): a blank date is a deliberate no-op (see the
  // "missing event date does nothing, quietly" test above) — it must not be
  // reported as a sync FAILURE just because pushEventDateToGhl itself
  // returns pushed:false for that case too.
  it('eventDateSyncError stays undefined for a blank event date — nothing was attempted, not a failure', async () => {
    const { client } = makeSb({
      ...FRESH_QUOTE,
      service_type: 'event',
      inputs: { event: {} },
    });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(json.eventDateSyncError).toBeUndefined();
  });

  // FIX E (#237 fix round): regression test for the deliberate "NOT gated on
  // stageUpdated" decision documented in route.ts — a future edit copying
  // the adjacent quote-link stamp's `stageUpdated &&` guard onto this push
  // would silently break event-date sync every time the stage move fails,
  // with every OTHER test in this file still green (they all default to a
  // successful stage move). Forces stageUpdated=false via a genuine stage
  // failure (findOpportunityForContact rejects) while highlevel_contact_id
  // stays linked, and asserts the push still fires.
  it('still pushes the event date when the stage move itself failed (not gated on stageUpdated)', async () => {
    hl.findOpportunityForContact.mockRejectedValueOnce(new HighLevelError('GHL 500', 500));
    const { client } = makeSb({
      ...FRESH_QUOTE,
      highlevel_opportunity_id: null, // forces the find-or-create branch, not the direct-update one
      service_type: 'event',
      inputs: { event: { eventDate: '2026-12-25' } },
    });
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stageUpdated).toBe(false); // the stage move genuinely failed
    expect(json.stageError).toBeTruthy();
    // ...yet the event-date push still fired, independently of that failure.
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('contact_1', 'ed_field_1', '12/25/2026');
  });

  // FIX E (#237 fix round 2, LOW — coverage, not a defect): eventDateSyncError
  // is populated from the SAME variable on both the 200 body (asserted by the
  // "failure is soft" test above) and the 502 delivery-failed body (route.ts
  // ~1053, "same reasoning as the 200 body below") — this is the missing
  // other half. Every requested customer channel fails (mirrors "returns 502
  // when every requested customer channel fails" above) AND the event-date
  // field write fails, so a split failure (message delivery AND the CRM
  // date push both die) doesn't drop this half of the picture from the 502
  // body the way row 271's stageUpdated/stageError gap once did.
  it('eventDateSyncError is present on the 502 delivery-failed body too, not just the 200 body', async () => {
    hl.sendSms.mockRejectedValueOnce(new Error('SMS down'));
    hl.sendEmail.mockRejectedValueOnce(new Error('Email down'));
    hl.upsertContactCustomField.mockImplementation(async (_contactId: string, fieldId: string) => {
      if (fieldId === 'ed_field_1') {
        throw new HighLevelError('GHL 500', 500, 'server error');
      }
      return undefined;
    });
    const { client } = makeSb({
      ...FRESH_QUOTE,
      service_type: 'event',
      inputs: { event: { eventDate: '2026-12-25' } },
    });
    sbRef.current = client;

    const res = await POST(makeReqWithBody({ channel: 'both' }), { params });
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.code).toBe('delivery-failed');
    expect(typeof json.eventDateSyncError).toBe('string');
    expect(json.eventDateSyncError.length).toBeGreaterThan(0);
    // The failed write was actually attempted — proves this exercised the
    // real failure path, not a silently-skipped one.
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('contact_1', 'ed_field_1', '12/25/2026');
  });
});
