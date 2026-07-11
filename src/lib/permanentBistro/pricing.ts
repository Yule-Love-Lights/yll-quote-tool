// Permanent Bistro Lighting — pure pricing engine (service_type =
// 'permanent_bistro', PENDING wiring).
//
// A SELF-CONTAINED sibling of calculateEventQuote / calculatePermanentQuote:
// it prices permanent bistro runs (long-term café string lights) + poles at
// an INDEPENDENT rate table and emits the same QuoteResult shape the portal
// already consumes. It imports ONLY exported symbols from pricingEngine — it
// touches no private helper and no shared dispatch seam, so it is safe
// Phase-A parallel work. Wiring it in (the ServiceType union + /api/quote
// dispatch) is a later PR.
//
// Deliberately EXCLUDED (allow-list, not deny-list): roofline / minis /
// spritzers / accessories / surfaces — none of those apply to a permanent
// bistro install. Reuses the shared #27 custom-line-item escape hatch (every
// other vertical — holiday/event/permanent — carries it) and the #104
// per-line override mechanism so the portal click-to-edit-price + free-item
// features behave identically.

import {
  BUSINESS_RULES,
  type LineItem,
  type QuoteInputs,
  type QuoteResult,
} from '@/lib/pricing/pricingEngine';
import type { PermanentBistroRates } from './types';
import { DEFAULT_PERMANENT_BISTRO_RATES } from './types';

// A footage/quantity must be finite + positive before it is multiplied by a
// rate; anything else contributes 0 (mirrors the holiday/event engines' guard).
function units(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// The $0-bill guardrail: a priced item can NEVER silently bill $0 from a
// missing or zero rate. perFt/perPole must be positive finite numbers.
// `minimum` is a portal approval GATE (mirrors permanent's minimumJobAmount,
// #18 "minimum is a gate, not a floor"), so 0 is a VALID value — it must
// still be a finite, non-negative number (a misconfigured negative/NaN
// minimum is a bad rate table and should throw, same as any other field).
function assertPermanentBistroRates(r: PermanentBistroRates): void {
  const positiveRates: Array<[string, number]> = [
    ['perFt', r.perFt],
    ['perPole', r.perPole],
  ];
  for (const [name, value] of positiveRates) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `calculatePermanentBistro: invalid permanent bistro rate ${name}=${value} — perFt and perPole must be positive finite numbers (the $0-bill guardrail).`,
      );
    }
  }
  if (!Number.isFinite(r.minimum) || r.minimum < 0) {
    throw new Error(
      `calculatePermanentBistro: invalid permanent bistro rate minimum=${r.minimum} — minimum must be a finite number >= 0 (0 means the approval gate is off).`,
    );
  }
}

function withIdentity(
  item: { id?: string; sceneItemIds?: string[] },
  fallbackId: string,
): Pick<LineItem, 'id' | 'sceneItemIds'> {
  return {
    id: item.id ?? fallbackId,
    ...(item.sceneItemIds ? { sceneItemIds: item.sceneItemIds } : {}),
  };
}

// Permanent bistro runs — priced per linear foot. One line per run; a run
// with no input id gets a synthesized 'permanent-bistro-<index>' id so it can
// still be targeted by a #104 override / portal toggle.
function calculateBistroLines(inputs: QuoteInputs, rates: PermanentBistroRates): LineItem[] {
  const bistro = inputs.permanentBistro?.bistro;
  if (!Array.isArray(bistro)) return [];
  return bistro
    .filter((b) => b && Number.isFinite(b.footage) && b.footage > 0)
    .map((b, i) => ({
      label: `Permanent Bistro Lighting – ${b.footage}ft`,
      amount: Math.round(units(b.footage) * rates.perFt),
      ...withIdentity(b, `permanent-bistro-${i}`),
    }));
}

// Permanent poles/supports — flat per unit, ONE bundled line (not one per
// pole). Stable id so it's individually overridable/toggleable.
function calculatePoles(inputs: QuoteInputs, rates: PermanentBistroRates): LineItem[] {
  const n = inputs.permanentBistro?.poles;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return [];
  const qty = Math.floor(n);
  return [
    {
      id: 'permanent-bistro-poles',
      label: `Poles (${qty})`,
      amount: Math.round(qty * rates.perPole),
    },
  ];
}

