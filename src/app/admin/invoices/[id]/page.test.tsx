// Row 381 (XS, S48 #927 delta-verify LOW): `priorBalanceCollectedUsd`
// (quoteAmendInvoiceSync.ts) INFERS money already collected beyond the
// deposit from the invoice's own total/balance/deposit_applied — it has no
// way to see a manual refund issued directly in Valor (this system has no
// refund integration at all; every refund flow in this app is "issue it
// manually in Valor", see the credit_note/overpaid copy a few lines below in
// page.tsx). That inference is now load-bearing on invoice re-sync math
// (a later amendment's balance): a refund the system can't see would leave
// this figure overstated, silently UNDER-billing the next amendment. This
// repo has no jsdom/testing-library setup, so — same pattern as
// admin/jobs/[id]/page.test.tsx's cancelActionMessage — this covers the
// extracted pure note-builder directly, not a render.
import { describe, expect, it } from 'vitest';
import { priorCollectedWarning } from './page';

describe('priorCollectedWarning', () => {
  it('is null when nothing has been collected beyond the deposit', () => {
    expect(priorCollectedWarning({ total: 1000, balance: 600, deposit_applied: 400 })).toBeNull();
  });

  it('is null when the invoice is fully settled by the deposit alone (balance 0, gap 0)', () => {
    expect(priorCollectedWarning({ total: 400, balance: 0, deposit_applied: 400 })).toBeNull();
  });

  it('warns with the exact dollar figure once a balance payment has landed beyond the deposit', () => {
    // total 1000, deposit 400, balance 0 → 600 collected beyond the deposit.
    const note = priorCollectedWarning({ total: 1000, balance: 0, deposit_applied: 400 });
    expect(note).not.toBeNull();
    expect(note).toContain('$600.00');
    expect(note).toMatch(/refund/i);
    expect(note).toMatch(/Valor/);
  });

  it('is null on a partial/legacy row missing a needed field (defensive, matches priorBalanceCollectedUsd)', () => {
    expect(priorCollectedWarning({ total: null, balance: 0, deposit_applied: 400 })).toBeNull();
    expect(priorCollectedWarning({ total: 1000, balance: undefined, deposit_applied: 400 })).toBeNull();
  });
});
