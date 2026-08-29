// Coverage for POST /api/calls/process (calls_merge_plan_2026-08.md slice
// S2): operator auth, the happy path, idempotent re-run (an empty batch is
// a normal 200, not an error), and graceful degradation before the
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

const processPendingRecordingsMock = vi.fn();
vi.mock('@/lib/calls/pipeline', () => ({
  processPendingRecordings: (...args: unknown[]) => processPendingRecordingsMock(...args),
}));

import { POST } from './route';

describe('POST /api/calls/process', () => {
  beforeEach(() => {
    requireOperatorMock.mockReset().mockResolvedValue(null);
    isSupabaseServiceConfiguredMock.mockReset().mockReturnValue(true);
    getSupabaseServiceClientMock.mockReset().mockReturnValue({});
    processPendingRecordingsMock.mockReset();
  });

  it('returns the denial response unchanged when the caller is not an operator', async () => {
    const denial = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    requireOperatorMock.mockResolvedValueOnce(denial);

    const res = await POST();

    expect(res).toBe(denial);
    expect(processPendingRecordingsMock).not.toHaveBeenCalled();
  });

  it('processes a batch and returns the counts', async () => {
    processPendingRecordingsMock.mockResolvedValueOnce({ done: 2, skipped: 1, failed: 0 });

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ configured: true, migrated: true, done: 2, skipped: 1, failed: 0 });
  });

  it('returns a zero-count batch as a normal result on an idempotent re-run (nothing pending)', async () => {
    processPendingRecordingsMock.mockResolvedValueOnce({ done: 0, skipped: 0, failed: 0 });

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ configured: true, migrated: true, done: 0, skipped: 0, failed: 0 });
  });

  it('reports not configured when Supabase is missing', async () => {
    isSupabaseServiceConfiguredMock.mockReturnValue(false);

    const res = await POST();
    const json = await res.json();

    expect(json).toEqual({ configured: false, reason: 'Supabase not configured.' });
  });

  it('degrades gracefully with a clear reason before the migration is applied', async () => {
    processPendingRecordingsMock.mockRejectedValueOnce(
      Object.assign(new Error('relation "call_recordings" does not exist'), { code: '42P01' }),
    );

    const res = await POST();
    const json = await res.json();

    expect(json).toEqual({ configured: true, migrated: false, reason: 'Run migrations/2026-08-29-call-ingest.sql first.' });
  });
});
