'use client';

// Referral program redemption (#41 PR 2) — the quote builder's "this
// customer gets free spritzers" banner, shown when the CURRENT quote is a
// referee (someone else referred them). Purely presentational: the click
// just appends an ordinary $0 custom line item (form state only — no
// network call), so this component owns nothing beyond the one button.

type Props = {
  /** Already on the quote (form.customLineItems has the referral-spritzers
   *  row) — shows a confirmation instead of the Add button. */
  alreadyAdded: boolean;
  onAdd: () => void;
};

export function ReferralSpritzerBanner({ alreadyAdded, onAdd }: Props) {
  if (alreadyAdded) {
    return (
      <div className="mt-4 p-2.5 bg-green-50 border border-green-200 rounded-md text-sm text-green-800">
        Added: 2 free 16&quot; spritzers (referral).
      </div>
    );
  }

  return (
    <div className="mt-4 p-2.5 bg-amber-50 border border-amber-200 rounded-md flex items-center justify-between gap-3">
      <p className="text-sm text-amber-900">
        Referral: this customer gets 2 free 16&quot; spritzers.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="shrink-0 text-xs font-medium px-2.5 py-1.5 rounded-md border border-amber-600 text-amber-800 hover:bg-amber-100"
      >
        Add to quote
      </button>
    </div>
  );
}
