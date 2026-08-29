// Coverage for GET /api/cron/calls-note: auth (via the shared cronDenial),
// the kill switch, the dependency guards, and the happy path. Same shape as
// src/app/api/cron/calls-extract/route.test.ts.
//
// ONE DELIBERATE DIFFERENCE from its sibling crons, and it is asserted
// below rather than left implicit: CALLS_NOTES_ENABLED defaults ON. Naldo
// asked for this to run automatically the moment it merges, so the flag is
// an off switch he can flip, not an on switch he has to remember.

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

const isHighLevelConfiguredMock = vi.fn();
vi.mock('@/lib/integrations/highlevel', () => ({
  isHighLevelConfigured: (...args: unknown[]) => isHighLevelConfiguredMock(...args),
}));

const postPendingCallNotesMock = vi.fn();
vi.mock('@/lib/calls/postNotes', () => ({
  postPendingCallNotes: (...args: unknown[]) => postPendingCallNotesMock(...args),
  CALL_NOTE_BATCH_SIZE: 6,
}));

import { GET } from './route';

const EMPTY = { posted: 0, skipped: 0, failed: 0, quarantined: 0, contended: 0, previewed: 0 };

function makeReq(authorization?: string): NextRequest {
  return {
    headers: { get: (name: string) => (name.toLowerCase() === 'authorization' ? authorization ?? null : null) },
  } as unknown as NextRequest;
}

describe('GET /api/cron/calls-note', () => {
  const originalEnabled = process.env.CALLS_NOTES_ENABLED;
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    delete process.env.CALLS_NOTES_ENABLED;
    process.env.CRON_SECRET = 'test-cron-secret-value';
    isSupabaseServiceConfiguredMock.mockReset().mockReturnValue(true);
    isClaudeConfiguredMock.mockReset().mockReturnValue(true);
    isHighLevelConfiguredMock.mockReset().mockReturnValue(true);
    getSupabaseServiceClientMock.mockReset().mockReturnValue({});
    postPendingCallNotesMock.mockReset().mockResolvedValue(EMPTY);
  });

  afterEach(() => {
    process.env.CALLS_NOTES_ENABLED = originalEnabled;
    process.env.CRON_SECRET = originalCronSecret;
  });

  it('401s a request with a wrong or missing bearer token', async () => {
    const res = await GET(makeReq('Bearer wrong-secret'));
    expect(res.status).toBe(401);
    expect(postPendingCallNotesMock).not.toHaveBeenCalled();
  });

  it('503s naming the missing variable when CRON_SECRET is unconfigured', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeReq('Bearer anything'));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/CRON_SECRET/);
  });

  it('runs with the flag unset, because notes are on by default', async () => {
    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    expect((await res.json()).ran).toBe(true);
    expect(postPendingCallNotesMock).toHaveBeenCalledWith({}, 6);
  });

  it('no-ops when CALLS_NOTES_ENABLED is explicitly set to false', async () => {
    process.env.CALLS_NOTES_ENABLED = 'false';
    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    expect(await res.json()).toEqual({ ran: false, reason: 'CALLS_NOTES_ENABLED is set to false.' });
    expect(postPendingCallNotesMock).not.toHaveBeenCalled();
  });

  it('no-ops when Supabase is not configured', async () => {
    isSupabaseServiceConfiguredMock.mockReturnValue(false);
    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    expect(await res.json()).toEqual({ ran: false, reason: 'Supabase not configured.' });
  });

  it('no-ops when Claude is not configured', async () => {
    isClaudeConfiguredMock.mockReturnValue(false);
    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    expect(await res.json()).toEqual({ ran: false, reason: 'Claude not configured.' });
  });

  it('no-ops when HighLevel is not configured, rather than failing every call', async () => {
    isHighLevelConfiguredMock.mockReturnValue(false);
    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    expect(await res.json()).toEqual({ ran: false, reason: 'HighLevel not configured.' });
    expect(postPendingCallNotesMock).not.toHaveBeenCalled();
  });

  it('returns the batch counts on the happy path', async () => {
    postPendingCallNotesMock.mockResolvedValueOnce({ ...EMPTY, posted: 4, skipped: 1 });
    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ran: true, ...EMPTY, posted: 4, skipped: 1 });
  });

  it('says which migration to run when the note columns are missing', async () => {
    postPendingCallNotesMock.mockRejectedValueOnce(
      Object.assign(new Error('column call_transcripts.ghl_note_posted_at does not exist'), { code: '42703' }),
    );
    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    expect(await res.json()).toEqual({
      ran: false,
      migrated: false,
      reason: 'Run migrations/2026-08-29-call-notes.sql first.',
    });
  });

  it('returns a bare 500 for an unrecognized failure', async () => {
    postPendingCallNotesMock.mockRejectedValueOnce(new Error('boom'));
    const res = await GET(makeReq('Bearer test-cron-secret-value'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ran: false, error: 'Posting call notes failed.' });
  });
});
