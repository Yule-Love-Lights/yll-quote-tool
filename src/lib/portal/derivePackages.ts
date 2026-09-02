// Auto-derive the FOUR portal packages from a single QuoteResult (Jason S12).
//
// The pricing engine produces ONE total; the portal shows four tiers, derived
// per-quote from the line items:
//
//   A "Classic Glow"       → Santa's roofline + the cheapest spritzers (then
//                            other extras) needed to clear the $1,000 minimum.
//                            If roofline + spritzers already clears it, only the
//                            spritzers needed are kept (closest to $1,000 above).
//   B "Full Festive"       → Tier A's exact item set with Santa's swapped for
//                            the Gingerbread roofline (front + ridge + sides).
//   C "The Full Yule"      → everything, on the Gingerbread roofline (never
//                            Santa's, never both — they're mutually exclusive).
//   D "Our Recommendation" → the staff-recommended items (#12) + recommended
//                            roofline; populated by applyOurRecommendation once
//                            the recommended flags are attached (loader). Falls
//                            back to an empty "Build Your Own" when staff
//                            recommended nothing.
//
// Per-package totals include the same per-job add-ons as the original quote
// (rush fee, premium takedown, sales tax) so the customer pays the same
// operational charges regardless of tier; only the bundled line-item subtotal
// varies. Totals are the REAL tax-inclusive price of the bundle (no $1,000
// floor — the minimum is a customer-side approval gate, not a silent bump; see
// minimumOrderSubtotal).

import { BUSINESS_RULES, liveDepositRate } from '@/lib/pricing/pricingEngine';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';
// #110 W1-064: shared plain round-to-cents (was copy-pasted here / approve route).
// Aliased to `round2` so call sites are byte-identical.
import { moneyTimesRate, roundMoney as round2 } from '@/lib/money';
import type {
  InstallTiming,
  PackageId,
  PortalCharges,
  PortalLineItem,
  PortalPackage,
  PortalRoofline,
  SelectionCharges,
  SelectionPrice,
} from '@/components/portal/types';

// Stable line-item ids the adapter assigns to the two mutually-exclusive
// roofline options (see buildPortalLineItems). Tier composition keys off these
// directly so Tier 1 is always Santa's and Tier 2 is always Gingerbread,
// independent of which one staff recommended.
const SANTAS_ID = 'roofline-santas';
const GINGERBREAD_ID = 'roofline-gingerbread';

function effectiveTaxRate(_result: QuoteResult): number {
  // Audit fix (g18): return the canonical rate directly instead of
  // back-deriving it as taxAmount / taxableAmount. The engine rounds
  // taxAmount to cents while taxableAmount is exact, so for a tiny taxable
  // base the recovered rate drifts from BUSINESS_RULES.taxRate and that drift
  // gets re-applied to every package/selection total (landing a cent off).
  // No per-quote tax rate exists today; if one ever lands (exemptions/local
  // rates) persist it explicitly on QuoteResult and read it here.
  return BUSINESS_RULES.taxRate;
}

