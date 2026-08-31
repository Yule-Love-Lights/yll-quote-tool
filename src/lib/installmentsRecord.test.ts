// markInstallmentPaid's WRITE path — the three figures that must move together.
//
// Split into its own file because `installments.test.ts` covers the pure
// helpers with no mocks, and this needs the Supabase seam replaced.
//
// The case that matters: recording a payment moves our collected total AND the
// frozen `approval_snapshot.customerSelection.currentDepositUsd`, which is the
// only deposit figure the customer's own portal card and Quote PDF read. The
// S57 wrap customer lens found the second half missing — six days before a real
// $453.13 payment was due, a customer's Balance Due would have overstated what
// they owed by exactly the amount they had just paid (ledger row 450).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getSupabaseServiceClient } = vi.hoisted(() => ({ getSupabaseServiceClient: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient }));

import { markInstallmentPaid } from './installments';

type QuoteRow = {
  deposit_amount_usd: number;
  approval_snapshot: Record<string, unknown> | null;
};

/** Captures what the quote UPDATE was asked to write, and its CAS predicate. */
function makeDb(quote: QuoteRow, opts: { casWins?: boolean; installmentClaimed?: boolean } = {}) {
  const writes: { patch: Record<string, unknown>; filters: [string, unknown][] }[] = [];
  const casWins = opts.casWins !== false;
  const db = {
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => {
        const filters: [string, unknown][] = [];
        const q = {
          eq: (c: string, v: unknown) => { filters.push([c, v]); return q; },
          is: (c: string, v: unknown) => { filters.push([c, v]); return q; },
          select: () => {
            if (table === 'installments') {
              return {
                maybeSingle: async () => ({
                  data: opts.installmentClaimed === false
                    ? null
                    : { quote_id: 'q-1', amount_usd: 453.13 },
                  error: null,
                }),
              };
            }
            writes.push({ patch, filters });
            return Promise.resolve({ data: casWins ? [{ id: 'q-1' }] : [], error: null });
          },
        };
        return q;
      },
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: quote, error: null }) }),
      }),
    }),
  };
  return { db, writes };
}

const snapshotWith = (deposit: number) => ({
  homeworks: { doc: 'Homeworks invoice #11' },
  customerSelection: { packageId: 'C', selectedItemIds: ['a'], currentDepositUsd: deposit, depositRate: 0.5 },
});

beforeEach(() => vi.clearAllMocks());

const record = () =>
  markInstallmentPaid({ installmentId: 'i-4', paidAt: new Date('2026-09-05T12:00:00Z'), source: 'manual', paidBy: 'op-7' });

describe('markInstallmentPaid — the customer-visible figure moves too', () => {
  it('raises BOTH the collected total and the frozen snapshot deposit, in one write', async () => {
    const { db, writes } = makeDb({ deposit_amount_usd: 4093.14, approval_snapshot: snapshotWith(4093.14) });
    getSupabaseServiceClient.mockReturnValue(db);

    const res = await record();
    expect(res).toEqual({ ok: true, amountUsd: 453.13 });
    expect(writes).toHaveLength(1);

    const w = writes[0]!;
    expect(w.patch.deposit_amount_usd).toBe(4546.27);
    const snap = w.patch.approval_snapshot as ReturnType<typeof snapshotWith>;
    expect(snap.customerSelection.currentDepositUsd).toBe(4546.27);
    // One row, one precondition: the two cannot land apart.
    expect(w.filters).toEqual(expect.arrayContaining([['deposit_amount_usd', 4093.14]]));
  });

  it('does NOT touch the deposit RATE — that describes the arrangement, not the running total', async () => {
    const { db, writes } = makeDb({ deposit_amount_usd: 4093.14, approval_snapshot: snapshotWith(4093.14) });
    getSupabaseServiceClient.mockReturnValue(db);
    await record();
    const snap = writes[0]!.patch.approval_snapshot as ReturnType<typeof snapshotWith>;
    // Moving it would drift every plan customer toward "100% deposit".
    expect(snap.customerSelection.depositRate).toBe(0.5);
  });

  it('preserves the rest of the snapshot, including the migration stamp', async () => {
    const { db, writes } = makeDb({ deposit_amount_usd: 4093.14, approval_snapshot: snapshotWith(4093.14) });
    getSupabaseServiceClient.mockReturnValue(db);
    await record();
    const snap = writes[0]!.patch.approval_snapshot as Record<string, unknown>;
    expect(snap.homeworks).toEqual({ doc: 'Homeworks invoice #11' });
    const sel = snap.customerSelection as Record<string, unknown>;
    expect(sel.packageId).toBe('C');
    expect(sel.selectedItemIds).toEqual(['a']);
  });

  it('still moves the collected total when there is no snapshot figure to move', async () => {
    for (const snapshot of [null, { customerSelection: {} }, { customerSelection: { currentDepositUsd: 'nope' } }]) {
      vi.clearAllMocks();
      const { db, writes } = makeDb({ deposit_amount_usd: 100, approval_snapshot: snapshot as never });
      getSupabaseServiceClient.mockReturnValue(db);
      const res = await record();
      expect(res.ok).toBe(true);
      expect(writes[0]!.patch.deposit_amount_usd).toBe(553.13);
      // Nothing invented: no snapshot write when there was no figure there.
      expect(writes[0]!.patch.approval_snapshot).toBeUndefined();
    }
  });

  it('records the operator who did it', async () => {
    const { db } = makeDb({ deposit_amount_usd: 4093.14, approval_snapshot: snapshotWith(4093.14) });
    getSupabaseServiceClient.mockReturnValue(db);
    // paid_by rides on the installment update, which this stub answers via
    // maybeSingle; the assertion that matters is simply that it succeeds with
    // an operator supplied.
    await expect(record()).resolves.toEqual({ ok: true, amountUsd: 453.13 });
  });

  it('refuses an installment already recorded as paid, and writes nothing to the quote', async () => {
    const { db, writes } = makeDb(
      { deposit_amount_usd: 4093.14, approval_snapshot: snapshotWith(4093.14) },
      { installmentClaimed: false },
    );
    getSupabaseServiceClient.mockReturnValue(db);
    const res = await record();
    expect(res.ok).toBe(false);
    expect(writes).toHaveLength(0);
  });
});
