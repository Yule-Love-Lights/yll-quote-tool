// Tests for the website-lead RETRY worker (#leads GHL-outage recovery). A lead
// row is written to Supabase FIRST on every submission (source of truth); if the
// GHL sync then fails (outage) the row is left 'pending', or 'deferred' when a
// service's pipeline env vars aren't set yet. This worker re-drives those rows
// through syncLeadToGhl until they succeed or exhaust the attempt cap (→ 'failed').
//
// syncLeadToGhl is PARTIALLY mocked (asLeadService and the rest of ./leadService
// stay real) so these tests cover the retry ORCHESTRATION: which rows are picked,
// the skipNotes idempotency decision, retry_count/last_retried_at bookkeeping, the
// terminal 'failed' cap, and the per-result status write-back. Supabase is mocked
// with a hand-rolled fake query builder (same injection style as route.test.ts).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  // Typed loosely (args unknown, return the broad SyncLeadToGhlResult shape) so a
  // test can assert on call args AND override the resolved value with any of the
  // synced/deferred/error result variants.
  syncLeadToGhl: vi.fn(
    async (
      _lead: unknown,
      _opts?: unknown,
    ): Promise<{
      status: string;
      ghlContactId?: string;
      ghlOpportunityId?: string;
      syncError?: string;
    }> => ({ status: 'synced', ghlContactId: 'contact-1', ghlOpportunityId: 'opp-1' }),
  ),
}));

vi.mock('./leadService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./leadService')>();
  return { ...actual, syncLeadToGhl: svc.syncLeadToGhl };
});

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

import {
  retryStuckLeads,
  retryOneLead,
  MAX_RETRY_ATTEMPTS,
  DEFAULT_RETRY_BATCH,
} from './leadRetry';

const NOW = new Date('2026-07-12T15:00:00.000Z');

type LeadRow = Record<string, unknown>;

function row(overrides: LeadRow = {}): LeadRow {
  return {
    id: 'lead-1',
    name: 'Jordan Rivera',
    email: 'jordan@example.com',
    phone: '+16315550100',
    address: '123 Main St',
    service: 'christmas',
    notes: null,
    utm: null,
    landing_url: null,
    form_variant: 'hero',
    ghl_contact_id: null,
    ghl_opportunity_id: null,
    sync_status: 'pending',
    sync_error: 'GHL down',
    retry_count: 0,
    last_retried_at: null,
    is_test: false,
    // Every real pending/deferred/failed row has consent (POST /api/leads
    // refuses to insert a syncable row without consent:true); the retry
    // consent-guard reflects that. Non-consented 'partial' rows are covered by
    // their own test below.
    consent: true,
    ...overrides,
  };
}

// Fake Supabase query builder. Two shapes:
//   select:  .from().select('*').in().lt().order().limit()  → { data: rows, error }
//   update:  .from().update(payload).eq('id', id)           → { error }
function makeSb(
  opts: {
    rows?: LeadRow[];
    selectError?: { message: string } | null;
    updateError?: { message: string } | null;
  } = {},
) {
  const updates: Array<{ payload: Record<string, unknown>; id: unknown }> = [];
  const query: { in?: [string, unknown]; lt?: [string, unknown]; order?: [string, unknown]; limit?: unknown } = {};
  let mode: 'select' | 'update' | null = null;
  let pendingPayload: Record<string, unknown> | null = null;
  let pendingId: unknown = null;

  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: () => {
      mode = 'select';
      return builder;
    },
    in: (col: string, vals: unknown) => {
      query.in = [col, vals];
      return builder;
    },
    lt: (col: string, val: unknown) => {
      query.lt = [col, val];
      return builder;
    },
    order: (col: string, o: unknown) => {
      query.order = [col, o];
      return builder;
    },
    limit: (n: unknown) => {
      query.limit = n;
      return builder;
    },
    update: (payload: Record<string, unknown>) => {
      mode = 'update';
      pendingPayload = payload;
      return builder;
    },
    eq: (_col: string, val: unknown) => {
      if (mode === 'update') pendingId = val;
      return builder;
    },
    then: (resolve: (v: unknown) => void) => {
      if (mode === 'select') {
        resolve({ data: opts.rows ?? [], error: opts.selectError ?? null });
      } else if (mode === 'update') {
        updates.push({ payload: pendingPayload!, id: pendingId });
        resolve({ error: opts.updateError ?? null });
        pendingPayload = null;
        pendingId = null;
      } else {
        resolve({ data: null, error: null });
      }
      mode = null;
    },
  });
  return { client: builder, updates, query };
}

