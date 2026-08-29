// Coverage for the sync-window math the cron and the admin "process next
// batch" button both rely on (calls_merge_plan_2026-08.md slice S2). Ported
// from the yll-call-copilot repo's src/lib/recordings/sync.test.ts (master
// fb1bf326); resolveOverlapCursor/resolveNextSyncCursor are new pure
// extractions of logic the copilot inlined in its cron route.

import { describe, it, expect } from 'vitest';
import { resolveNextSyncCursor, resolveOverlapCursor, resolveSyncWindowStart } from './sync';

describe('resolveSyncWindowStart', () => {
  it('defaults to 7 days back on the first run (no stored last_synced_at)', () => {
    const now = new Date('2026-07-14T12:00:00.000Z');
    expect(resolveSyncWindowStart(null, now)).toBe('2026-07-07T12:00:00.000Z');
  });

  it('uses the stored last_synced_at on every later run, ignoring `now`', () => {
    const now = new Date('2026-07-14T12:00:00.000Z');
    expect(resolveSyncWindowStart('2026-07-13T03:00:00.000Z', now)).toBe('2026-07-13T03:00:00.000Z');
  });
});

describe('resolveOverlapCursor', () => {
  it('keeps a 24h overlap when the run started less than 24h after `since`', () => {
    // since is only 2h before runStarted -- the overlap window (24h back
    // from runStarted) would be BEFORE since, so since itself wins (no
    // regression past where the window already started).
    expect(resolveOverlapCursor('2026-08-14T10:00:00.000Z', '2026-08-14T12:00:00.000Z')).toBe(
      '2026-08-14T10:00:00.000Z',
    );
  });

  it('pulls the cursor back 24h from runStarted when the window is older than that', () => {
    expect(resolveOverlapCursor('2026-08-01T00:00:00.000Z', '2026-08-14T12:00:00.000Z')).toBe(
      '2026-08-13T12:00:00.000Z',
    );
  });
});

describe('resolveNextSyncCursor', () => {
  it('keeps `since` unchanged when the upsert failed, regardless of truncation', () => {
    expect(
      resolveNextSyncCursor({
        since: '2026-08-01T00:00:00.000Z',
        runStartedAt: '2026-08-14T12:00:00.000Z',
        truncated: false,
        nextSince: '2026-08-02T00:00:00.000Z',
        upsertFailed: true,
      }),
    ).toBe('2026-08-01T00:00:00.000Z');
  });

  it('applies the visibility overlap when the window fully drained', () => {
    expect(
      resolveNextSyncCursor({
        since: '2026-08-01T00:00:00.000Z',
        runStartedAt: '2026-08-14T12:00:00.000Z',
        truncated: false,
        nextSince: null,
        upsertFailed: false,
      }),
    ).toBe('2026-08-13T12:00:00.000Z');
  });

  it('continues from the fetcher-proved nextSince when truncated', () => {
    expect(
      resolveNextSyncCursor({
        since: '2026-08-01T00:00:00.000Z',
        runStartedAt: '2026-08-14T12:00:00.000Z',
        truncated: true,
        nextSince: '2026-08-02T00:00:00.001Z',
        upsertFailed: false,
      }),
    ).toBe('2026-08-02T00:00:00.001Z');
  });

  it('falls back to `since` if truncated but the fetcher gave no continuation (unreachable in practice)', () => {
    expect(
      resolveNextSyncCursor({
        since: '2026-08-01T00:00:00.000Z',
        runStartedAt: '2026-08-14T12:00:00.000Z',
        truncated: true,
        nextSince: null,
        upsertFailed: false,
      }),
    ).toBe('2026-08-01T00:00:00.000Z');
  });
});
