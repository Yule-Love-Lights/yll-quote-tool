// Coverage for GET /api/cron/calls-sync (calls_merge_plan_2026-08.md
// decision 5, slice S2): auth (via the shared cronDenial), the
// CALLS_SYNC_ENABLED off-by-default kill switch, the happy path's writes,
// and graceful degradation before the migration is applied.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const isSupabaseServiceConfiguredMock = vi.fn();
const getSupabaseServiceClientMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: (...args: unknown[]) => isSupabaseServiceConfiguredMock(...args),
  getSupabaseServiceClient: (...args: unknown[]) => getSupabaseServiceClientMock(...args),
}));

const isHighLevelConfiguredMock = vi.fn();
vi.mock('@/lib/integrations/highlevel', () => ({
  isHighLevelConfigured: (...args: unknown[]) => isHighLevelConfiguredMock(...args),
}));

const listRecentCallRecordingsMock = vi.fn();
vi.mock('@/lib/calls/ghlRecordings', () => ({
  listRecentCallRecordings: (...args: unknown[]) => listRecentCallRecordingsMock(...args),
}));

const processPendingRecordingsMock = vi.fn();
vi.mock('@/lib/calls/pipeline', () => ({
  processPendingRecordings: (...args: unknown[]) => processPendingRecordingsMock(...args),
}));

import { GET } from './route';

function makeReq(authorization?: string): NextRequest {
  return {
    headers: { get: (name: string) => (name.toLowerCase() === 'authorization' ? authorization ?? null : null) },
  } as unknown as NextRequest;
}

function fakeSupabase(
  opts: {
    lastSyncedAt?: string | null;
    upsertError?: { message: string } | null;
    // Simulates ignoreDuplicates returning zero rows for an already-seen
    // message (an idempotent re-run), independent of upsertError.
    upsertReturnsEmpty?: boolean;
    storedCursor?: string;
  } = {},
) {
  const rpc = vi.fn((_fn: string, args: Record<string, unknown>) =>
    Promise.resolve({ data: opts.storedCursor ?? args.p_next_cursor, error: null }),
  );
  const from = vi.fn((table: string) => {
    if (table === 'recording_sync_state') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { last_synced_at: opts.lastSyncedAt ?? null }, error: null }),
          }),
        }),
      };
    }
    if (table === 'call_recordings') {
      return {
        upsert: () => ({
          select: async () => {
            if (opts.upsertError) return { data: [], error: opts.upsertError };
            if (opts.upsertReturnsEmpty) return { data: [], error: null };
            return { data: [{ id: 'r1' }], error: null };
          },
        }),
      };
    }
    throw new Error(`Unexpected table in test: ${table}`);
  });
  return { client: { from, rpc } as unknown as import('@supabase/supabase-js').SupabaseClient, rpc };
}

describe('GET /api/cron/calls-sync', () => {
  const originalCallsSyncEnabled = process.env.CALLS_SYNC_ENABLED;
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CALLS_SYNC_ENABLED = 'true';
    process.env.CRON_SECRET = 'test-cron-secret-value';
    isSupabaseServiceConfiguredMock.mockReset().mockReturnValue(true);
    isHighLevelConfiguredMock.mockReset().mockReturnValue(true);
    processPendingRecordingsMock.mockReset().mockResolvedValue({ done: 0, skipped: 0, failed: 0 });
    listRecentCallRecordingsMock.mockReset().mockResolvedValue({
      messages: [],
      truncated: false,
      stopReason: 'window_exhausted',
      nextSince: null,
    });
  });

  afterEach(() => {
    process.env.CALLS_SYNC_ENABLED = originalCallsSyncEnabled;
    process.env.CRON_SECRET = originalCronSecret;
  });

  it('401s a request with the wrong bearer token', async () => {
    const res = await GET(makeReq('Bearer wrong'));
    expect(res.status).toBe(401);
  });

  it('503s naming the missing variable when CRON_SECRET is unconfigured', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeReq('Bearer anything'));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toMatch(/CRON_SECRET/);
  });

  it('no-ops when CALLS_SYNC_ENABLED is not set, even with a valid secret', async () => {
    delete process.env.CALLS_SYNC_ENABLED;
    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    const json = await res.json();
    expect(json).toEqual({ ran: false, reason: 'CALLS_SYNC_ENABLED is not set.' });
    expect(listRecentCallRecordingsMock).not.toHaveBeenCalled();
  });

  it('no-ops when Supabase is not configured', async () => {
    isSupabaseServiceConfiguredMock.mockReturnValue(false);
    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    const json = await res.json();
    expect(json.ran).toBe(false);
  });

  it('no-ops when HighLevel is not configured', async () => {
    isHighLevelConfiguredMock.mockReturnValue(false);
    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    const json = await res.json();
    expect(json.ran).toBe(false);
  });

  it('runs the sync + process batch end to end on a valid authorized request', async () => {
    const { client } = fakeSupabase({ lastSyncedAt: '2026-08-14T00:00:00.000Z' });
    getSupabaseServiceClientMock.mockReturnValue(client);
    listRecentCallRecordingsMock.mockResolvedValueOnce({
      messages: [
        {
          messageId: 'm1',
          conversationId: 'conv1',
          contactId: 'c1',
          userId: 'u1',
          direction: 'inbound',
          dateAdded: '2026-08-14T01:00:00.000Z',
          durationSeconds: 60,
        },
      ],
      truncated: false,
      stopReason: 'window_exhausted',
      nextSince: null,
    });
    processPendingRecordingsMock.mockResolvedValueOnce({ done: 1, skipped: 0, failed: 0 });

    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ran).toBe(true);
    expect(json.inserted).toBe(1);
    expect(json.done).toBe(1);
    expect(processPendingRecordingsMock).toHaveBeenCalledTimes(1);
  });

  it('reports an idempotent re-run (an already-seen message, zero new inserts) as a normal, non-error result', async () => {
    const { client } = fakeSupabase({ lastSyncedAt: '2026-08-14T00:00:00.000Z', upsertReturnsEmpty: true });
    getSupabaseServiceClientMock.mockReturnValue(client);
    // The message was already synced on a prior run; ignoreDuplicates means
    // the upsert succeeds but returns zero rows for it.
    listRecentCallRecordingsMock.mockResolvedValueOnce({
      messages: [
        {
          messageId: 'm1',
          conversationId: 'conv1',
          contactId: 'c1',
          userId: 'u1',
          direction: 'inbound',
          dateAdded: '2026-08-14T01:00:00.000Z',
          durationSeconds: 60,
        },
      ],
      truncated: false,
      stopReason: 'window_exhausted',
      nextSince: null,
    });

    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ran).toBe(true);
    expect(json.inserted).toBe(0);
    expect(json.upsertFailed).toBe(0);
  });

  it('degrades gracefully with a clear reason before the migration is applied', async () => {
    const client = {
      from: () => {
        throw Object.assign(new Error('relation "recording_sync_state" does not exist'), { code: '42P01' });
      },
      rpc: vi.fn(),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;
    getSupabaseServiceClientMock.mockReturnValue(client);

    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    const json = await res.json();

    expect(json).toEqual({ ran: false, migrated: false, reason: 'Run migrations/2026-08-29-call-ingest.sql first.' });
  });
});
