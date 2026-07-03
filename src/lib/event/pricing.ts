// Event Lighting — pure pricing engine (service_type = 'event').
//
// A SELF-CONTAINED sibling of calculateQuote: it prices the event-allowed items
// (C9 rooflines, mini wraps, spritzers, curtain, temporary bistro, barrel/box
// supports, custom lines) at an INDEPENDENT event rate table and emits the same
// QuoteResult shape the holiday engine + portal already consume. It imports ONLY
// exported symbols from pricingEngine (BUSINESS_RULES + types) — it touches no
// private helper and no shared dispatch seam, so it is safe Phase-A parallel work
// alongside the Permanent build. Wiring it in at /api/quote is Phase B.
//
// Deliberately EXCLUDED (allow-list, not deny-list): garland / wreath / bow
// accessories, and the rush / premium-takedown / early-install fees — none apply
// to a temporary event install. Reuses the holiday labels + stable ids so the
// portal lineItemKind parser + #104 identity keys behave identically.

import {
  BUSINESS_RULES,
  type LineItem,
  type MiniLightType,
  type QuoteResult,
  type RooflineChoice,
  type RooflineDifficulty,
} from '@/lib/pricing/pricingEngine';
import type { EventQuoteInputs, EventRates } from './types';
import { DEFAULT_EVENT_RATES } from './types';

// A footage/quantity must be finite + positive before it is multiplied by a rate;
// anything else contributes 0 (mirrors the holiday engine's `units` guard).
function units(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// The $0-bill guardrail: a priced item can NEVER silently bill $0 from a missing
// or zero rate (the failure mode that leaves bistro unpriced in the holiday
// model). Every event rate must be a positive finite number; otherwise throw so
// a misconfigured rate table surfaces loudly at Calculate time.
function assertEventRates(r: EventRates): void {
  const rates: Array<[string, number]> = [
    ['roofline.easy', r.roofline.easy],
    ['roofline.medium', r.roofline.medium],
    ['roofline.hard', r.roofline.hard],
    ['mini.canopy', r.mini.canopy],
    ['mini.trunk', r.mini.trunk],
    ['spritzer.16', r.spritzer['16']],
    ['spritzer.24', r.spritzer['24']],
    ['spritzer.32', r.spritzer['32']],
    ['bistroPerFt', r.bistroPerFt],
    ['barrelBoxPrice', r.barrelBoxPrice],
  ];
  for (const [name, value] of rates) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `calculateEventQuote: invalid event rate ${name}=${value} — every rate must be a positive finite number (the $0-bill guardrail).`,
      );
    }
  }
}

// $/ft for a roofline-family line: a per-quote custom override (#102) when it is
// a positive finite number, else the event difficulty rate.
function resolveRooflineRate(
  rates: EventRates,
  difficulty: RooflineDifficulty,
  customRate?: number,
): number {
  return Number.isFinite(customRate) && (customRate as number) > 0
    ? (customRate as number)
    : rates.roofline[difficulty];
}

function rooflineRateLabel(difficulty: RooflineDifficulty, customRate?: number): string {
  return Number.isFinite(customRate) && (customRate as number) > 0
    ? `$${customRate}/ft`
    : difficulty;
}

function rooflineCost(
  footage: number,
  difficulty: RooflineDifficulty,
  rates: EventRates,
  customRate?: number,
): number {
  return Math.round(units(footage) * resolveRooflineRate(rates, difficulty, customRate));
}

// Both mutually-exclusive roofline options at EVENT rates (mirrors the holiday
// rooflineOptionsFor). Santas = front only; Gingerbread = front + ridge/sides.
function eventRooflineOptions(inputs: EventQuoteInputs, rates: EventRates): QuoteResult['rooflineOptions'] {
  const frontCost = rooflineCost(inputs.santasFootage, inputs.santasDifficulty, rates, inputs.santasCustomRate);
  const ridgeSidesCost = rooflineCost(
    inputs.gingerbreadFootage,
    inputs.gingerbreadDifficulty,
    rates,
    inputs.gingerbreadCustomRate,
  );
  const santas = inputs.santasFootage > 0 ? { footage: inputs.santasFootage, amount: frontCost } : null;
  const gingerbread =
    inputs.gingerbreadFootage > 0
      ? { footage: inputs.santasFootage + inputs.gingerbreadFootage, amount: frontCost + ridgeSidesCost }
      : null;
  return { santas, gingerbread };
}

