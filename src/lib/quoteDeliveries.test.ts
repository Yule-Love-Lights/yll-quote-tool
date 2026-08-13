// #250 review fix (LOW): the send route's Promise.allSettled isolation was
// already proven by route.test.ts, but nothing pinned logQuoteDelivery's OWN
// try/catch — a system-level test that masks a rethrow inside allSettled
// would still pass even if this function's isolation were removed. These
// tests exercise logQuoteDelivery() directly, with no allSettled in the way,
// so a regression here can only be caught by this file.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
  getSupabaseClient: () => sbRef.current,
}));

import { logQuoteDelivery } from './quoteDeliveries';

describe('logQuoteDelivery (#250) — best-effort, never breaks the caller', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves (does not reject) when sb.from().insert() throws synchronously', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sbRef.current = {
      from: () => ({
        insert: () => {
          throw new Error('connection reset');
        },
      }),
    };

    await expect(
      logQuoteDelivery({ quoteId: 'q1', channel: 'sms', outcome: 'sent' }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('resolves (and warns, not throws) when the insert returns a Supabase-shaped { error }', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sbRef.current = {
      from: () => ({
        insert: async () => ({ data: null, error: { message: 'relation "quote_deliveries" does not exist' } }),
      }),
    };

    await expect(
      logQuoteDelivery({ quoteId: 'q1', channel: 'email', outcome: 'failed', error: 'GHL 500' }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
