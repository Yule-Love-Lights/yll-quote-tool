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
  commitmentStatusRows?: { status: string }[] | { code: string };
  transcriptExtractionRows?:
    | { commitments_extracted_at: string | null; commitment_extraction_quarantined_at: string | null }[]
    | { code: string };
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
        select: (cols: string) => {
          if (cols === 'id, outcome') {
            return { in: async () => ({ data: opts.transcriptRows ?? [], error: null }) };
          }
          // The commitment-extraction progress select (S6) -- no .in(), just
          // awaited directly.
          const rows = opts.transcriptExtractionRows;
          if (rows && 'code' in rows) return Promise.resolve({ data: null, error: rows });
          return Promise.resolve({ data: rows ?? [], error: null });
        },
      };
    }
    if (table === 'call_commitments') {
      return {
        select: () => {
          const rows = opts.commitmentStatusRows;
          if (rows && !Array.isArray(rows)) return Promise.resolve({ data: null, error: rows });
          return Promise.resolve({ data: rows ?? [], error: null });
        },
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

  it('includes commitment status counts + extraction progress (S6)', async () => {
    getSupabaseServiceClientMock.mockReturnValue(
      fakeSupabase({
        commitmentStatusRows: [
          { status: 'open' },
          { status: 'open' },
          { status: 'cleared' },
          { status: 'done' },
          { status: 'dismissed' },
          { status: 'expired' },
        ],
        transcriptExtractionRows: [
          { commitments_extracted_at: '2026-08-20T00:00:00.000Z', commitment_extraction_quarantined_at: null },
          { commitments_extracted_at: null, commitment_extraction_quarantined_at: '2026-08-20T00:00:00.000Z' },
          { commitments_extracted_at: null, commitment_extraction_quarantined_at: null },
        ],
      }),
    );

    const res = await GET();
    const json = await res.json();

    expect(json.commitments).toEqual({
      counts: { open: 2, cleared: 1, done: 1, dismissed: 1, expired: 1 },
      extraction: { pending: 1, extracted: 1, quarantined: 1 },
    });
  });

  it('degrades the commitments section to null (not an error) when call_commitments is not migrated yet -- the recordings section above still works', async () => {
    getSupabaseServiceClientMock.mockReturnValue(
      fakeSupabase({
        statusRows: [{ status: 'transcribed' }],
        commitmentStatusRows: { code: '42P01' },
      }),
    );

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.migrated).toBe(true);
    expect(json.counts).toEqual({ pending: 0, processing: 0, transcribed: 1, skipped: 0, failed: 0 });
    expect(json.commitments).toBeNull();
  });

  it('degrades the commitments section to null when the extraction-tracking columns are not migrated yet', async () => {
    getSupabaseServiceClientMock.mockReturnValue(
      fakeSupabase({
        transcriptExtractionRows: { code: '42703' } as unknown as { code: string },
      }),
    );

    const res = await GET();
    const json = await res.json();

    // 42703 (undefined column) is NOT in isCommitmentsSchemaUnavailable's set
    // -- only 42P01/PGRST205/42883/PGRST202 are. This documents that a
    // genuinely different Postgres error still throws (500), rather than
    // silently degrading to null and hiding a real problem.
    expect(res.status).toBe(500);
    expect(json.error).toBe('Could not load calls.');
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