beforeEach(() => {
  vi.clearAllMocks();
  sbRef.current = null;
  svc.syncLeadToGhl.mockResolvedValue({
    status: 'synced',
    ghlContactId: 'contact-1',
    ghlOpportunityId: 'opp-1',
  });
});

describe('retryStuckLeads — row selection', () => {
  it('queries only pending+deferred rows below the attempt cap, oldest attempt first', async () => {
    const sb = makeSb({ rows: [] });
    sbRef.current = sb.client;
    await retryStuckLeads({ now: NOW });

    expect(sb.query.in).toEqual(['sync_status', ['pending', 'deferred']]);
    expect(sb.query.lt).toEqual(['retry_count', MAX_RETRY_ATTEMPTS]);
    expect(sb.query.order?.[0]).toBe('last_retried_at');
    expect(sb.query.order?.[1]).toMatchObject({ ascending: true, nullsFirst: true });
    expect(sb.query.limit).toBe(DEFAULT_RETRY_BATCH);
  });

  it('honors an explicit batch size', async () => {
    const sb = makeSb({ rows: [] });
    sbRef.current = sb.client;
    await retryStuckLeads({ now: NOW, batch: 5 });
    expect(sb.query.limit).toBe(5);
  });
});

describe('applyRetry — consent guard (quote-forms-partial-save)', () => {
  it('NEVER drip-syncs a row without SMS consent (e.g. a partial abandoned-form row)', async () => {
    const sb = makeSb();
    sbRef.current = sb.client;
    const outcome = await retryOneLead(
      row({ id: 'partial-1', sync_status: 'partial', consent: false }),
      { now: NOW },
    );
    // syncLeadToGhl (which adds the drip-enrolling 'new lead' tag) is never called
    expect(svc.syncLeadToGhl).not.toHaveBeenCalled();
    // status left untouched, a forensic sync_error recorded
    expect(outcome).toBe('partial');
    expect(sb.updates).toHaveLength(1);
    expect(sb.updates[0]!.payload.sync_error).toContain('no SMS consent');
    expect(sb.updates[0]!.payload.sync_status).toBeUndefined();
  });
});

describe('retryStuckLeads — idempotency routing (skipNotes)', () => {
  it('passes skipNotes:true for a row that already has a ghl_contact_id, false otherwise', async () => {
    const sb = makeSb({
      rows: [
        row({ id: 'no-contact', ghl_contact_id: null }),
        row({ id: 'has-contact', ghl_contact_id: 'contact-99' }),
      ],
    });
    sbRef.current = sb.client;
    await retryStuckLeads({ now: NOW });

    expect(svc.syncLeadToGhl).toHaveBeenCalledTimes(2);
    expect(svc.syncLeadToGhl.mock.calls[0]![1]).toMatchObject({ skipNotes: false });
    expect(svc.syncLeadToGhl.mock.calls[1]![1]).toMatchObject({ skipNotes: true });
  });
});

describe('retryStuckLeads — bookkeeping + status write-back', () => {
  it('increments retry_count and stamps last_retried_at on every processed row', async () => {
    const sb = makeSb({ rows: [row({ retry_count: 3 })] });
    sbRef.current = sb.client;
    await retryStuckLeads({ now: NOW });

    expect(sb.updates).toHaveLength(1);
    expect(sb.updates[0]!.id).toBe('lead-1');
    expect(sb.updates[0]!.payload.retry_count).toBe(4);
    expect(sb.updates[0]!.payload.last_retried_at).toBe(NOW.toISOString());
  });

  it('a successful sync marks the row synced, clears sync_error, stores the GHL ids', async () => {
    svc.syncLeadToGhl.mockResolvedValue({
      status: 'synced',
      ghlContactId: 'contact-1',
      ghlOpportunityId: 'opp-1',
    });
    const sb = makeSb({ rows: [row()] });
    sbRef.current = sb.client;
    await retryStuckLeads({ now: NOW });

    expect(sb.updates[0]!.payload).toMatchObject({
      sync_status: 'synced',
      sync_error: null,
      ghl_contact_id: 'contact-1',
      ghl_opportunity_id: 'opp-1',
    });
  });

  it('a thrown sync (contact upsert down) keeps the row pending below the cap, records the error', async () => {
    svc.syncLeadToGhl.mockRejectedValue(new Error('HL 502 upstream down'));
    const sb = makeSb({ rows: [row({ retry_count: 0 })] });
    sbRef.current = sb.client;
    await retryStuckLeads({ now: NOW });

    expect(sb.updates[0]!.payload).toMatchObject({
      sync_status: 'pending',
      sync_error: 'HL 502 upstream down',
      retry_count: 1,
    });
  });

  it('a still-deferred result stays deferred (below cap) with its error', async () => {
    svc.syncLeadToGhl.mockResolvedValue({
      status: 'deferred',
      ghlContactId: 'contact-1',
      syncError: 'pipeline env not set',
    });
    const sb = makeSb({ rows: [row({ service: 'landscape', ghl_contact_id: 'contact-1', retry_count: 1 })] });
    sbRef.current = sb.client;
    await retryStuckLeads({ now: NOW });

    expect(sb.updates[0]!.payload).toMatchObject({
      sync_status: 'deferred',
      sync_error: 'pipeline env not set',
    });
  });
});