// Custom / manual line items — passed straight through (mirrors the holiday
// engine's calculateCustomLineItems and event's local copy: the amount IS the
// price, malformed entries skipped). Kept as a local copy (not the
// pricingEngine export) so this module stays a self-contained Phase-A sibling
// with zero shared private helpers, matching lib/event/pricing.ts.
function calculateCustomLineItems(inputs: QuoteInputs): LineItem[] {
  if (!Array.isArray(inputs.customLineItems)) return [];
  return inputs.customLineItems
    .filter(
      (c) =>
        c &&
        typeof c.label === 'string' &&
        c.label.trim().length > 0 &&
        typeof c.amount === 'number' &&
        Number.isFinite(c.amount) &&
        c.amount >= 0,
    )
    .map((c) => {
      const qty =
        typeof c.quantity === 'number' && Number.isFinite(c.quantity) && c.quantity >= 1
          ? Math.floor(c.quantity)
          : 1;
      const label = qty === 1 ? c.label.trim() : `${c.label.trim()} × ${qty}`;
      return { label, amount: c.amount * qty, ...(c.id ? { id: c.id } : {}) };
    });
}

// #104 per-quote line-item TOTAL overrides (keyed by stable id). PRESENCE-keyed —
// a $0 override is a valid "free item" (NOT the $0-guardrail case, which is a
// misconfigured RATE table). Mirrors lib/event/pricing.ts's local override
// helpers so the portal click-to-edit-price + free-item features work
// identically on permanent bistro quotes.
function overrideAmount(
  id: string | undefined,
  overrides: QuoteInputs['lineItemPriceOverrides'],
): number | undefined {
  if (!id || !overrides || !Object.prototype.hasOwnProperty.call(overrides, id)) return undefined;
  const a = overrides[id]?.amount;
  return typeof a === 'number' && Number.isFinite(a) && a >= 0 ? a : undefined;
}

function applyLineOverrides(
  lines: LineItem[],
  overrides: QuoteInputs['lineItemPriceOverrides'],
): LineItem[] {
  if (!overrides) return lines;
  return lines.map((li) => {
    const a = overrideAmount(li.id, overrides);
    return a === undefined ? li : { ...li, amount: a };
  });
}

/**
 * Price a permanent bistro quote. Pure; deterministic. Throws only when the
 * rate table is misconfigured (the $0 guardrail). Emits a complete
 * QuoteResult so the shared portal adapter / approve path can consume it
 * exactly like every other vertical's result — with rush/takedown/
 * early-install/roofline inert (permanent bistro has none of those).
 *
 * `rates.minimum` is NEVER applied here as a price floor or adjustment line —
 * it mirrors permanent's `minimumJobAmount` exactly (#18 "minimum is a gate,
 * not a floor"): frozen into `permanentBistroRatesSnapshot` for a later
 * portal-gate wiring PR to read via `minimumOrderSubtotal`, same as permanent.
 */
export function calculatePermanentBistro(
  inputs: QuoteInputs,
  rates: PermanentBistroRates = DEFAULT_PERMANENT_BISTRO_RATES,
): QuoteResult {
  assertPermanentBistroRates(rates);

  const lineItems = applyLineOverrides(
    [
      ...calculateBistroLines(inputs, rates),
      ...calculatePoles(inputs, rates),
      ...calculateCustomLineItems(inputs),
    ],
    inputs.lineItemPriceOverrides,
  );

  const subtotalBeforeDiscount = lineItems.reduce((sum, li) => sum + li.amount, 0);

  // Totals tail — a simplified computeTotalsTail: manual discount + tax + 50%
  // deposit. NO rush, NO premium takedown, NO early-install (none apply to a
  // permanent bistro install). Same rounding as the holiday/event tail.
  let discountAmount = 0;
  if (inputs.discount) {
    const amount =
      Number.isFinite(inputs.discount.amount) && inputs.discount.amount > 0 ? inputs.discount.amount : 0;
    discountAmount =
      inputs.discount.type === 'percentage'
        ? Math.round(subtotalBeforeDiscount * amount * 100) / 100
        : amount;
  }
  const subtotalAfterDiscount = Math.max(0, subtotalBeforeDiscount - discountAmount);
  const taxableAmount = subtotalAfterDiscount;
  const taxAmount = Math.round(taxableAmount * BUSINESS_RULES.taxRate * 100) / 100;
  const total = Math.round((taxableAmount + taxAmount) * 100) / 100;
  const depositAmount = Math.round(total * BUSINESS_RULES.depositPercentage * 100) / 100;
  const balanceDue = Math.round((total - depositAmount) * 100) / 100;

  return {
    lineItems,
    subtotalBeforeDiscount,
    discountAmount,
    earlyInstallDiscountAmount: 0,
    subtotalAfterDiscount,
    minimumApplied: false,
    rushFeeAmount: 0,
    takedownAmount: 0,
    taxableAmount,
    taxAmount,
    total,
    depositAmount,
    balanceDue,
    // Permanent bistro has no Santa's/Gingerbread roofline choice (mirrors
    // lib/permanent/pricing.ts).
    rooflineChoice: 'none',
    rooflineOptions: { santas: null, gingerbread: null },
    // The rate table this result was priced with — frozen for the approve/amend
    // rate-drift guard (mirrors permanentRatesSnapshot / eventRatesSnapshot).
    permanentBistroRatesSnapshot: { ...rates },
  };
}
