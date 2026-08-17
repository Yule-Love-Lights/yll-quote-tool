// Tests for the site-submission GHL retry worker (#195 follow-up).
//
// The point of this worker: a submission that hit a GHL outage used to keep its
// error forever with nothing able to re-drive it. These tests pin the recovery
// path AND the bound, so a permanently-bad row cannot be retried indefinitely.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sync = vi.hoisted(() => ({ syncSubmissionToGhl: vi.fn() }));
vi.mock('./siteFormService', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, syncSubmissionToGhl: sync.syncSubmissionToGhl };
});

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => sbRef.current }));

import { retryStuckSubmissions, MAX_RETRIES } from './siteFormRetry';

function makeSb(rows: Array<Record<string, unknown>>, selectError: { message: string } | null = null) {
  const updates: Array<Record<string, unknown>> = [];
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    in: () => builder,
    lt: () => builder,
    eq: () => builder,
    order: () => builder,
    update: (payload: Record<string, unknown>) => {
      updates.push(payload);
      return builder;
    },
    limit: async () => ({ data: selectError ? null : rows, error: selectError }),
    then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
  });
  return { client: builder, updates };
}

const ROW = {
  id: 'sub-1',
  form_type: 'newsletter',
  email: 'a@b.com',
  name: 'Pat',
  phone: null,
  retry_count: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('retryStuckSubmissions', () => {
  it('re-drives a stuck row and marks it synced', async () => {
    sync.syncSubmissionToGhl.mockResolvedValue({ contactId: 'contact-9', tags: ['newsletter-signup'] });
    const sb = makeSb([{ ...ROW }]);
    sbRef.current = sb.client;

    const summary = await retryStuckSubmissions({ now: new Date('2026-08-17T12:00:00Z') });

    expect(summary).toMatchObject({ ok: true, scanned: 1, synced: 1, stillFailing: 0 });
    const update = sb.updates[0]!;
    expect(update.sync_status).toBe('synced');
    expect(update.ghl_contact_id).toBe('contact-9');
    expect(update.sync_error).toBeNull();
    expect(update.retry_count).toBe(1);
  });

  it('records a still-failing row without losing it', async () => {
    sync.syncSubmissionToGhl.mockRejectedValue(new Error('GHL still down'));
    const sb = makeSb([{ ...ROW, retry_count: 1 }]);
    sbRef.current = sb.client;

    const summary = await retryStuckSubmissions({ now: new Date() });

    expect(summary).toMatchObject({ ok: true, synced: 0, stillFailing: 1, exhausted: 0 });
    expect(sb.updates[0]!.sync_status).toBe('error');
    expect(sb.updates[0]!.retry_count).toBe(2);
  });

  it('gives up after MAX_RETRIES and says so on the row', async () => {
    sync.syncSubmissionToGhl.mockRejectedValue(new Error('permanently bad address'));
    const sb = makeSb([{ ...ROW, retry_count: MAX_RETRIES - 1 }]);
    sbRef.current = sb.client;

    const summary = await retryStuckSubmissions({ now: new Date() });

    expect(summary).toMatchObject({ exhausted: 1, stillFailing: 0 });
    expect(String(sb.updates[0]!.sync_error)).toContain('gave up');
  });

  it('does not spin forever on an unknown form type', async () => {
    const sb = makeSb([{ ...ROW, form_type: 'not-a-form' }]);
    sbRef.current = sb.client;

    await retryStuckSubmissions({ now: new Date() });

    expect(sb.updates[0]!.sync_status).toBe('skipped');
    expect(sync.syncSubmissionToGhl).not.toHaveBeenCalled();
  });

  it('reports a query failure instead of throwing', async () => {
    const sb = makeSb([], { message: 'db down' });
    sbRef.current = sb.client;
    const summary = await retryStuckSubmissions({ now: new Date() });
    expect(summary.ok).toBe(false);
    expect(summary.error).toBe('db down');
  });

  it('no-ops safely when Supabase is not configured', async () => {
    sbRef.current = null;
    const summary = await retryStuckSubmissions({ now: new Date() });
    expect(summary.ok).toBe(false);
  });
});
