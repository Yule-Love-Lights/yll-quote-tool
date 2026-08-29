import { describe, it, expect, beforeEach, vi } from 'vitest';

const { sbRef, recordMock } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  recordMock: vi.fn(
    async (
      _action: string,
      _values: string[],
      _ctx?: Record<string, unknown>,
    ): Promise<void> => {},
  ),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('./suppressionAudit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./suppressionAudit')>()),
  recordSuppressionChange: recordMock,
}));

import {
  normalizeSuppressionValues,
  addSuppressedSenders,
  removeSuppressedSenders,
} from './suppression';

describe('normalizeSuppressionValues', () => {
  it('lowercases emails and E.164-normalizes phones, dropping blanks/dupes', () => {
    const out = normalizeSuppressionValues(['  Sales@Vendor.COM ', '(631) 481-9575', 'sales@vendor.com', '', null]);
    expect(out).toContain('sales@vendor.com');
    expect(out).toContain('+16314819575');
    expect(out.filter((v) => v === 'sales@vendor.com')).toHaveLength(1);
    expect(out).not.toContain('');
  });
});

// S75: the audit half. Only a genuinely-new suppression is logged, and only a
// value that was really on the list is logged as removed — otherwise the
// settings panel's history fills with no-ops and the real entry is buried.
function makeSb(current: string[]) {
  const upserts: { key: string; value: string[] }[] = [];
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: { value: current }, error: null }),
    upsert: (row: { key: string; value: string[] }) => {
      upserts.push(row);
      return Promise.resolve({ error: null });
    },
  };
  return { upserts, from: () => chain };
}

describe('suppression audit wiring (S75)', () => {
  beforeEach(() => recordMock.mockClear());

  it('logs only the senders that were not already suppressed', async () => {
    sbRef.current = makeSb(['already@there.com']);
    await addSuppressedSenders(['already@there.com', 'brand@new.com'], { actor: 'op-1' });
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock.mock.calls[0][1]).toEqual(['brand@new.com']);
  });

  it('still writes the list even when nothing is new to log', async () => {
    const sb = makeSb(['already@there.com']);
    sbRef.current = sb;
    await addSuppressedSenders(['Already@There.com']);
    expect(sb.upserts).toHaveLength(1);
    expect(recordMock.mock.calls[0][1]).toEqual([]);
  });

  it('logs a removal only for a value that was actually on the list', async () => {
    sbRef.current = makeSb(['on@list.com']);
    await removeSuppressedSenders(['on@list.com', 'never@there.com'], { actor: 'op-1' });
    expect(recordMock.mock.calls[0][1]).toEqual(['on@list.com']);
  });

  it('carries the caller context through to the audit', async () => {
    sbRef.current = makeSb([]);
    await addSuppressedSenders(['brand@new.com'], { actor: 'op-9', inboxItemId: 'item-9' });
    expect(recordMock.mock.calls[0][2]).toMatchObject({ actor: 'op-9', inboxItemId: 'item-9' });
  });
});
