// Tests for the suppressed-senders audit trail and listing (S75).
//
// The behaviour that matters: only genuinely-new suppressions are logged (so
// the history stays readable), an address belonging to a real customer is
// flagged and floated to the top (that is the whole reason the panel exists),
// and an entry with no history is still shown rather than hidden.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

import { listSuppressedSenders, recordSuppressionChange, SUPPRESSED_ACTION } from './suppressionAudit';

type ActivityRow = { actor: string | null; detail: unknown; created_at: string };
type QuoteRow = { customer_email: string | null; customer_name: string | null; status: string | null };

/** Fake covering the two read chains and the one insert this module makes. */
function makeSb(activity: ActivityRow[], quotes: QuoteRow[]) {
  const inserted: Record<string, unknown>[][] = [];
  const sb = {
    inserted,
    from(table: string) {
      const rows = table === 'dashboard_activity' ? activity : quotes;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        insert: (payload: Record<string, unknown>[]) => {
          inserted.push(payload);
          return Promise.resolve({ error: null });
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
      };
      return chain;
    },
  };
  return sb;
}

beforeEach(() => {
  sbRef.current = makeSb([], []);
});

describe('recordSuppressionChange', () => {
  it('writes one row per identifier, carrying the actor and the item', async () => {
    const sb = makeSb([], []);
    sbRef.current = sb;
    await recordSuppressionChange(SUPPRESSED_ACTION, ['a@b.com', '+15551234567'], {
      actor: 'operator-1',
      inboxItemId: 'item-1',
    });
    expect(sb.inserted).toHaveLength(1);
    const rows = sb.inserted[0];
    expect(rows).toHaveLength(2);
    expect(rows[0].actor).toBe('operator-1');
    expect(rows[0].inbox_item_id).toBe('item-1');
    expect((rows[0].detail as { value: string }).value).toBe('a@b.com');
  });

  it('falls back to the system actor when no operator resolved', async () => {
    const sb = makeSb([], []);
    sbRef.current = sb;
    await recordSuppressionChange(SUPPRESSED_ACTION, ['a@b.com'], { actor: null });
    expect(sb.inserted[0][0].actor).toBe('system');
  });

  it('writes nothing at all for an empty list', async () => {
    const sb = makeSb([], []);
    sbRef.current = sb;
    await recordSuppressionChange(SUPPRESSED_ACTION, []);
    expect(sb.inserted).toHaveLength(0);
  });
});

describe('listSuppressedSenders', () => {
  it('shows an entry that has no history at all, rather than hiding it', async () => {
    sbRef.current = makeSb([], []);
    const entries = await listSuppressedSenders(['old@example.com']);
    expect(entries).toHaveLength(1);
    expect(entries[0].suppressedAt).toBeNull();
    expect(entries[0].suppressedBy).toBeNull();
  });

  it('attaches the most recent suppression row to each entry', async () => {
    sbRef.current = makeSb(
      [
        { actor: 'op-new', detail: { value: 'a@b.com' }, created_at: '2026-08-20T00:00:00Z' },
        { actor: 'op-old', detail: { value: 'a@b.com' }, created_at: '2026-01-01T00:00:00Z' },
      ],
      [],
    );
    const [entry] = await listSuppressedSenders(['a@b.com']);
    // The query orders newest first, so the first row wins.
    expect(entry.suppressedBy).toBe('op-new');
    expect(entry.suppressedAt).toBe('2026-08-20T00:00:00Z');
  });

  it('flags an address that belongs to a real customer', async () => {
    sbRef.current = makeSb([], [
      { customer_email: 'paid@example.com', customer_name: 'Dorinda Novak', status: 'booked' },
    ]);
    const [entry] = await listSuppressedSenders(['paid@example.com']);
    expect(entry.hasQuote).toBe(true);
    expect(entry.quoteStatus).toBe('booked');
    expect(entry.quoteName).toBe('Dorinda Novak');
  });

  it('prefers the quote with money on it when a customer has several', async () => {
    sbRef.current = makeSb([], [
      { customer_email: 'paid@example.com', customer_name: 'Dorinda Novak', status: 'draft' },
      { customer_email: 'paid@example.com', customer_name: 'Dorinda Novak', status: 'booked' },
    ]);
    const [entry] = await listSuppressedSenders(['paid@example.com']);
    expect(entry.quoteStatus).toBe('booked');
  });

  it('floats customers to the top, because those are the rows worth acting on', async () => {
    sbRef.current = makeSb([], [
      { customer_email: 'paid@example.com', customer_name: 'A Customer', status: 'booked' },
    ]);
    const entries = await listSuppressedSenders(['aaa@spam.com', 'paid@example.com', 'zzz@spam.com']);
    expect(entries[0].value).toBe('paid@example.com');
    expect(entries.map((e) => e.value)).toHaveLength(3);
  });

  it('labels emails and phones apart', async () => {
    sbRef.current = makeSb([], []);
    const entries = await listSuppressedSenders(['a@b.com', '+15551234567']);
    const byValue = Object.fromEntries(entries.map((e) => [e.value, e.kind]));
    expect(byValue['a@b.com']).toBe('email');
    expect(byValue['+15551234567']).toBe('phone');
  });

  it('returns nothing for an empty list without querying', async () => {
    sbRef.current = makeSb([], []);
    expect(await listSuppressedSenders([])).toEqual([]);
  });

  it('ignores an activity row whose detail carries no usable value', async () => {
    sbRef.current = makeSb(
      [
        { actor: 'op', detail: null, created_at: '2026-08-20T00:00:00Z' },
        { actor: 'op', detail: { value: 42 }, created_at: '2026-08-20T00:00:00Z' },
      ],
      [],
    );
    const [entry] = await listSuppressedSenders(['a@b.com']);
    expect(entry.suppressedAt).toBeNull();
  });
});
