// Coverage for GET /api/cron/calls-extract (calls_merge_plan_2026-08.md
// decision 5, slice S6): auth (via the shared cronDenial), the
// CALLS_EXTRACT_ENABLED off-by-default kill switch, the happy path, and
// graceful degradation before the migration is applied or a dependency is
// unconfigured. Same shape as src/app/api/cron/calls-sync/route.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

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

import { GET } from './route';

function makeReq(authorization?: string): NextRequest {
  return {
    headers: { get: (name: string) => (name.toLowerCase() === 'authorization' ? authorization ?? null : null) },
  } as unknown as NextRequest;
}

describe('GET /api/cron/calls-extract', () => {
  const originalCallsExtractEnabled = process.env.CALLS_EXTRACT_ENABLED;
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CALLS_EXTRACT_ENABLED = 'true';
    process.env.CRON_SECRET = 'test-cron-secret-value';
    isSupabaseServiceConfiguredMock.mockReset().mockReturnValue(true);
    isClaudeConfiguredMock.mockReset().mockReturnValue(true);
    getSupabaseServiceClientMock.mockReset().mockReturnValue({});
    backfillCommitmentsMock.mockReset().mockResolvedValue({
      done: 0,
      skipped: 0,
      failed: 0,
      refused: 0,
      quarantined: 0,
      tasksCreated: 0,
    });
  });

  afterEach(() => {
    process.env.CALLS_EXTRACT_ENABLED = originalCallsExtractEnabled;
    process.env.CRON_SECRET = originalCronSecret;
  });

  it('401s a request with a wrong/missing bearer token', async () => {
    const res = await GET(makeReq('Bearer wrong-secret'));
    expect(res.status).toBe(401);
    expect(backfillCommitmentsMock).not.toHaveBeenCalled();
  });

  it('503s naming the missing variable when CRON_SECRET is unconfigured, distinct from a wrong token', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeReq('Bearer anything'));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toMatch(/CRON_SECRET/);
  });

  it('no-ops when CALLS_EXTRACT_ENABLED is not set, even with a valid secret', async () => {
    delete process.env.CALLS_EXTRACT_ENABLED;
    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    const json = await res.json();
    expect(json).toEqual({ ran: false, reason: 'CALLS_EXTRACT_ENABLED is not set.' });
    expect(backfillCommitmentsMock).not.toHaveBeenCalled();
  });

  it('no-ops when Supabase is not configured', async () => {
    isSupabaseServiceConfiguredMock.mockReturnValue(false);
    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    const json = await res.json();
    expect(json).toEqual({ ran: false, reason: 'Supabase not configured.' });
  });

  it('no-ops when Claude is not configured', async () => {
    isClaudeConfiguredMock.mockReturnValue(false);
    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    const json = await res.json();
    expect(json).toEqual({ ran: false, reason: 'Claude not configured.' });
  });

  it('runs a batch and returns the counts when authorized and enabled', async () => {
    backfillCommitmentsMock.mockResolvedValueOnce({ done: 3, skipped: 0, failed: 1, refused: 0, quarantined: 0, tasksCreated: 2 });

    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ran: true, done: 3, skipped: 0, failed: 1, refused: 0, quarantined: 0, tasksCreated: 2 });
    expect(backfillCommitmentsMock).toHaveBeenCalledWith({}, 6);
  });

  it('degrades gracefully with a clear reason before the commitments migration is applied', async () => {
    backfillCommitmentsMock.mockRejectedValueOnce(
      Object.assign(new Error('relation "call_commitments" does not exist'), { code: '42P01' }),
    );

    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    const json = await res.json();

    expect(json).toEqual({
      ran: false,
      migrated: false,
      reason: 'Run migrations/2026-08-29-call-commitments.sql first.',
    });
  });

  it('returns a bare 500 for an unrecognized failure', async () => {
    backfillCommitmentsMock.mockRejectedValueOnce(new Error('boom'));

    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toEqual({ ran: false, error: 'Extraction failed.' });
  });
});
