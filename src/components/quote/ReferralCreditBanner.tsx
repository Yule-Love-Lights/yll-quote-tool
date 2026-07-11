'use client';

// Referral program redemption (#41 PR 2 + adversarial-review fixes) — the
// quote builder's "this customer has referral credit" banner. Shown once the
// builder knows the quote's linked customer (a saved/reopened quote — see
// QuoteBuilder). Owns its own POST to /api/referrals/consume (Apply) AND
// /api/referrals/unconsume (Remove) — mirrors ReferredByPicker's self-
// contained fetch pattern; reports each result up so the caller can set the
// Discount slot + persist the quote. QuoteBuilder owns the ACTUAL quote save
// (via the same path Calculate uses) since only it has the full form/runQuote
// context — see its applyReferralCredit / handleReferralCreditRemoved.

import { useState } from 'react';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export type ReferralCreditApplied = { appliedUsd: number; consumedRowIds: string[]; balanceUsd: number };
export type ReferralCreditRemoved = { releasedUsd: number };

type Props = {
  customerId: string;
  quoteId: string;
  /** The customer's current spendable balance (creditBalanceFor, via /api/customers). */
  balanceUsd: number;
  /** Set once this credit has been applied to THIS quote (form.referralCredit). */
  appliedCredit: { amount: number } | null;
  /** True when some OTHER discount (manual, or an early-install promo) already
   *  occupies the quote's one discount slot — disables the Apply button. */
  discountSlotOccupied: boolean;
  /** Set by the PARENT when its own persist-to-quote right after Apply (or
   *  Remove) failed — the credit was already consumed/released server-side,
   *  so this is a loud, blocking warning, not a dismissable error. */
  persistError?: string | null;
  onApplied: (result: ReferralCreditApplied) => void | Promise<void>;
  onRemoved: (result: ReferralCreditRemoved) => void | Promise<void>;
};

export function ReferralCreditBanner({
  customerId,
  quoteId,
  balanceUsd,
  appliedCredit,
  discountSlotOccupied,
  persistError,
  onApplied,
  onRemoved,
}: Props) {
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const handleRemove = async () => {
    setRemoving(true);
    setRemoveError(null);
    try {
      const res = await fetch('/api/referrals/unconsume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, quoteId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to remove the referral credit');
      await onRemoved({ releasedUsd: typeof data.releasedUsd === 'number' ? data.releasedUsd : 0 });
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setRemoving(false);
    }
  };

  if (appliedCredit) {
    return (
      <div className="mt-4">
        <div className="p-2.5 bg-green-50 border border-green-200 rounded-md text-sm text-green-800 flex items-center justify-between gap-3">
          <span>Applied {usd(appliedCredit.amount)} referral credit as a discount.</span>
          <button
            type="button"
            onClick={handleRemove}
            disabled={removing}
            className="shrink-0 text-xs font-medium px-2.5 py-1 rounded-md border border-green-600 text-green-800 hover:bg-green-100 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            {removing ? 'Removing…' : 'Remove'}
          </button>
        </div>
        {removeError && <p className="mt-1 text-xs text-red-600">{removeError}</p>}
        {persistError && (
          <p className="mt-1.5 p-2 bg-red-50 border border-red-300 rounded-md text-sm text-red-800 font-medium">
            {persistError}
          </p>
        )}
      </div>
    );
  }

  if (balanceUsd <= 0) return null;

  const handleApply = async () => {
    setApplying(true);
    setError(null);
    try {
      const res = await fetch('/api/referrals/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, quoteId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to apply the referral credit');
      await onApplied({ appliedUsd: data.appliedUsd, consumedRowIds: data.consumedRowIds ?? [], balanceUsd: data.balanceUsd });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="mt-4 p-2.5 bg-amber-50 border border-amber-200 rounded-md">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-amber-900">
          This customer has {usd(balanceUsd)} referral credit.
        </p>
        <button
          type="button"
          onClick={handleApply}
          disabled={discountSlotOccupied || applying}
          className="shrink-0 text-xs font-medium px-2.5 py-1.5 rounded-md border border-amber-600 text-amber-800 hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          {applying ? 'Applying…' : 'Apply as discount'}
        </button>
      </div>
      {discountSlotOccupied && (
        <p className="mt-1 text-xs text-amber-700">Manual discount in use.</p>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