// Honor an explicit operator pick; else infer (Gingerbread if ridge/sides
// footage, else Santa's, else none). Events don't use the holiday $1,000-minimum
// auto-targeting — that's a seasonal-pricing behavior.
function resolveRooflineChoice(
  inputs: EventQuoteInputs,
  options: QuoteResult['rooflineOptions'],
): RooflineChoice {
  if (inputs.rooflineChoice) return inputs.rooflineChoice;
  if (options.gingerbread) return 'gingerbread';
  if (options.santas) return 'santas';
  return 'none';
}

function rooflineLineItem(
  inputs: EventQuoteInputs,
  choice: RooflineChoice,
  options: QuoteResult['rooflineOptions'],
): LineItem[] {
  if (choice === 'santas' && options.santas) {
    return [
      {
        label: `Santa's Roofline – ${inputs.santasFootage}ft (${rooflineRateLabel(inputs.santasDifficulty, inputs.santasCustomRate)})`,
        amount: options.santas.amount,
        id: 'roofline-santas',
      },
    ];
  }
  if (choice === 'gingerbread' && options.gingerbread) {
    return [
      {
        label: `Gingerbread – ${options.gingerbread.footage}ft (front + ridge + sides)`,
        amount: options.gingerbread.amount,
        id: 'roofline-gingerbread',
      },
    ];
  }
  return [];
}

const MINI_LABELS: Record<MiniLightType, string> = {
  tree: 'Tree',
  bush: 'Bush',
  column: 'Column',
  railing: 'Railing',
  curtain: 'Curtain Lights',
};

// Mini surfaces with no wrap style — one flat canopy rate, label without a "wrap"
// qualifier (mirrors the holiday NO_WRAP_STYLE_TYPES).
const NO_WRAP_STYLE_TYPES: ReadonlySet<MiniLightType> = new Set(['column', 'railing', 'curtain']);

function withIdentity(item: { id?: string; sceneItemIds?: string[] }): Pick<LineItem, 'id' | 'sceneItemIds'> {
  return {
    ...(item.id ? { id: item.id } : {}),
    ...(item.sceneItemIds ? { sceneItemIds: item.sceneItemIds } : {}),
  };
}

function calculateMiniLights(inputs: EventQuoteInputs, rates: EventRates): LineItem[] {
  return inputs.miniLightItems.map(item => {
    const count = units(item.stringCount);
    const strings = count === 1 ? '1 string' : `${count} strings`;
    if (NO_WRAP_STYLE_TYPES.has(item.type)) {
      return {
        label: `${MINI_LABELS[item.type]} – ${strings}`,
        amount: count * rates.mini.canopy,
        ...withIdentity(item),
      };
    }
    const rate = rates.mini[item.wrapStyle];
    return {
      label: `${MINI_LABELS[item.type]} – ${item.wrapStyle} wrap, ${strings}`,
      amount: count * rate,
      ...withIdentity(item),
    };
  });
}

function calculateSpritzers(inputs: EventQuoteInputs, rates: EventRates): LineItem[] {
  return inputs.spritzers.map(item => {
    const qty = units(item.quantity);
    const amount = qty * rates.spritzer[item.size];
    const label = qty === 1 ? `${item.size}" Spritzer` : `${item.size}" Spritzers × ${qty}`;
    return { label, amount, ...withIdentity(item) };
  });
}