// Per-quote fee CONFIG pulled from the pricing result: the canonical rush +
// premium-takedown amounts (charged when toggled ON) and the default on/off
// state staff set in the builder (a fee defaults on when the staff quote
// already includes it), plus the effective tax rate. Shared by the
// package-card totals here AND the live SelectionContext total (#4/#18).
//
// Event Lighting (#96) fix: events never carry rush/takedown (see
// src/lib/event/packages.ts:10) — the package-derivation call sites already
// force the toggle off (`effectiveCharges(chargesFromResult(result), false,
// false)`), but the LIVE portal (SelectionContext) prices from the
// customer's own toggle state, so a stray/forged toggle could still multiply
// a nonzero `.amount` in. Zero the amounts here too (defense in depth) so
// `effectiveCharges` can never add real money for an event regardless of
// what toggle state reaches it. Detected via `eventRatesSnapshot`'s presence
// (frozen on the result only for event quotes — see QuoteResult) rather than
// threading `serviceType` through every caller of this function.
//
// Permanent Bistro Lighting: same fix, same reasoning — a permanent bistro
// install never carries a rush/takedown fee (it goes up once, no seasonal
// takedown), so `permanentBistroRatesSnapshot`'s presence zeroes the amounts
// here too.
//
// Plain Permanent Lighting (audit WT-06): same fix, same reasoning — a
// permanent (non-bistro) install is also a year-round track install with no
// seasonal takedown, so `permanentRatesSnapshot`'s presence must zero the
// amounts too. This used to be missed here (only isEvent/isPermanentBistro
// were checked), so a regressed isHoliday UI gate could have shown a phantom
// $150 rush/takedown fee on a permanent portal the server never charges.
// #199 F1 fix: `depositPercent` is the quote's LIVE `inputs.depositPercent` —
// pass it whenever the caller has one. `result.depositRate` is a SNAPSHOT
// only a full pricing-engine recompute writes (Calculate / POST /api/quote —
// grep "depositRate:" in pricingEngine.ts/permanent/event/permanentBistro's
// pricing.ts, the only 4 writers). A writer that patches ONLY
// inputs.depositPercent without recomputing (the NCE admin toggle, a rebooked
// clone) would otherwise leave `result.depositRate` silently stale — the
// portal/approve-route bug this fixes. Precedence: the live input wins when
// present (regardless of value — including a deliberate blank, which
// correctly resolves to the BUSINESS_RULES default via effectiveDepositRate);
// only a caller with NO live value to offer (an old test fixture, or a result
// with no matching inputs) falls back to whatever was last actually priced
// into the result, then the BUSINESS_RULES default.
export function chargesFromResult(result: QuoteResult, depositPercent?: number): PortalCharges {
  const isEvent = !!result.eventRatesSnapshot;
  const isPermanent = !!result.permanentRatesSnapshot;
  const isPermanentBistro = !!result.permanentBistroRatesSnapshot;
  const noHolidayFees = isEvent || isPermanent || isPermanentBistro;
  return {
    taxRate: effectiveTaxRate(result),
    rush: {
      amount: noHolidayFees ? 0 : BUSINESS_RULES.rushFeeAmount,
      defaultOn: (typeof result.rushFeeAmount === 'number' ? result.rushFeeAmount : 0) > 0,
    },
    takedown: {
      amount: noHolidayFees ? 0 : BUSINESS_RULES.premiumTakedownFee,
      defaultOn: (typeof result.takedownAmount === 'number' ? result.takedownAmount : 0) > 0,
    },
    // Row 409: this precedence is now liveDepositRate's, so the admin list's
    // deposit chip reads the same rule this charge path prices with instead of
    // carrying its own copy of it.
    depositRate: liveDepositRate(depositPercent, result.depositRate),
  };
}

// Resolve the fee config + a toggle state (customer's, or the staff defaults)
// into the effective SelectionCharges priceSelection consumes: each fee adds
// its canonical amount only when its toggle is on.
export function effectiveCharges(
  charges: PortalCharges,
  rushOn: boolean,
  takedownOn: boolean,
  discountRate = 0,
  discountFlat = 0,
): SelectionCharges {
  return {
    rushFee: rushOn ? charges.rush.amount : 0,
    takedown: takedownOn ? charges.takedown.amount : 0,
    taxRate: charges.taxRate,
    discountRate,
    discountFlat,
    // #177: pass the per-quote deposit rate through unchanged (not toggle-gated
    // — every selection on this quote shares the same rate).
    depositRate: charges.depositRate,
  };
}

