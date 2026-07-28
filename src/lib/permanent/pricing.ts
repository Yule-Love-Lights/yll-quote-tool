// Permanent Lighting pricing engine (ledger #88, plan Phase 1).
//
// PURE. Turns the `permanent` block on QuoteInputs into a holiday-SHAPE
// QuoteResult so everything downstream (save → portal → approve → Valor → jobs →
// invoices) works unchanged — the money spine is service_type-agnostic off
// `total`. The route dispatches to this when service_type === 'permanent'.
//
// Retail = per-foot only (front $40, sides+back $35 — adjustable). Each of the
// four sides bills as its OWN line (#132, S24 — left + right previously combined
// into one "Sides" line; legacy stored results still carry 'permanent-sides').
// Left + right share the sides rate. Materials (tracks/pucks/extensions/…) never
// touch the customer price — they live in the BOM (Phase 2) for cost/margin only.
//
// The FULL rate table is frozen into `permanentRatesSnapshot` so approve/amend
// re-price from it, never live app_settings (the rate-drift guard).

import {
  computeTotalsTail,
  calculateCustomLineItems,
  applyLineOverrides,
  effectiveDepositRate,
  type QuoteInputs,
  type QuoteResult,
  type LineItem,
} from '@/lib/pricing/pricingEngine';
import { DEFAULT_PERMANENT_RATES, type PermanentRates } from './types';

/** Finite, positive footage or 0 — a malformed value never NaNs/negates a price. */
function ft(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The effective $/ft: a positive-finite per-quote custom override wins, else the rate-table value. */
function rate(base: number, custom?: number): number {
  return Number.isFinite(custom) && (custom as number) > 0 ? (custom as number) : base;
}

/**
 * Price a permanent quote. `rates` comes from app_settings at the call site
 * (Phase 3); it defaults to the canonical table so the engine is usable/testable
 * standalone. The passed rates are frozen into the result verbatim.
 */
export function calculatePermanentQuote(
  inputs: QuoteInputs,
  rates: PermanentRates = DEFAULT_PERMANENT_RATES,
): QuoteResult {
  const p = inputs.permanent;

  // Per-side footage → amounts. Each side is its own line (#132); left + right
  // share the sides rate (one Settings field + one per-quote custom override).
  const frontFt = ft(p?.frontFootage ?? 0);
  const leftFt = ft(p?.leftFootage ?? 0);
  const rightFt = ft(p?.rightFootage ?? 0);
  const backFt = ft(p?.backFootage ?? 0);

  const frontRate = rate(rates.frontPerFt, p?.frontCustomRate);
  const sidesRate = rate(rates.sidesPerFt, p?.sidesCustomRate);
  const backRate = rate(rates.backPerFt, p?.backCustomRate);

  const sideLines: LineItem[] = [];
  if (frontFt > 0) {
    sideLines.push({
      id: 'permanent-front',
      label: `Permanent Lighting - Front - ${frontFt} ft ($${frontRate}/ft)`,
      amount: Math.round(frontFt * frontRate),
    });
  }
  if (leftFt > 0) {
    sideLines.push({
      id: 'permanent-left',
      label: `Permanent Lighting - Left Side - ${leftFt} ft ($${sidesRate}/ft)`,
      amount: Math.round(leftFt * sidesRate),
    });
  }
  if (rightFt > 0) {
    sideLines.push({
      id: 'permanent-right',
      label: `Permanent Lighting - Right Side - ${rightFt} ft ($${sidesRate}/ft)`,
      amount: Math.round(rightFt * sidesRate),
    });
  }
  if (backFt > 0) {
    sideLines.push({
      id: 'permanent-back',
      label: `Permanent Lighting - Back - ${backFt} ft ($${backRate}/ft)`,
      amount: Math.round(backFt * backRate),
    });
  }

  // Optional maintenance add-on — only when enabled AND a price is configured
  // (a 0 price hides the feature).
  if (p?.maintenanceAddOn && rates.maintenancePrice > 0) {
    sideLines.push({
      id: 'permanent-maintenance',
      label: 'Annual Maintenance Plan',
      amount: Math.round(rates.maintenancePrice),
    });
  }

  // Custom/manual line items (#27 escape hatch) — same pure helper the holiday
  // engine uses. Then apply per-quote #104 total overrides across ALL lines.
  const lineItems = applyLineOverrides(
    [...sideLines, ...calculateCustomLineItems(inputs)],
    inputs.lineItemPriceOverrides,
  );

  const subtotalBeforeDiscount = lineItems.reduce((sum, li) => sum + li.amount, 0);

  // The subtotal → total tail is the SAME formula holiday uses, but permanent
  // never carries the holiday fees — force them off so a rogue input can't add a
  // rush/takedown/early-install fee to a permanent quote. Staff `discount` still
  // applies. Tax 8.75% + 50% deposit are baked into the shared tail.
  const tail = computeTotalsTail(subtotalBeforeDiscount, {
    ...inputs,
    rushFee: false,
    takedown: 'included',
    installTiming: 'none',
  });

  return {
    lineItems,
    subtotalBeforeDiscount,
    ...tail,
    // The $1,000-minimum flag is a holiday concept; permanent gates at
    // rates.minimumJobAmount on the PORTAL (Phase 5). Keep false here to preserve
    // the home.works payload contract (downstream still reads the flag).
    minimumApplied: false,
    // Permanent has no Santa's/Gingerbread roofline choice.
    rooflineChoice: 'none',
    rooflineOptions: { santas: null, gingerbread: null },
    // Freeze the rates used (the drift guard): approve/amend re-price from this.
    // CLONE (not by-reference) so a future live-app_settings source mutating the
    // rates object in place can never retro-price a stored quote's snapshot.
    permanentRatesSnapshot: { ...rates },
    // #177: freeze the effective deposit rate this result was priced with
    // (already applied via computeTotalsTail's `tail` above).
    depositRate: effectiveDepositRate(inputs.depositPercent),
  };
}