describe('retryStuckLeads — terminal cap', () => {
  it('flips a still-failing row to "failed" once it reaches the attempt cap', async () => {
    svc.syncLeadToGhl.mockRejectedValue(new Error('still down'));
    const sb = makeSb({ rows: [row({ retry_count: MAX_RETRY_ATTEMPTS - 1 })] });
    sbRef.current = sb.client;
    await retryStuckLeads({ now: NOW });

    expect(sb.updates[0]!.payload.retry_count).toBe(MAX_RETRY_ATTEMPTS);
    expect(sb.updates[0]!.payload.sync_status).toBe('failed');
  });

  it('a row that SUCCEEDS on its final allowed attempt is synced, not failed', async () => {
    svc.syncLeadToGhl.mockResolvedValue({ status: 'synced', ghlContactId: 'c', ghlOpportunityId: 'o' });
    const sb = makeSb({ rows: [row({ retry_count: MAX_RETRY_ATTEMPTS - 1 })] });
    sbRef.current = sb.client;
    await retryStuckLeads({ now: NOW });
    expect(sb.updates[0]!.payload.sync_status).toBe('synced');
  });
});

describe('retryStuckLeads — unretriable rows', () => {
  it('marks a row with an unknown service "failed" without calling GHL', async () => {
    const sb = makeSb({ rows: [row({ service: 'not-a-service' })] });
    sbRef.current = sb.client;
    await retryStuckLeads({ now: NOW });

    expect(svc.syncLeadToGhl).not.toHaveBeenCalled();
    expect(sb.updates[0]!.payload.sync_status).toBe('failed');
  });
});

describe('retryOneLead — manual (admin) path bypasses the query, not the cap semantics', () => {
  it('re-drives an already-failed / capped row and re-fails it when it still errors', async () => {
    svc.syncLeadToGhl.mockRejectedValue(new Error('still down'));
    const sb = makeSb();
    sbRef.current = sb.client;
    await retryOneLead(row({ sync_status: 'failed', retry_count: MAX_RETRY_ATTEMPTS, ghl_contact_id: 'c1' }), {
      now: NOW,
    });

    expect(svc.syncLeadToGhl).toHaveBeenCalledTimes(1);
    expect(svc.syncLeadToGhl.mock.calls[0]![1]).toMatchObject({ skipNotes: true });
    expect(sb.updates[0]!.payload.sync_status).toBe('failed');
    expect(sb.updates[0]!.payload.retry_count).toBe(MAX_RETRY_ATTEMPTS + 1);
  });

  it('recovers an already-failed row when the manual re-drive now succeeds', async () => {
    svc.syncLeadToGhl.mockResolvedValue({ status: 'synced', ghlContactId: 'c1', ghlOpportunityId: 'o1' });
    const sb = makeSb();
    sbRef.current = sb.client;
    await retryOneLead(row({ sync_status: 'failed', retry_count: MAX_RETRY_ATTEMPTS, ghl_contact_id: 'c1' }), {
      now: NOW,
    });
    expect(sb.updates[0]!.payload.sync_status).toBe('synced');
    expect(sb.updates[0]!.payload.sync_error).toBeNull();
  });
});