// Price a selection subtotal into the full tax-inclusive breakdown: add the
// per-job rush/takedown, then tax, then a 50% deposit. NO $1,000 floor — the
// minimum is enforced as a portal approval gate (see minimumOrderSubtotal), so
// prices always reflect exactly what's selected. An empty selection is
// all-zero (renders as "—"). This is THE single place selection pricing lives:
// packages A/B/C and the custom Build-Your-Own path both call it.
export function priceSelection(
  subtotal: number,
  charges: SelectionCharges,
): SelectionPrice {
  if (subtotal <= 0) {
    return { subtotal: 0, discount: 0, rushFee: 0, takedown: 0, taxable: 0, tax: 0, total: 0, deposit: 0 };
  }

  // Discount off the item subtotal, before the per-job fees + tax: an early-install
  // promo OR a manual % (discountRate) and/or a manual flat $ (discountFlat).
  // Capped so it never exceeds the subtotal. 0 when no discount applies.
  const discount = Math.min(
    subtotal,
    round2(moneyTimesRate(subtotal, charges.discountRate ?? 0) + (charges.discountFlat ?? 0)),
  );
  const taxable = subtotal - discount + charges.rushFee + charges.takedown;
  const tax = moneyTimesRate(taxable, charges.taxRate);
  const total = round2(taxable + tax);
  // #177: the quote's own deposit rate when set, else the BUSINESS_RULES default.
  const deposit = moneyTimesRate(total, charges.depositRate ?? BUSINESS_RULES.depositPercentage);
  return {
    subtotal,
    discount,
    rushFee: charges.rushFee,
    takedown: charges.takedown,
    taxable,
    tax,
    total,
    deposit,
  };
}

// The pre-tax subtotal the customer's selection must reach before they can
// approve on the portal ($1,000 for holiday, or the passed `minimum`) — OR 0
// (waived) when the whole quote's items sum below the minimum, i.e. staff
// intentionally sent a sub-minimum quote and gating would make it
// un-approvable. (#18 — minimum is a gate, not a floor.) `minimum` defaults to
// the holiday BUSINESS_RULES amount so every existing caller is byte-identical;
// #88 permanent quotes pass the frozen rate-snapshot's minimumJobAmount instead.
export function minimumOrderSubtotal(
  lineItems: PortalLineItem[],
  minimum: number = BUSINESS_RULES.minimumQuoteAmount,
): number {
  const sum = lineItems.reduce((s, li) => s + li.price, 0);
  return sum >= minimum ? minimum : 0;
}

// Evaluate the portal approval gate for a priced selection (#18 gate, #47, #40).
// The minimum is measured against the PRE-TAX, PRE-DISCOUNT taxable total — the
// item subtotal PLUS the rush + premium-takedown fees (#47), but BEFORE any
// early-install promo discount (#40) — so a fee pushes a borderline order over
// the line, while a promo discount never re-blocks an order that already
// qualified. Still requires a non-empty selection: a fees-only "order" with no
// items can never meet the minimum (priceSelection zeroes everything when the
// item subtotal is 0). Returns whether the gate is met and the dollars still
// needed (0 once met).
export function orderMinimumStatus(
  price: SelectionPrice,
  minimum: number,
): { meetsMinimum: boolean; amountToMinimum: number } {
  const basis = price.subtotal + price.rushFee + price.takedown;
  const meetsMinimum = price.subtotal > 0 && basis >= minimum;
  const amountToMinimum = Math.max(0, minimum - basis);
  return { meetsMinimum, amountToMinimum };
}

// Resolve the customer's early-install timing choice (#40) into a discount rate
// off the order subtotal. 'none' (or an unknown value) → 0.
export function installDiscountRate(timing: InstallTiming): number {
  if (timing === 'september') return BUSINESS_RULES.earlyInstallDiscounts.september;
  if (timing === 'october') return BUSINESS_RULES.earlyInstallDiscounts.october;
  return 0;
}

function totalsFor(
  itemIds: string[],
  lineItems: PortalLineItem[],
  charges: SelectionCharges,
): { total: number; deposit: number } {
  const idSet = new Set(itemIds);
  const subtotal = lineItems.reduce(
    (sum, li) => (idSet.has(li.id) ? sum + li.price : sum),
    0,
  );
  return priceSelection(subtotal, charges);
}

// Resolve the two roofline option ids for this quote. Prefers the stable ids the
// adapter assigns (Santa's / Gingerbread). Falls back, for legacy rows with no
// roofline group, to the single roofline-kind line item so the tiers still build.
function resolveRooflineIds(
  lineItems: PortalLineItem[],
  roofline?: PortalRoofline,
): { santasId: string | null; gingerId: string | null } {
  if (roofline) {
    const has = (id: string) =>
      roofline.itemIds.includes(id) && lineItems.some((li) => li.id === id);
    return {
      santasId: has(SANTAS_ID) ? SANTAS_ID : null,
      gingerId: has(GINGERBREAD_ID) ? GINGERBREAD_ID : null,
    };
  }
  const legacy = lineItems.find((li) => li.kind === 'roofline');
  return { santasId: legacy?.id ?? null, gingerId: null };
}

