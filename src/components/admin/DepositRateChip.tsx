import { BUSINESS_RULES, NCE_DEPOSIT_PERCENT } from '@/lib/pricing/pricingEngine';

// Row 409 — deposit-rate visibility on the admin quotes list.
//
// Row 328 deliberately stopped the NCE tag from moving the deposit on a quote
// that has already left draft: the customer may be holding a portal link
// quoting the current figure, so silently re-cutting their deposit is worse
// than the mismatch. Jason ruled 2026-08-25 that a sent NCE quote sitting off
// the NCE rate is ACCEPTABLE for edge cases and must NOT be auto-corrected.
// What was missing was any way to SEE it: the list showed an NCE badge and a
// total, and no deposit anywhere. Measured on prod the day this shipped: of 5
// NCE quotes, 4 sit at 40% and one — a real SENT quote — sits at 50%.
//
// So this chip reports, it does not enforce.

export type DepositChipState = {
  // Non-default rates are the only ones worth pixels: a plain holiday quote at
  // the business default deposit says nothing a reader needs.
  show: boolean;
  // The quote is off the rate its tags imply — an NCE quote not at the NCE
  // percent, which is the case row 409 exists for.
  mismatch: boolean;
  percent: number;
  expectedPercent: number;
};

export function depositChipState(isNce: boolean, rate: number): DepositChipState {
  const expectedPercent = Math.round((isNce ? NCE_DEPOSIT_PERCENT / 100 : BUSINESS_RULES.depositPercentage) * 100);
  const percent = Math.round(rate * 100);
  const mismatch = percent !== expectedPercent;
  // An NCE quote always shows its deposit (that is the pairing the row asks
  // for); everything else shows only when it is off the business default,
  // which covers the reverse direction the row names — the tag dropping to
  // false while a 40% deposit stays behind.
  return { show: isNce || mismatch, mismatch, percent, expectedPercent };
}

export function DepositRateChip({ isNce, rate }: { isNce: boolean; rate: number }) {
  const state = depositChipState(isNce, rate);
  if (!state.show) return null;
  const title = state.mismatch
    ? `Deposit ${state.percent}% — off the ${state.expectedPercent}% ${isNce ? 'NCE' : 'standard'} rate. Not an error on its own: the deposit is deliberately left alone once a quote has been sent.`
    : `Deposit ${state.percent}%`;
  return (
    <span
      title={title}
      className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
        state.mismatch ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600'
      }`}
    >
      {state.percent}% dep
    </span>
  );
}
