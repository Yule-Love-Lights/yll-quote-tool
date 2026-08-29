// Coverage for POST /api/calls/extract (calls_merge_plan_2026-08.md slice
// S6): operator auth, the happy path, and graceful degradation before the
// migration is applied or a dependency is unconfigured. Same shape as
// src/app/api/calls/process/route.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireOperatorMock = vi.fn();
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: (...args: unknown[]) => requireOperatorMock(...args) }));

const isSupabaseServiceConfiguredMock = vi.fn();
const getSupabaseServiceClientMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: (...args: unknown[]) => isSupabaseServiceConfiguredMock(...args),
  getSupabaseServiceClient: (...args: unknown[]) => getSupabaseServiceClientMock(...args),
}));

const isClaudeConfiguredMock = vi.fn();
vi.mock('@/lib/claude', () => ({
  isClaudeConfigured: (...args: unknown[]) => isClaudeConfiguredMock(...args),
}));

const backfillCommitmentsMock = vi.fn();
vi.mock('@/lib/commitments/backfill', () => ({
  backfillCommitments: (...args: unknown[]) => backfillCommitmentsMock(...args),
  COMMITMENT_EXTRACTION_BATCH_SIZE: 6,
}));

import { POST } from './route';

describe('POST /api/calls/extract', () => {
  beforeEach(() => {
    requireOperatorMock.mockReset().mockResolvedValue(null);
    isSupabaseServiceConfiguredMock.mockReset().mockReturnValue(true);
    isClaudeConfiguredMock.mockReset().mockReturnValue(true);
    getSupabaseServiceClientMock.mockReset().mockReturnValue({});
    backfillCommitmentsMock.mockReset();
  });

  it('returns the denial response unchanged when the caller is not an operator', async () => {
    const denial = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    requireOperatorMock.mockResolvedValueOnce(denial);

    const res = await POST();

    expect(res).toBe(denial);
    expect(backfillCommitmentsMock).not.toHaveBeenCalled();
  });

  it('extracts a batch and returns the counts, including tasksCreated', async () => {
    backfillCommitmentsMock.mockResolvedValueOnce({ done: 2, skipped: 1, failed: 0, refused: 0, quarantined: 0, tasksCreated: 3 });

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      configured: true,
      migrated: true,
      done: 2,
      skipped: 1,
      failed: 0,
      refused: 0,
      quarantined: 0,
      tasksCreated: 3,
    });
    expect(backfillCommitmentsMock).toHaveBeenCalledWith({}, 6);
  });

  it('reports not configured when Supabase is missing', async () => {
    isSupabaseServiceConfiguredMock.mockReturnValue(false);

    const res = await POST();
    const json = await res.json();

    expect(json).toEqual({ configured: false, reason: 'Supabase not configured.' });
    expect(backfillCommitmentsMock).not.toHaveBeenCalled();
  });

  it('reports not configured when Claude is missing', async () => {
    isClaudeConfiguredMock.mockReturnValue(false);

    const res = await POST();
    const json = await res.json();

    expect(json).toEqual({ configured: false, reason: 'Claude not configured.' });
    expect(backfillCommitmentsMock).not.toHaveBeenCalled();
  });

  it('degrades gracefully with a clear reason before the commitments migration is applied', async () => {
    backfillCommitmentsMock.mockRejectedValueOnce(
      Object.assign(new Error('relation "call_commitments" does not exist'), { code: '42P01' }),
    );

    const res = await POST();
    const json = await res.json();

    expect(json).toEqual({
      configured: true,
      migrated: false,
      reason: 'Run migrations/2026-08-29-call-commitments.sql first.',
    });
  });

  it('degrades gracefully when the finalize/failure RPC functions are missing (function-not-found codes)', async () => {
    backfillCommitmentsMock.mockRejectedValueOnce(
      Object.assign(new Error('function call_commitments_finalize_extraction does not exist'), { code: 'PGRST202' }),
    );

    const res = await POST();
    const json = await res.json();

    expect(json.migrated).toBe(false);
  });

  it('returns a bare 500 for an unrecognized failure', async () => {
    backfillCommitmentsMock.mockRejectedValueOnce(new Error('boom'));

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toEqual({ configured: true, error: 'Could not extract commitments.' });
  });
});