// Tier 1 "Classic Glow": the chosen roofline plus the cheapest spritzers — then
// other extras — needed to clear the $1,000 minimum. If the roofline + spritzers
// already clear it, only the spritzers needed are kept (so the tier lands as
// close to $1,000 from above as possible). If even everything can't reach
// $1,000, all of it is included (the gate auto-waives for sub-$1,000 quotes).
function buildEntryTier(
  lineItems: PortalLineItem[],
  rooflineId: string | null,
  isRooflineOption: (id: string) => boolean,
  threshold: number,
): string[] {
  const selected: string[] = [];
  let subtotal = 0;
  if (rooflineId) {
    const roof = lineItems.find((li) => li.id === rooflineId);
    if (roof) {
      selected.push(roof.id);
      subtotal += roof.price;
    }
  }
  if (subtotal >= threshold) return selected; // roofline alone clears the minimum

  const byPriceAsc = (a: PortalLineItem, b: PortalLineItem) => a.price - b.price;
  const spritzers = lineItems
    .filter((li) => !isRooflineOption(li.id) && li.kind === 'spritzer')
    .sort(byPriceAsc);
  const extras = lineItems
    .filter((li) => !isRooflineOption(li.id) && li.kind !== 'spritzer')
    .sort(byPriceAsc);
  // Spritzers first (the Classic Glow content), then other extras only if
  // spritzers can't get the tier to $1,000. Cheapest-first keeps the bundle to
  // the fewest, smallest add-ons that clear the gate — not a strict minimal-
  // dollar overshoot (which would differ only when add-on prices vary).
  for (const li of [...spritzers, ...extras]) {
    selected.push(li.id);
    subtotal += li.price;
    if (subtotal >= threshold) break;
  }
  return selected;
}

export function derivePackages(
  lineItems: PortalLineItem[],
  result: QuoteResult,
  roofline?: PortalRoofline,
  // #199 F1: threaded straight to chargesFromResult — see its own comment.
  depositPercent?: number,
): PortalPackage[] {
  const { santasId, gingerId } = resolveRooflineIds(lineItems, roofline);
  const isRooflineOption = (id: string) => id === santasId || id === gingerId;
  const entryRooflineId = santasId ?? gingerId; // Tier 1 — Santa's preferred
  const fullRooflineId = gingerId ?? santasId; // Tier 2/3 — Gingerbread preferred
  const threshold = BUSINESS_RULES.minimumQuoteAmount;

  // Tier 1 — Santa's + the cheapest spritzers/extras needed to clear $1,000.
  const idsForTierA = buildEntryTier(lineItems, entryRooflineId, isRooflineOption, threshold);

  // Tier 2 — Tier 1's exact set with Santa's swapped for Gingerbread (Jason S12).
  // When there's no distinct Gingerbread option, Tier 2 equals Tier 1.
  const idsForTierB =
    entryRooflineId && fullRooflineId && entryRooflineId !== fullRooflineId
      ? idsForTierA.map((id) => (id === entryRooflineId ? fullRooflineId : id))
      : idsForTierA;

  // Tier 3 — everything, on the Gingerbread roofline. Drop the Santa's option
  // only when Gingerbread exists, so the tier never selects two rooflines.
  const excludeRooflineId = gingerId ? santasId : null;
  const idsForTierC = lineItems
    .filter((li) => li.id !== excludeRooflineId)
    .map((li) => li.id);

  // Package cards reflect the STAFF quote, so price them with the staff-default
  // rush/takedown toggle state. The live portal total (SelectionContext)
  // re-prices with the customer's toggles.
  const config = chargesFromResult(result, depositPercent);
  const charges = effectiveCharges(config, config.rush.defaultOn, config.takedown.defaultOn);
  const a = totalsFor(idsForTierA, lineItems, charges);
  const b = totalsFor(idsForTierB, lineItems, charges);
  const c = totalsFor(idsForTierC, lineItems, charges);

  // Tier 2 only exists when there's a distinct Gingerbread roofline to upgrade
  // to. On a Santa's-only (or roofline-less) quote it would byte-duplicate Tier 1
  // while its name promises a Gingerbread upgrade — so we omit it and the portal
  // renumbers the visible tiers (Jason S12). Common quotes carry both rooflines.
  const hasDistinctGingerbread =
    !!entryRooflineId && !!fullRooflineId && entryRooflineId !== fullRooflineId;

  const tierA: PortalPackage = {
    id: 'A',
    name: 'Classic Glow',
    tagline: "Santa's roofline + the essentials. Clean, simple, elegant.",
    total: a.total,
    deposit: a.deposit,
    includedItemIds: idsForTierA,
  };
  const tierC: PortalPackage = {
    id: 'C',
    name: 'The Full Yule',
    tagline: 'Everything — Gingerbread roofline, trees, wreaths, garland and more.',
    total: c.total,
    deposit: c.deposit,
    includedItemIds: idsForTierC,
  };
  const tierD: PortalPackage = {
    id: 'D',
    name: 'Build Your Own',
    tagline: 'Custom — toggle anything.',
    total: 0, // populated by applyOurRecommendation when staff recommended items
    deposit: 0,
    includedItemIds: [],
  };

  if (!hasDistinctGingerbread) return [tierA, tierC, tierD];

  return [
    tierA,
    {
      id: 'B',
      name: 'Full Festive',
      tagline: 'Gingerbread roofline + the essentials. The fuller look.',
      total: b.total,
      deposit: b.deposit,
      includedItemIds: idsForTierB,
    },
    tierC,
    tierD,
  ];
}

