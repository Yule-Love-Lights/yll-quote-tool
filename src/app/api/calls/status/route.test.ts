// Coverage for GET /api/calls/status (calls_merge_plan_2026-08.md slice S2):
// operator auth, status counts, recent-recordings shape (including a
// surfaced lastError for failed rows), and graceful degradation before the
// migration is applied.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireOperatorMock = vi.fn();
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: (...args: unknown[]) => requireOperatorMock(...args) }));

const isSupabaseServiceConfiguredMock = vi.fn();
const getSupabaseServiceClientMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: (...args: unknown[]) => isSupabaseServiceConfiguredMock(...args),
  getSupabaseServiceClient: (...args: unknown[]) => getSupabaseServiceClientMock(...args),
}));

import { GET } from './route';

function fakeSupabase(opts: {
  lastSyncedAt?: string | null;
  statusRows?: { status: string }[];
  recentRows?: Record<string, unknown>[];
  transcriptRows?: { id: string; outcome: string }[];
} = {}) {
  const from = vi.fn((table: string) => {
    if (table === 'recording_sync_state') {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { last_synced_at: opts.lastSyncedAt ?? null }, error: null }) }),
        }),
      };
    }
    if (table === 'call_recordings') {
      return {
        select: (cols: string) => {
          if (cols === 'status') {
            return Promise.resolve({ data: opts.statusRows ?? [], error: null });
          }
          return {
            order: () => ({
              limit: async () => ({ data: opts.recentRows ?? [], error: null }),
            }),
          };
        },
      };
    }
    if (table === 'call_transcripts') {
      return {
        select: () => ({
          in: async () => ({ data: opts.transcriptRows ?? [], error: null }),
        }),
      };
    }
    throw new Error(`Unexpected table in test: ${table}`);
  });
  return { from } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

describe('GET /api/calls/status', () => {
  beforeEach(() => {
    requireOperatorMock.mockReset().mockResolvedValue(null);
    isSupabaseServiceConfiguredMock.mockReset().mockReturnValue(true);
    getSupabaseServiceClientMock.mockReset();
  });

  it('returns the denial response unchanged when the caller is not an operator', async () => {
    const denial = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    requireOperatorMock.mockResolvedValueOnce(denial);

    const res = await GET();

    expect(res).toBe(denial);
  });

  it('tallies counts by status and surfaces the last error on a failed row', async () => {
    getSupabaseServiceClientMock.mockReturnValue(
      fakeSupabase({
        lastSyncedAt: '2026-08-14T00:00:00.000Z',
        statusRows: [{ status: 'transcribed' }, { status: 'transcribed' }, { status: 'failed' }, { status: 'pending' }],
        recentRows: [
          {
            id: 'r1',
            ghl_contact_id: 'c1',
            direction: 'inbound',
            called_at: '2026-08-14T01:00:00.000Z',
            duration_seconds: 90,
            status: 'failed',
            skip_reason: null,
            transcript_id: null,
            detail: { error: 'HighLevel has no transcript for message m1 (status 400).' },
            created_at: '2026-08-14T01:00:05.000Z',
          },
          {
            id: 'r2',
            ghl_contact_id: 'c2',
            direction: 'outbound',
            called_at: '2026-08-14T02:00:00.000Z',
            duration_seconds: 200,
            status: 'transcribed',
            skip_reason: null,
            transcript_id: 't1',
            detail: null,
            created_at: '2026-08-14T02:00:05.000Z',
          },
        ],
        transcriptRows: [{ id: 't1', outcome: 'unknown' }],
      }),
    );

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.counts).toEqual({ pending: 1, processing: 0, transcribed: 2, skipped: 0, failed: 1 });
    expect(json.recordings[0]).toMatchObject({
      id: 'r1',
      status: 'failed',
      lastError: 'HighLevel has no transcript for message m1 (status 400).',
    });
    expect(json.recordings[1]).toMatchObject({ id: 'r2', status: 'transcribed', outcome: 'unknown', lastError: null });
  });

  it('never surfaces a detail.error for a non-failed row', async () => {
    getSupabaseServiceClientMock.mockReturnValue(
      fakeSupabase({
        recentRows: [
          {
            id: 'r1',
            ghl_contact_id: null,
            direction: null,
            called_at: null,
            duration_seconds: null,
            status: 'skipped',
            skip_reason: 'duration_under_20s',
            transcript_id: null,
            // A row can carry a stale `detail` from an earlier failed attempt
            // that later succeeded as a skip -- lastError must not leak it.
            detail: { error: 'stale error from a prior attempt' },
            created_at: '2026-08-14T01:00:05.000Z',
          },
        ],
      }),
    );

    const res = await GET();
    const json = await res.json();

    expect(json.recordings[0].lastError).toBeNull();
  });

  it('reports not configured when Supabase is missing', async () => {
    isSupabaseServiceConfiguredMock.mockReturnValue(false);

    const res = await GET();
    const json = await res.json();

    expect(json).toEqual({ configured: false });
  });

  it('degrades gracefully with a clear reason before the migration is applied', async () => {
    getSupabaseServiceClientMock.mockReturnValue({
      from: () => {
        throw Object.assign(new Error('relation "recording_sync_state" does not exist'), { code: '42P01' });
      },
    } as unknown as import('@supabase/supabase-js').SupabaseClient);

    const res = await GET();
    const json = await res.json();

    expect(json).toEqual({ configured: true, migrated: false, reason: 'Run migrations/2026-08-29-call-ingest.sql first.' });
  });
});
