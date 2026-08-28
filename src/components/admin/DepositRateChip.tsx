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
  // The quote's DEPOSIT and its TAGS disagree — an NCE quote off the NCE
  // percent, or a non-NCE quote sitting exactly on it. Staff-lens MED: this is
  // deliberately narrower than "off the default", because an ordinary quote on
  // a hand-set 25% deposit is somebody doing their job, not a conflict, and
  // colouring both the same drains the signal out of the one row 409 is for.
  tagConflict: boolean;
  percent: number;
  expectedPercent: number;
};

export function depositChipState(isNce: boolean, rate: number): DepositChipState {
  const nce = NCE_DEPOSIT_PERCENT;
  const standard = Math.round(BUSINESS_RULES.depositPercentage * 100);
  const expectedPercent = isNce ? nce : standard;
  const percent = Math.round(rate * 100);
  const tagConflict = isNce ? percent !== nce : percent === nce;
  // An NCE quote always shows its deposit (that is the pairing the row asks
  // for); everything else shows only when it is off the business default, which
  // covers both the reverse direction the row names and any hand-set rate.
  return { show: isNce || percent !== standard, tagConflict, percent, expectedPercent };
}

export function DepositRateChip({
  isNce,
  rate,
  frozen = false,
}: {
  isNce: boolean;
  rate: number;
  /** True when this rate is the one frozen into the quote at approval. */
  frozen?: boolean;
}) {
  const state = depositChipState(isNce, rate);
  if (!state.show) return null;
  // Admin-lens MED: 8 of 24 approved/booked quotes have NO frozen rate in their
  // approval snapshot (the staff/verbal approve path writes a minimal one), so
  // for those the number here is the CURRENT rate, not a record of what was
  // agreed. Say which one it is rather than letting the chip imply the stronger
  // claim.
  const basis = frozen ? 'agreed at approval' : 'current rate';
  const title = state.tagConflict
    ? `Deposit ${state.percent}% (${basis}) — off the ${state.expectedPercent}% ${
        isNce ? 'NCE' : 'standard'
      } rate. Not an error on its own: the deposit is deliberately left alone once a quote has been sent.`
    : `Deposit ${state.percent}% (${basis})`;
  return (
    <span
      title={title}
      className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
        state.tagConflict ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600'
      }`}
    >
      {state.percent}% dep
    </span>
  );
}

// Row 409, fix round 2 (delta-verify MED x3). The detail page's staleness
// caution needs to know MORE than "the two percents differ":
//
// - "Reopen the quote and Calculate again" is an instruction /api/quote will
//   409 on for a reprice-locked status (booked/declined/cancelled/abandoned —
//   its REPRICE_LOCKED_STATUSES), and the NCE toggle only gates on
//   customer_approved_at, so a declined quote CAN reach the mismatched state.
// - On a terminal quote (declined/cancelled/abandoned) nothing will ever
//   charge, so the caution is noise: null.
// - On a BOOKED quote the deposit is already settled, so the mismatch is a
//   RECORD of what happened, not an action item — and "the portal charges X%"
//   would be false. Suppressing it entirely would reintroduce the original
//   HIGH (two staff screens disagreeing with nothing explaining it), so it
//   stays visible as kind 'record', with no instruction.
// - Everywhere else the recalculate instruction is real: kind 'recalc'.
//
// Pure and exported so the enumeration above is TESTED, not prose.
export type DepositCaution = {
  kind: 'recalc' | 'record';
  priced: number;
  configured: number;
} | null;

const TERMINAL_STATUSES = new Set(['declined', 'cancelled', 'abandoned']);

export function depositCaution(args: {
  pricedPercent: number;
  configuredPercent: number;
  status: string;
}): DepositCaution {
  const { pricedPercent, configuredPercent, status } = args;
  if (pricedPercent === configuredPercent) return null;
  if (TERMINAL_STATUSES.has(status)) return null;
  return {
    kind: status === 'booked' ? 'record' : 'recalc',
    priced: pricedPercent,
    configured: configuredPercent,
  };
}