// #155 — the single LEGACY REBOOK package: a quote migrated from last year's
// Jobber data shows exactly ONE tier, "Last Year's Design", bundling every
// line item on the quote (typically the one bundled custom item the migration
// created) — no A/B/C ladder and no empty "Build Your Own" slot (the hero's
// custom card IS the empty holiday D, so a single non-empty D removes it).
// Priced with the staff-default rush/takedown toggle state via the SAME
// mechanism as the holiday tiers (chargesFromResult + effectiveCharges +
// totalsFor), so the money math is identical; the live tile price still comes
// from SelectionContext (currentTotal), so the customer's fee toggles — live
// upsells on a legacy quote — reprice it as usual. Mirrors derivePackagesEvent's
// roofline guard: if both mutually-exclusive roofline options are present,
// bundle only Gingerbread (never both — that would double-bill the front).
// Positive gate at the call site (adapter): only legacy_rebook === true rows
// ever reach this.
export function derivePackagesLegacyRebook(
  lineItems: PortalLineItem[],
  result: QuoteResult,
  // #199 F1: threaded straight to chargesFromResult — see its own comment.
  depositPercent?: number,
): PortalPackage[] {
  if (lineItems.length === 0) return [];
  const excludeRooflineId = lineItems.some((li) => li.id === GINGERBREAD_ID)
    ? SANTAS_ID
    : null;
  const includedIds = lineItems
    .filter((li) => li.id !== excludeRooflineId)
    .map((li) => li.id);
  const config = chargesFromResult(result, depositPercent);
  const charges = effectiveCharges(config, config.rush.defaultOn, config.takedown.defaultOn);
  const { total, deposit } = totalsFor(includedIds, lineItems, charges);
  return [
    {
      id: 'D',
      // #184 — the What's Included heading no longer prepends "Your " (it
      // renders the bare name), so this name is free to read naturally either
      // way; kept plain regardless.
      name: "Last Year's Design",
      tagline: 'Everything from last year.',
      total,
      deposit,
      recommended: true,
      includedItemIds: includedIds,
    },
  ];
}

