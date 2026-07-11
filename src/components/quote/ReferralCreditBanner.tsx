'use client';

// Referral program redemption (#41 PR 2) — the quote builder's "this
// customer has referral credit" banner. Shown once the builder knows the
// quote's linked customer (a saved/reopened quote — see QuoteBuilder). Owns
// its own POST to /api/referrals/consume (mirrors ReferredByPicker's
// self-contained fetch pattern); reports the result up so the caller can set
// the existing Discount slot + the referralCredit provenance field.

import { useState } from 'react';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export type ReferralCreditApplied = { appliedUsd: number; consumedRowIds: string[]; balanceUsd: number };

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
  onApplied: (result: ReferralCreditApplied) => void;
};

export function ReferralCreditBanner({
  customerId,
  quoteId,
  balanceUsd,
  appliedCredit,
  discountSlotOccupied,
  onApplied,
}: Props) {
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (appliedCredit) {
    return (
      <div className="mt-4 p-2.5 bg-green-50 border border-green-200 rounded-md text-sm text-green-800">
        Applied {usd(appliedCredit.amount)} referral credit as a discount.
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
      onApplied({ appliedUsd: data.appliedUsd, consumedRowIds: data.consumedRowIds ?? [], balanceUsd: data.balanceUsd });
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