// Temporary bistro — priced per linear foot. Label avoids the roofline/wonderland/
// gingerbread/ridge keywords so the portal lineItemKind parser doesn't misfile it.
function calculateBistro(inputs: EventQuoteInputs, rates: EventRates): LineItem[] {
  if (!Array.isArray(inputs.bistro)) return [];
  return inputs.bistro
    .filter(b => b && Number.isFinite(b.footage) && b.footage > 0)
    .map(b => ({
      label: `Bistro Lighting – ${b.footage}ft`,
      amount: Math.round(units(b.footage) * rates.bistroPerFt),
      ...withIdentity(b),
    }));
}

// Barrel/box temporary supports — flat per unit. Customer-facing label per the
// council ("barrels/boxes" means nothing to a customer).
function calculateBarrelBoxes(inputs: EventQuoteInputs, rates: EventRates): LineItem[] {
  const n = inputs.barrelBoxes;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return [];
  const qty = Math.floor(n);
  return [
    {
      label: qty === 1 ? 'Freestanding light pole & base' : `Freestanding light poles & bases × ${qty}`,
      amount: qty * rates.barrelBoxPrice,
    },
  ];
}

// Custom / manual line items — passed straight through (mirrors the holiday
// calculateCustomLineItems: the amount IS the price, malformed entries skipped).
function calculateCustomLineItems(inputs: EventQuoteInputs): LineItem[] {
  if (!Array.isArray(inputs.customLineItems)) return [];
  return inputs.customLineItems
    .filter(
      c =>
        c &&
        typeof c.label === 'string' &&
        c.label.trim().length > 0 &&
        typeof c.amount === 'number' &&
        Number.isFinite(c.amount) &&
        c.amount >= 0,
    )
    .map(c => {
      const qty =
        typeof c.quantity === 'number' && Number.isFinite(c.quantity) && c.quantity >= 1
          ? Math.floor(c.quantity)
          : 1;
      const label = qty === 1 ? c.label.trim() : `${c.label.trim()} × ${qty}`;
      return { label, amount: c.amount * qty, ...(c.id ? { id: c.id } : {}) };
    });
}

/**
 * Price an event quote. Pure; deterministic. Throws only when the rate table is
 * misconfigured (the $0 guardrail). Emits a complete QuoteResult so the shared
 * portal adapter / approve path can consume it exactly like a holiday result —
 * with rush/takedown/early-install/fullYule inert (events have none).
 */
export function calculateEventQuote(
  inputs: EventQuoteInputs,
  rates: EventRates = DEFAULT_EVENT_RATES,
): QuoteResult {
  assertEventRates(rates);

  const rooflineOptions = eventRooflineOptions(inputs, rates);
  const rooflineChoice = resolveRooflineChoice(inputs, rooflineOptions);

  const lineItems: LineItem[] = [
    ...rooflineLineItem(inputs, rooflineChoice, rooflineOptions),
    ...calculateMiniLights(inputs, rates),
    ...calculateSpritzers(inputs, rates),
    ...calculateBistro(inputs, rates),
    ...calculateBarrelBoxes(inputs, rates),
    ...calculateCustomLineItems(inputs),
    // NOTE (allow-list): wreaths / garland / bows are intentionally NOT priced.
  ];

  const subtotalBeforeDiscount = lineItems.reduce((sum, li) => sum + li.amount, 0);

  // Event totals tail — a simplified computeTotalsTail: manual discount + tax +
  // 50% deposit. NO rush, NO premium takedown, NO early-install (none apply to a
  // temporary event install). Same rounding as the holiday tail.
  let discountAmount = 0;
  if (inputs.discount) {
    const amount =
      Number.isFinite(inputs.discount.amount) && inputs.discount.amount > 0 ? inputs.discount.amount : 0;
    discountAmount =
      inputs.discount.type === 'percentage'
        ? Math.round(subtotalBeforeDiscount * amount)
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
    rooflineChoice,
    rooflineOptions,
    // fullYule intentionally omitted — the "Full Yule" ceiling is a holiday concept.
  };
}
