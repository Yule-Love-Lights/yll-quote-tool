// Tests for POST /api/quotes/[id]/send — focused on the audit fix
// (send-route-ghl-sync-state, finding #32): the GHL pipeline stage-sync
// outcome must be persisted durably (ghl_stage_synced_at / ghl_sync_error),
// and a ?retryGhl reconcile must re-run ONLY the GHL block (no re-stamp, no
// re-message) for an already-sent quote whose card never advanced.
//
// Supabase + the HighLevel client are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { sbRef, hl } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  hl: {
    updateOpportunity: vi.fn(async () => ({ id: 'opp_1' })),
    createOpportunity: vi.fn(async () => ({ id: 'opp_new' })),
    findOpportunityForContact: vi.fn(async () => null as { id: string } | null),
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

vi.mock('@/lib/integrations/highlevel', () => ({
  updateOpportunity: hl.updateOpportunity,
  createOpportunity: hl.createOpportunity,
  findOpportunityForContact: hl.findOpportunityForContact,
  sendSms: hl.sendSms,
  sendEmail: hl.sendEmail,
  isHighLevelConfigured: () => hl.configured.value,
  HighLevelError: class HighLevelError extends Error {
    status?: number;
    body?: string;
  },
}));

vi.mock('@/lib/integrations/quoteMessages', () => ({
  QUOTE_EMAIL_SUBJECT: 'subj',
  quoteSmsBody: () => 'sms',
  quoteEmailHtml: () => '<p>email</p>',
}));

import { POST } from './route';

// Fake Supabase: read = from().select().eq().single(); each write =
// from().update(payload).eq() (awaited). Records every update payload so we
// can assert what was persisted.
type Quote = Record<string, unknown> | null;
function makeSb(quote: Quote) {
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
      const res = isUpdate ? { error: null } : { data: quote, error: null };
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
  } as unknown as NextRequest;
}
const params = Promise.resolve({ id: ID });

const FRESH_QUOTE = {
  id: ID,
  highlevel_opportunity_id: 'opp_1',
  highlevel_contact_id: 'contact_1',
  customer_name: 'Jordan Smith',
  total: 4200,
  quote_sent_at: null,
  customer_approved_at: null,
  ghl_stage_synced_at: null,
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

  it('an already-sent quote WITHOUT ?retryGhl still short-circuits (alreadySent)', async () => {
    const alreadySent = {
      ...FRESH_QUOTE,
      quote_sent_at: '2026-06-26T00:00:00Z',
      ghl_stage_synced_at: null,
    };
    const { client } = makeSb(alreadySent);
    sbRef.current = client;

    const res = await POST(makeReq(false), { params });
    const json = await res.json();

    expect(json.alreadySent).toBe(true);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
    expect(hl.sendSms).not.toHaveBeenCalled();
  });
});