// Populate the 4th "Our Recommendation" (D) card from the staff-recommended line
// items (#12). Runs in the loader AFTER attachSceneLinks, because design-driven
// `recommended` flags are only attached there; it also picks up custom-item
// recommendations the adapter sets. When nothing is recommended, D stays the
// empty "Build Your Own" card (Jason S12). The recommended roofline is always
// unioned in so the customer never lands without a roofline.
export function applyOurRecommendation(
  packages: PortalPackage[],
  lineItems: PortalLineItem[],
  roofline: PortalRoofline | undefined,
  charges: PortalCharges,
): PortalPackage[] {
  const recIds = lineItems.filter((li) => li.recommended).map((li) => li.id);
  if (recIds.length === 0) return packages;

  const ids = Array.from(
    new Set(
      roofline?.recommendedItemId ? [...recIds, roofline.recommendedItemId] : recIds,
    ),
  );
  const effective = effectiveCharges(charges, charges.rush.defaultOn, charges.takedown.defaultOn);
  const { total, deposit } = totalsFor(ids, lineItems, effective);

  return packages.map((p) =>
    p.id === 'D'
      ? {
          ...p,
          name: 'Our Recommendation',
          tagline: 'Hand-picked by our team for your home.',
          total,
          deposit,
          includedItemIds: ids,
          recommended: true,
        }
      : p,
  );
}

// Pick a sensible initial package for the portal's DEFAULT (fallback) selection,
// used only when staff recommended nothing (otherwise the portal opens on the
// "Our Recommendation" set — see applyOurRecommendation + the portal page).
//
// Preference order is Tier 1 → Tier 2 → Tier 3 (A → B → C), skipping empty
// packages, so a no-recommendation quote defaults to Classic Glow (Jason S12).
// Tier 1 is built to clear the $1,000 minimum, so it normally wins outright; the
// gate-aware fallback stays a safety net: when the gate is active
// (minimumSubtotal > 0) we pick the first package in preference order whose
// PRE-TAX subtotal clears it, and if none clears (defensive) the largest. When
// the gate is waived/unknown (minimumSubtotal ≤ 0) we take the first available.
export function pickInitialPackageId(
  packages: PortalPackage[],
  lineItems: PortalLineItem[] = [],
  minimumSubtotal = 0,
): PackageId {
  const priceById = new Map(lineItems.map((li) => [li.id, li.price]));
  const subtotalOf = (p: PortalPackage) =>
    p.includedItemIds.reduce((s, id) => s + (priceById.get(id) ?? 0), 0);

  // A LOCKED tile is never a valid opening selection. Permanent now KEEPS a
  // below-minimum tile (marked belowMinimum) where it used to be filtered out
  // of this array entirely, so without this the "nothing clears the gate, take
  // the biggest of A/B/C" branch below could hand back a tile that renders
  // dimmed, disabled and captioned "Add $X" — selected on arrival, with
  // Approve refused and no cue pointing at the tier that would work. Dropping
  // locked tiles here restores the old contract (this function only ever sees
  // approvable candidates) and falls through to 'D', which on permanent is the
  // Whole Home bundle and on holiday is the recommendation/custom slot.
  // Inert for every other service type: only permanent ever sets belowMinimum.
  const candidates = (['A', 'B', 'C'] as PackageId[])
    .map((id) => packages.find((p) => p.id === id))
    .filter((p): p is PortalPackage => !!p && p.total > 0 && p.belowMinimum !== true);
  if (candidates.length === 0) return 'D';

  // No active gate → first available in preference order (Tier-1-preferred).
  if (minimumSubtotal <= 0) return candidates[0].id;

  // Active gate → the first (in preference order) that clears the minimum, so
  // the customer can approve as-is; else the largest subtotal (closest from below).
  const clearing = candidates.find((p) => subtotalOf(p) >= minimumSubtotal);
  if (clearing) return clearing.id;
  return candidates.reduce((best, p) => (subtotalOf(p) > subtotalOf(best) ? p : best)).id;
}

// #238 (review fix): whether a package tile is the genuinely-EMPTY "Build
// Your Own" slot the customer still needs to fill — true only for a package
// D with no bundled items yet. Package D means something else in every other
// derive path: a legacy rebook's single PRE-FILLED tile (derivePackagesLegacyRebook,
// already selected on load), permanent's populated "Whole Home" bundle
// (derivePackagesPermanent), or event/bistro's single populated package. This
// checks real emptiness (includedItemIds) instead of proxying off the id, so
// it doesn't need updating when a new vertical adds its own D meaning.
export function isEmptyCustomSlot(p: PortalPackage): boolean {
  return p.id === 'D' && p.includedItemIds.length === 0;
}
