// Yule Love Lights — Pricing Engine
// Pure TypeScript: takes a house description, returns a price.

import type { PermanentQuoteFields, PermanentRates } from '@/lib/permanent/types';
import type { EventRates, EventInputFields } from '@/lib/event/types';
import type { PermanentBistroRates, PermanentBistroInputFields } from '@/lib/permanentBistro/types';
import { moneyTimesRate, roundMoney } from '@/lib/money';

// ─────────────────────────────────────────────────────────
// Business rules — the ONLY place adjustable numbers live
// ─────────────────────────────────────────────────────────

export const BUSINESS_RULES = {
  minimumQuoteAmount: 1000,
  rushFeeAmount: 150,
  premiumTakedownFee: 150,
  taxRate: 0.0875,
  depositPercentage: 0.50,

  // Early-install promo discounts (#40) — a customer-selected percentage off
  // the order subtotal for letting us install roof lights in the off-peak
  // window: September (mid–late) or anytime in October. Mutually exclusive
  // with the rush-install fee.
  earlyInstallDiscounts: {
    september: 0.15,
    october: 0.10,
  },

  rooflineRates: {
    easy: 8,
    medium: 10,
    hard: 12,
  },



  // The difficulty a roofline (Santa's front line and Gingerbread ridge+sides)
  // STARTS at, everywhere it can start: a new quote's form, and the customer's
  // self-serve estimate. Easy = $8/ft.
  //
  // Jason, 2026-08-27: an analysis used to be able to move this on its own —
  // the AI returns its own difficulty read and both the builder and the
  // self-serve estimator adopted it, so the same house could quote at $10/ft
  // just because a photo was re-analyzed. Roofline difficulty is now a purely
  // MANUAL decision: nothing but a staff member picking a value in the
  // dropdown changes it. Exported so the three places that need a starting
  // value cannot drift into disagreeing about what it is.
  //
  // Used for the read-side fallbacks too (quoteForm's `?? ...`, QuoteBuilder's
  // OVERRIDE_ID_TO_RATE). The first draft of this change deliberately left those
  // at 'medium', reasoning that they describe legacy quotes already PRICED at
  // medium and that moving them would re-price history on reopen. Measured
  // instead of argued: 187 of 187 holiday quotes in production store both
  // difficulty keys, so that fallback is unreachable for real data and the
  // population it was protecting does not exist. One value everywhere beats a
  // second one guarding nothing.
  rooflineDefaultDifficulty: 'easy' as const,
  // Stake Lighting (independent staked ground runs) — its OWN per-ft rate table,
  // distinct from the roofline rates above (Naldo, 2026-06-26).
  stakeLightingRates: {
    easy: 6,
    medium: 7,
    hard: 8,
  },

  miniLightRates: {
    canopy: 35,   // circles around plant — bushes, small trees, columns
    trunk: 45,    // up trunks and branches — larger trees
  },

  spritzerRates: {
    '16': 85,
    '24': 95,
    '32': 105,
  },

  // Tier keys are internal codes: `bow` = NON-DECORATED (lights; a bow is
  // included in the price), `fullDecor` = DECORATED (lights + ornaments/ribbon).
  // The old `labor` tier was retired (#17) — it was imported from an old price
  // sheet and is not a real product. Display labels live in TIER_LABELS.
  wreathPrices: {
    '24noble': { bow: 200,  fullDecor: 275 },
    '30noble': { bow: 285,  fullDecor: 355 },
    '36noble': { bow: 315,  fullDecor: 400 },
    '48noble': { bow: 450,  fullDecor: 705 },
    '60noble': { bow: 885,  fullDecor: 1130 },
    '72noble': { bow: 1149, fullDecor: 1455 },
  },

  // Same tier convention as wreaths (`bow` = Non-Decorated, `fullDecor` =
  // Decorated; `labor` retired in #17). Garland does NOT come with a bow —
  // customers add bows separately (priced via standaloneBowPrice).
  garlandPrices: {
    noble: {
      '9ft':   { bow: 162, fullDecor: 250 },
      '4.5ft': { bow: 135, fullDecor: 210 },
    },
  },

  // Standalone bow — a bow sold on its own, not on a wreath/garland (#28).
  // Flat $35 per bow (Naldo, #17).
  standaloneBowPrice: 35,

  // P4P labor-planning placeholders (2026-08-07): clearly fake seed numbers for
  // shadow-mode budgeted-hours stamping only. These are NOT Jason's real
  // production rates yet; replace them after the follow-up called out in
  // docs/context/project_p4p_labor.md A7 item 2.
  laborPlanningPlaceholders: {
    rooflineFeetPerHour: {
      easy: 10,
      medium: 7,
      hard: 5,
    },
    stakeLightingFeetPerHour: {
      easy: 12,
      medium: 9,
      hard: 6,
    },
    // Permanent side footage has no stored difficulty tier, so v1 uses one flat
    // placeholder until Jason's real rate session lands.
    permanentLightingFeetPerHour: 7,
    perItemMinutes: {
      miniLights: 20,
      spritzers: 20,
      wreaths: 20,
      garland: 20,
      bistroRuns: 20,
    },
    defaultUnmappedMinutes: 30,
    // Flat v1 labor-share dial from the Phase 1 plan's shadow-mode starting point.
    laborRevenuePercentage: 0.33,
  },
} as const;

// ─────────────────────────────────────────────────────────
// Input types — what a quote needs to know about the house
// ─────────────────────────────────────────────────────────

export type RooflineDifficulty = 'easy' | 'medium' | 'hard';

// #104: the per-unit input types carry an OPTIONAL stable line id + the scene
// item ids they cover, threaded from the design projection (applyProjectionToInputs)
// so each priced LineItem can be identified by IDENTITY, not list position. Optional
// for back-compat (manual/legacy quotes have no design) and additive — nothing reads
// them yet in this PR. See LineItem + the projectScene thread.
type LineIdentity = {
  /** Stable per-line id (e.g. `mini-<sceneItemId>`), for override keying + scene links. */
  id?: string;
  /** The design scene item id(s) this line controls (for hide/toggle + scene links). */
  sceneItemIds?: string[];
};

// Canonical mini-light surface types. The runtime list is the single source of
// truth: the MiniLightItem['type'] union is DERIVED from it, so a validator that
// reads MINI_LIGHT_TYPES can never drift narrow of the type again (the W1-002 /
// #R18-006 'stale narrow duplicate' lesson — 'curtain' was in the type union but
// missing from the route's hand-written Set). 'curtain' bills at the railing rate
// (#100); see NO_WRAP_STYLE_TYPES below.
export const MINI_LIGHT_TYPES = ['tree', 'bush', 'column', 'railing', 'curtain'] as const;
export type MiniLightType = (typeof MINI_LIGHT_TYPES)[number];

export type MiniLightItem = LineIdentity & {
  type: MiniLightType;
  wrapStyle: 'canopy' | 'trunk';
  stringCount: number;
};

export type SpritzerSize = '16' | '24' | '32';
export type Spritzer = LineIdentity & {
  size: SpritzerSize;
  quantity: number;
};

export type WreathSize =
  | '24noble'
  | '30noble'
  | '36noble'
  | '48noble'
  | '60noble'
  | '72noble';

// `bow` = Non-Decorated, `fullDecor` = Decorated (#17; the old `labor` tier was retired).
export type DecorTier = 'bow' | 'fullDecor';

export type Wreath = LineIdentity & {
  size: WreathSize;
  tier: DecorTier;
  quantity: number;
};

export type GarlandLength = '4.5ft' | '9ft';
export type GarlandType = 'noble';

export type GarlandItem = LineIdentity & {
  length: GarlandLength;
  type: GarlandType;
  tier: DecorTier;
  quantity: number;
};

// Standalone bow (#28) — bills flat per bow (no size/tier; the drawn size on a
// design is visual-only, like every per-unit item).
export type BowLineInput = LineIdentity & {
  quantity: number;
};

export type Takedown = 'included' | 'premium';

export type Discount = {
  type: 'percentage' | 'flat';
  amount: number;
};

// Custom / manual line item (Option-2 escape hatch, #27): a staff-typed name +
// unit price + optional quantity (+ optional description) for off-design items
// the design can't represent (~5% of niche quotes). NOT tied to the scene — it's
// an ordinary line item on the quote + portal. Priced exactly as entered (no
// price-book lookup): line amount = amount × quantity.
export type CustomLineItem = {
  // #104: optional stable id so a per-quote price override binds to this custom
  // row by identity (not list position). Generated once in the builder; no scene
  // link (custom items aren't on the design).
  id?: string;
  label: string;
  amount: number; // unit price
  quantity?: number; // default 1
  description?: string;
  // Staff-set "advised for this home" flag (#12). Pre-selects this custom item
  // on the customer portal + shows a "Recommended" label. Default false.
  // Pricing ignores it; it only rides along to the portal via the adapter.
  recommended?: boolean;
  // PERMANENT quotes only. Staff chose to bundle this line into every surface
  // package (Front of Home, Front & Sides, Back of Home) instead of the
  // default, which puts a custom line in the Whole Home bundle alone. A
  // customer who picks a single surface then still gets, and is still billed
  // for, this work. Pricing ignores it exactly as it ignores `recommended`; it
  // rides to the portal via the adapter. Default false, so every existing
  // quote's packages and prices are untouched.
  allTiers?: boolean;
};

// Santa's (front roofline) and Gingerbread (front + ridge + sides) are
// MUTUALLY EXCLUSIVE — the customer picks one on the portal (or none). #17.
export type RooflineChoice = 'santas' | 'gingerbread' | 'none';

// Early-install promo timing (#40). 'september' = 15% off, 'october' = 10% off
// the item subtotal; 'none'/undefined = standard install, no discount.
export type EarlyInstallTiming = 'none' | 'september' | 'october';

export interface QuoteInputs {
  // Front roofline footage (the "red" line) — Santa's on its own, and the
  // front component of Gingerbread.
  santasFootage: number;
  santasDifficulty: RooflineDifficulty;
  // Ridge + sides footage (the "blue" line). Added on top of the front to
  // form Gingerbread; never billed on its own (Gingerbread always includes
  // the front). NOTE: historically ridge-only — the AI/builder gain
  // side-gutter capture in a later #17 phase.
  gingerbreadFootage: number;
  gingerbreadDifficulty: RooflineDifficulty;
  winterWonderlandFootage: number;
  winterWonderlandDifficulty: RooflineDifficulty;
  // Stake Lighting (staked ground runs) — independent of the roofline choice,
  // billed at its own $6/$7/$8 rates. Parallel sibling of Winter Wonderland.
  stakeLightingFootage: number;
  stakeLightingDifficulty: RooflineDifficulty;
  // Per-quote custom $/ft overrides (#102). When a positive finite number, the
  // engine prices that item-type at footage × this rate, IGNORING the difficulty
  // table (rooflineRates / stakeLightingRates); absent or ≤ 0 falls back to the
  // difficulty rate. Per item-type, per-quote — does NOT change the global rates.
  // Optional for back-compat: quotes priced before this field stay valid.
  santasCustomRate?: number;
  gingerbreadCustomRate?: number;
  winterWonderlandCustomRate?: number;
  stakeLightingCustomRate?: number;
  // The roofline the quote defaults to (operator's pick). When omitted the
  // engine infers it from footage (Gingerbread if there's ridge/sides, else
  // Santa's, else none); the portal can switch it — see QuoteResult.rooflineOptions.
  rooflineChoice?: RooflineChoice;

  miniLightItems: MiniLightItem[];
  spritzers: Spritzer[];
  wreaths: Wreath[];
  garland: GarlandItem[];
  // Standalone bows (#28). Optional for back-compat: quotes priced before this
  // field stay valid.
  bows?: BowLineInput[];
  // Custom / manual line items (#27 — the Option-2 escape hatch). Optional for
  // back-compat: quotes priced before this field stay valid.
  customLineItems?: CustomLineItem[];

  takedown: Takedown;
  rushFee: boolean;
  discount?: Discount;
  /** Staff override (#59): when true, the portal's $1,000 approval gate is
   *  waived (minimumOrderSubtotal → 0) so the customer can approve a selection
   *  under $1,000 even on a quote whose items total ≥ $1,000. NOT a pricing
   *  input — the engine ignores it; it rides the stored `inputs` jsonb. */
  waiveMinimum?: boolean;
  /** Staff override: when true, the portal shows NO free-spritzer thank you on
   *  this quote, whatever the line-item labels say. Same shape and reasoning as
   *  waiveMinimum above — NOT a pricing input, the engine ignores it, it rides
   *  the stored `inputs` jsonb.
   *
   *  It exists because the count is read out of staff free text (see
   *  src/lib/portal/freeSpritzers.ts), and free text can be wrong in ways no
   *  parser should try to guess at: a promise withdrawn after the label was
   *  typed, a phrasing that means something else, a gift already handled
   *  another way. Staff need a way to say "not on this one" that does not
   *  require rewriting a label the customer may have already read. */
  suppressFreeSpritzerNotice?: boolean;
  // Early-install promo (#40). When 'september'/'october', a percentage discount
  // (BUSINESS_RULES.earlyInstallDiscounts) comes off the item subtotal and the
  // rush-install fee is suppressed (mutually exclusive). Absent/'none' = no promo.
  installTiming?: EarlyInstallTiming;
  // #104: per-quote line-item TOTAL overrides, keyed by the STABLE line id
  // (`mini-<sceneItemId>`, `roofline-santas`/`-gingerbread`, `winter-wonderland`,
  // `stake-lighting`, or a custom id). Sets a line's billed total for THIS quote
  // only (e.g. free spritzers = $0) — global rates are untouched. Keyed by identity
  // so it survives re-Calculate + design reorders; a key whose line no longer
  // exists is simply ignored. `reason` is an optional staff note (not priced).
  // Optional/additive — absent means no overrides.
  lineItemPriceOverrides?: Record<string, { amount: number; reason?: string }>;
  // item-numbering-rename: per-quote staff RENAME of a per-unit line's default
  // label, keyed by the SAME stable line id as lineItemPriceOverrides above
  // (`mini-<sceneItemId>` etc, #104) — only mini/spritzer/wreath/garland/bow
  // lines carry one; the builder's rename control only ever writes those
  // prefixes. Applied in two places: (1) here in calculateQuote, an item with
  // an ACTIVE override drops OUT of the duplicate-numbering pool (see
  // numberDuplicateLabels) so renaming one of two identically-labeled items
  // un-numbers the survivor; (2) resolveLineItemLabel (exported below), used
  // by every DISPLAY surface (builder breakdown, portal adapter, PDF, the
  // admin quote page) to swap in the override text. The engine's own
  // LineItem.label NEVER carries the override text itself — only the
  // numbered/default text — so the portal adapter's parseLineItem (label-text
  // kind classification) can never be confused by a staff-typed freeform
  // name. A blank/whitespace-only value means "no override" (revert to the
  // auto label), same as omitting the key. Optional/additive — absent means
  // no renames.
  labelOverrides?: Record<string, string>;
  // Staff "recommend to the customer" flags (#12) for the measurement-driven
  // Winter Wonderland + Stake lines. Per-unit items carry `recommended` on the
  // scene item, but WW/Stake are typed-footage lines with no scene item when
  // drawn manually — so the flag rides the quote inputs. NOT priced (like
  // customLineItem.recommended); the adapter surfaces it to the portal.
  winterWonderlandRecommended?: boolean;
  stakeLightingRecommended?: boolean;
  // Permanent Lighting vertical (#88). Present ONLY when the quote's service_type
  // is 'permanent'; the holiday engine (calculateQuote) never reads it. The
  // permanent engine (calculatePermanentQuote in lib/permanent/pricing.ts) prices
  // off this block. Optional/additive — holiday quotes are unaffected.
  permanent?: PermanentQuoteFields;
  // Event Lighting vertical (#96). Present ONLY when service_type is 'event'.
  // The event engine (calculateEventQuote in lib/event/pricing.ts) reads bistro +
  // barrel/box supports; the dates are portal metadata. Holiday/permanent ignore it.
  event?: EventInputFields;
  // Referral program redemption (#41 PR 2): PROVENANCE ONLY for a referral-
  // credit discount application — which rows were spent and the amount. The
  // engine does NOT read this field; the actual discount math runs through
  // the existing `discount` field above (type:'flat', amount = min(balance,
  // subtotal), set by the quote builder alongside this one). Carried here
  // purely so the snapshot freeze (the saved inputs jsonb) remembers which
  // referral rows were consumed and for how much, for support/audit lookups.
  // Optional/additive — absent means no referral credit was applied.
  referralCredit?: { amount: number; consumedRowIds: string[] };
  // Permanent Bistro Lighting vertical. Present ONLY when service_type is
  // 'permanent_bistro'. The permanent-bistro engine (calculatePermanentBistro in
  // lib/permanentBistro/pricing.ts) reads bistro runs + poles. Every other
  // vertical ignores it.
  permanentBistro?: PermanentBistroInputFields;
  // Per-quote deposit override (#177): a staff-set integer percent (1-100) of
  // the total, due at approval. Optional/additive — absent, non-integer, or
  // outside [1,100] falls back to BUSINESS_RULES.depositPercentage (50%), so
  // every existing quote stays byte-identical. See effectiveDepositRate.
  depositPercent?: number;
}

// ─────────────────────────────────────────────────────────
// Output types — what the customer portal displays
// ─────────────────────────────────────────────────────────

export type LineItem = {
  label: string;
  amount: number;
  // #104: optional stable line id + the scene item ids this line controls, carried
  // from the input (per-unit lines) or a descriptive constant (roofline/WW/stake).
  // Additive — the adapter/portal still key off position in this PR; a later PR
  // switches scene-links + the per-quote price override to key off `id`.
  id?: string;
  sceneItemIds?: string[];
};

// One mutually-exclusive roofline option (Santa's or Gingerbread): the total
// footage it covers and its dollar amount.
export type RooflineOption = { footage: number; amount: number };

// #107: the "Full Yule" ceiling — the quote priced with the MOST-EXPENSIVE
// roofline (Gingerbread if present, else Santa's) instead of the selected one.
// Additive/display-only: the billed figures on QuoteResult stay on the selected
// roofline; this mirrors the same discount/fee/tax/deposit math on the ceiling
// subtotal so the builder headline can show the sticker (= "The Full Yule" tier).
export type FullYuleTotals = {
  subtotalBeforeDiscount: number;
  discountAmount: number;
  earlyInstallDiscountAmount: number;
  subtotalAfterDiscount: number;
  rushFeeAmount: number;
  takedownAmount: number;
  taxableAmount: number;
  taxAmount: number;
  total: number;
  depositAmount: number;
  balanceDue: number;
};

export interface QuoteResult {
  lineItems: LineItem[];
  subtotalBeforeDiscount: number;
  discountAmount: number;
  // Early-install promo discount (#40), in dollars; 0 when no install timing set.
  earlyInstallDiscountAmount: number;
  subtotalAfterDiscount: number;
  minimumApplied: boolean;
  rushFeeAmount: number;
  takedownAmount: number;
  taxableAmount: number;
  taxAmount: number;
  total: number;
  depositAmount: number;
  balanceDue: number;
  // The active roofline choice this result was priced with, plus BOTH
  // mutually-exclusive options' prices so the portal can offer the switch
  // (#17). A `null` option means there's no footage for that option.
  rooflineChoice: RooflineChoice;
  rooflineOptions: {
    santas: RooflineOption | null;
    gingerbread: RooflineOption | null;
  };
  // #107: the ceiling figures (all items + the max roofline). Optional so quote
  // results saved before #107 read back without it — consumers fall back to the
  // selected figures (`fullYule?.total ?? total`).
  fullYule?: FullYuleTotals;
  // Permanent Lighting (#88): the FULL rate table this result was priced with,
  // frozen at calc time. Approve + amend re-price from THIS snapshot, never live
  // app_settings, so a Settings rate change can't re-price an outstanding quote
  // (the rate-drift guard). Present only on permanent quotes.
  permanentRatesSnapshot?: PermanentRates;
  // Event Lighting (#96): the event rate table frozen at calc time — the same
  // rate-drift guard as permanent (approve/amend re-price from this, not live
  // settings). Present only on event quotes.
  eventRatesSnapshot?: EventRates;
  // Permanent Bistro Lighting: the rate table frozen at calc time — the same
  // rate-drift guard as permanent/event. Present only on permanent-bistro quotes.
  permanentBistroRatesSnapshot?: PermanentBistroRates;
  // #177: the effective deposit rate (0-1) this result was priced with — the
  // staff override when set, else BUSINESS_RULES.depositPercentage. Frozen at
  // calc time (mirrors the *RatesSnapshot pattern) so the portal's package/
  // selection pricing (chargesFromResult) reads the SAME rate the engine
  // billed, never a live re-derivation. Optional: quotes priced before this
  // field default to BUSINESS_RULES.depositPercentage when absent.
  depositRate?: number;
}

// ─────────────────────────────────────────────────────────
// Roofline calculation — Santa's vs Gingerbread are MUTUALLY EXCLUSIVE
// (#17). Santa's = front only; Gingerbread = front + ridge + sides. Winter
// Wonderland (C9 custom runs) is independent and can accompany either.
// ─────────────────────────────────────────────────────────

// Defensive: a footage or quantity must be a finite, positive number before it
// is multiplied by a rate. Anything else (NaN/Infinity/negative — e.g. from a
// malformed scene projection) contributes 0 so a quote is never NaN, Infinity,
// or negative. Mirrors the bow/custom-item guards below.
function units(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// The effective $/ft for a roofline-family item: a per-quote custom override
// (#102) when it's a positive finite number, else the difficulty-table rate.
// A non-positive / NaN / Infinity custom rate falls back to the table so a
// malformed override can never zero out or NaN a line.
function resolveRate(
  table: Record<RooflineDifficulty, number>,
  difficulty: RooflineDifficulty,
  customRate?: number,
): number {
  return Number.isFinite(customRate) && (customRate as number) > 0
    ? (customRate as number)
    : table[difficulty];
}

// The parenthetical on a roofline-family line label: the custom $/ft when an
// override is active (#102), else the difficulty word (unchanged behavior).
function rateLabel(difficulty: RooflineDifficulty, customRate?: number): string {
  return Number.isFinite(customRate) && (customRate as number) > 0
    ? `$${customRate}/ft`
    : difficulty;
}

function rooflineCost(footage: number, difficulty: RooflineDifficulty, customRate?: number): number {
  return Math.round(units(footage) * resolveRate(BUSINESS_RULES.rooflineRates, difficulty, customRate));
}

// Both mutually-exclusive roofline options, priced from the captured footage.
// Santa's = front only (exists when there's front footage). Gingerbread =
// front + ridge + sides — only a DISTINCT option when there's ridge/sides
// footage to add (otherwise it would be identical to Santa's). Each component
// is priced at its own difficulty (Gingerbread = the front cost + the
// ridge/sides cost). The portal shows both; only the recommended one is billed.
function rooflineOptionsFor(inputs: QuoteInputs): QuoteResult['rooflineOptions'] {
  const frontCost = rooflineCost(inputs.santasFootage, inputs.santasDifficulty, inputs.santasCustomRate);
  const ridgeSidesCost = rooflineCost(
    inputs.gingerbreadFootage,
    inputs.gingerbreadDifficulty,
    inputs.gingerbreadCustomRate,
  );

  const santas =
    inputs.santasFootage > 0 ? { footage: inputs.santasFootage, amount: frontCost } : null;

  const gingerbread =
    inputs.gingerbreadFootage > 0
      ? {
          footage: inputs.santasFootage + inputs.gingerbreadFootage,
          amount: frontCost + ridgeSidesCost,
        }
      : null;

  return { santas, gingerbread };
}

// When staff hasn't recommended a roofline, auto-pick the option whose
// resulting quote total (the rest of the quote + that option) lands closest
// to the $1,000 minimum WITHOUT going under it — so we don't lead with a scary
// Gingerbread price when Santa's already clears the minimum. If neither option
// reaches the minimum, pick the larger (closest from below).
function autoRooflineChoice(
  restSubtotal: number,
  options: QuoteResult['rooflineOptions'],
): RooflineChoice {
  const candidates: { choice: RooflineChoice; total: number }[] = [];
  if (options.santas) candidates.push({ choice: 'santas', total: restSubtotal + options.santas.amount });
  if (options.gingerbread) {
    candidates.push({ choice: 'gingerbread', total: restSubtotal + options.gingerbread.amount });
  }
  if (candidates.length === 0) return 'none';

  const min = BUSINESS_RULES.minimumQuoteAmount;
  const meeting = candidates.filter((c) => c.total >= min);
  if (meeting.length > 0) {
    return meeting.reduce((best, c) => (c.total < best.total ? c : best)).choice;
  }
  return candidates.reduce((best, c) => (c.total > best.total ? c : best)).choice;
}

// Honor an explicit operator recommendation; otherwise auto-pick (above).
// A stale explicit choice whose matching option no longer exists (e.g. staff
// picked 'gingerbread' and the gingerbread footage was later zeroed out) must
// NOT silently bill $0 for the whole roofline — fall through to auto-pick
// from whatever options DO exist instead of returning the unbillable choice.
// An explicit 'none' always means no roofline, with no fallback.
function resolveRooflineChoice(
  inputs: QuoteInputs,
  restSubtotal: number,
  options: QuoteResult['rooflineOptions'],
): RooflineChoice {
  if (inputs.rooflineChoice === 'santas' && options.santas) return 'santas';
  if (inputs.rooflineChoice === 'gingerbread' && options.gingerbread) return 'gingerbread';
  if (inputs.rooflineChoice === 'none') return 'none';
  return autoRooflineChoice(restSubtotal, options);
}

// The recommended roofline as ONE line item (Santa's OR Gingerbread, never
// both). The non-recommended option lives only in QuoteResult.rooflineOptions
// for display — it is NOT billed (so the front footage isn't double-counted).
function rooflineLineItem(
  inputs: QuoteInputs,
  choice: RooflineChoice,
  options: QuoteResult['rooflineOptions'],
): LineItem[] {
  if (choice === 'santas' && options.santas) {
    return [
      {
        label: `Santa's Roofline – ${inputs.santasFootage}ft (${rateLabel(inputs.santasDifficulty, inputs.santasCustomRate)})`,
        amount: options.santas.amount,
        id: 'roofline-santas', // #104 stable id (matches the portal adapter's option id)
      },
    ];
  }
  if (choice === 'gingerbread' && options.gingerbread) {
    return [
      {
        label: `Gingerbread – ${options.gingerbread.footage}ft (front + ridge + sides)`,
        amount: options.gingerbread.amount,
        id: 'roofline-gingerbread', // #104 stable id (matches the portal adapter's option id)
      },
    ];
  }
  return [];
}

// Winter Wonderland (C9 custom runs) — INDEPENDENT of the Santa's/Gingerbread
// choice; left exactly as it was. Part of the "rest of the quote."
function calculateWinterWonderland(inputs: QuoteInputs): LineItem[] {
  if (!(inputs.winterWonderlandFootage > 0)) return []; // drops 0/negative/NaN
  return [
    {
      label: `Winter Wonderland – ${inputs.winterWonderlandFootage}ft (${rateLabel(inputs.winterWonderlandDifficulty, inputs.winterWonderlandCustomRate)})`,
      amount: rooflineCost(
        inputs.winterWonderlandFootage,
        inputs.winterWonderlandDifficulty,
        inputs.winterWonderlandCustomRate,
      ),
      id: 'winter-wonderland', // #104 stable id (single footage-driven line)
    },
  ];
}

// Stake Lighting (staked ground runs) — INDEPENDENT of the Santa's/Gingerbread
// choice, like Winter Wonderland, but billed at its own $6/$7/$8 rate table.
// Part of the "rest of the quote." The label must NOT contain Wonderland/
// Roofline/Gingerbread/Ridge or the portal lineItemKind parser mis-classifies it.
function calculateStakeLighting(inputs: QuoteInputs): LineItem[] {
  if (!(inputs.stakeLightingFootage > 0)) return []; // drops 0/negative/NaN
  return [
    {
      label: `Stake Lighting – ${inputs.stakeLightingFootage}ft (${rateLabel(inputs.stakeLightingDifficulty, inputs.stakeLightingCustomRate)})`,
      amount: Math.round(
        units(inputs.stakeLightingFootage) *
          resolveRate(
            BUSINESS_RULES.stakeLightingRates,
            inputs.stakeLightingDifficulty,
            inputs.stakeLightingCustomRate,
          ),
      ),
      id: 'stake-lighting', // #104 stable id (single footage-driven line)
    },
  ];
}

// ─────────────────────────────────────────────────────────
// Mini lights calculation (trees / bushes / columns)
// ─────────────────────────────────────────────────────────

const MINI_LIGHT_TYPE_LABELS: Record<MiniLightItem['type'], string> = {
  tree: 'Tree',
  bush: 'Bush',
  column: 'Column',
  railing: 'Railing',
  curtain: 'Curtain Lights',
};

// Mini-light surfaces with NO wrap style — they run strands at the standard
// per-string cost (the canopy rate, same as a bush) and label without a "wrap"
// qualifier (Jason, S5). Only TREES vary by wrap style (canopy vs trunk).
const NO_WRAP_STYLE_TYPES: ReadonlySet<MiniLightItem['type']> = new Set(['column', 'railing', 'curtain']);

// #104: carry a per-unit input's stable id + scene links onto its emitted LineItem,
// only when present so legacy/manual lines stay a clean { label, amount }.
function withIdentity(item: LineIdentity): Pick<LineItem, 'id' | 'sceneItemIds'> {
  return {
    ...(item.id ? { id: item.id } : {}),
    ...(item.sceneItemIds ? { sceneItemIds: item.sceneItemIds } : {}),
  };
}

// ─────────────────────────────────────────────────────────
// item-numbering-rename: duplicate-label numbering + staff renames
// ─────────────────────────────────────────────────────────

// The active override text for a line id, or undefined (no override / blank /
// whitespace-only — a blank value means "revert to the auto label", same as
// omitting the key entirely). PRESENCE-keyed like overrideAmount below, not
// truthiness, so the trim is the only thing that decides "active".
function activeLabelOverride(id: string | undefined, overrides: QuoteInputs['labelOverrides']): string | undefined {
  if (!id || !overrides || !Object.prototype.hasOwnProperty.call(overrides, id)) return undefined;
  const raw = overrides[id];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

// Exported: resolve a line's DISPLAY label for any surface that reads
// result.lineItems directly (the quote builder breakdown, the admin quote
// page) instead of going through the portal adapter (which applies this same
// resolution itself, in buildLineItems) — both call sites share this one
// implementation so they can never disagree. `overridden` tells the caller
// whether an active override won, so a "custom · reset" UI affordance (or a
// PDF's decision to break an item out of an aggregate row) doesn't have to
// re-derive it by comparing strings.
export function resolveLineItemLabel(
  id: string | undefined,
  defaultLabel: string,
  overrides: QuoteInputs['labelOverrides'],
): { label: string; overridden: boolean } {
  const ov = activeLabelOverride(id, overrides);
  return ov !== undefined ? { label: ov, overridden: true } : { label: defaultLabel, overridden: false };
}

// Number duplicate DEFAULT labels within one per-unit category, in array
// order — stable across recalculates because the array order is the design
// scene's own persisted item order (projectScene → applyProjectionToInputs),
// never Map/object key iteration. An item with an ACTIVE override drops OUT
// of the duplicate pool entirely (both as a contributor to another item's
// count, and as a recipient of a number itself) — Jason's ruling: renaming
// one of two identically-labeled items un-numbers the survivor, since it's no
// longer ambiguous. Its own returned label is irrelevant (resolveLineItemLabel
// replaces it at every display surface) — returned unnumbered for
// determinism, not because it matters.
//
// `insertAt` is the character offset within the default label to insert " N"
// at: minis pass the bare kind-name prefix's length (so "Tree – canopy
// wrap…" becomes "Tree 2 – canopy wrap…", matching the customer-facing bare
// name once the portal strips the wrap-detail suffix); every other category
// has no clean separable product-name prefix (size/tier ARE the identity), so
// they pass the label's own length to append at the end instead.
function numberDuplicateLabels<T extends LineIdentity>(
  raw: { item: T; defaultLabel: string; insertAt: number }[],
  overrides: QuoteInputs['labelOverrides'],
): string[] {
  const counts = new Map<string, number>();
  for (const r of raw) {
    if (activeLabelOverride(r.item.id, overrides) !== undefined) continue;
    counts.set(r.defaultLabel, (counts.get(r.defaultLabel) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return raw.map((r) => {
    if (activeLabelOverride(r.item.id, overrides) !== undefined) return r.defaultLabel;
    const total = counts.get(r.defaultLabel) ?? 1;
    if (total <= 1) return r.defaultLabel;
    const n = (seen.get(r.defaultLabel) ?? 0) + 1;
    seen.set(r.defaultLabel, n);
    return `${r.defaultLabel.slice(0, r.insertAt)} ${n}${r.defaultLabel.slice(r.insertAt)}`;
  });
}

function calculateMiniLights(inputs: QuoteInputs): LineItem[] {
  const overrides = inputs.labelOverrides;
  const raw = inputs.miniLightItems.map(item => {
    const count = units(item.stringCount);
    const strings = count === 1 ? '1 string' : `${count} strings`;
    const prefix = MINI_LIGHT_TYPE_LABELS[item.type];
    let amount: number;
    let defaultLabel: string;
    if (NO_WRAP_STYLE_TYPES.has(item.type)) {
      defaultLabel = `${prefix} – ${strings}`;
      amount = count * BUSINESS_RULES.miniLightRates.canopy;
    } else {
      const rate = BUSINESS_RULES.miniLightRates[item.wrapStyle];
      amount = count * rate;
      defaultLabel = `${prefix} – ${item.wrapStyle} wrap, ${strings}`;
    }
    // item-numbering-rename: insert a duplicate's " N" right after the bare
    // kind-name prefix ("Tree 2 – canopy wrap, …"), not at the label's end.
    return { item, defaultLabel, amount, insertAt: prefix.length };
  });
  const labels = numberDuplicateLabels(raw, overrides);
  return raw.map((r, i) => ({ label: labels[i], amount: r.amount, ...withIdentity(r.item) }));
}

// ─────────────────────────────────────────────────────────
// Spritzers calculation
// ─────────────────────────────────────────────────────────

function calculateSpritzers(inputs: QuoteInputs): LineItem[] {
  const overrides = inputs.labelOverrides;
  const raw = inputs.spritzers.map(item => {
    const qty = units(item.quantity);
    const rate = BUSINESS_RULES.spritzerRates[item.size];
    const amount = qty * rate;
    const defaultLabel = qty === 1
      ? `${item.size}" Spritzer`
      : `${item.size}" Spritzers × ${qty}`;
    // No clean separable product-name prefix (size IS the identity) — a
    // duplicate's " N" appends at the label's end instead.
    return { item, defaultLabel, amount, insertAt: defaultLabel.length };
  });
  const labels = numberDuplicateLabels(raw, overrides);
  return raw.map((r, i) => ({ label: labels[i], amount: r.amount, ...withIdentity(r.item) }));
}

// ─────────────────────────────────────────────────────────
// Wreaths calculation
// ─────────────────────────────────────────────────────────

const WREATH_SIZE_LABELS: Record<WreathSize, string> = {
  '24noble': '24" Noble',
  '30noble': '30" Noble',
  '36noble': '36" Noble',
  '48noble': '48" Noble',
  '60noble': '60" Noble',
  '72noble': '72" Noble',
};

const TIER_LABELS: Record<DecorTier, string> = {
  bow:       'Non-Decorated',
  fullDecor: 'Decorated',
};

function calculateWreaths(inputs: QuoteInputs): LineItem[] {
  const overrides = inputs.labelOverrides;
  const raw = inputs.wreaths.map(item => {
    const qty = units(item.quantity);
    const price = BUSINESS_RULES.wreathPrices[item.size][item.tier];
    const amount = price * qty;
    const productName = `${WREATH_SIZE_LABELS[item.size]} Wreath`;
    const base = `${productName} – ${TIER_LABELS[item.tier]}`;
    const defaultLabel = qty === 1 ? base : `${base} × ${qty}`;
    // item-numbering-rename (fix round, technical-lens MED): insert the
    // duplicate's " N" right after the PRODUCT-NAME segment, before " – tier"
    // — NOT at the label's end like the original cut. Appending at the end
    // put the digit inside the portal's extractDecorDetail tier capture
    // (lineItemKind.ts's tierM regex has no "×" terminator when qty===1, so
    // it swallowed a trailing digit straight into `detail` — "Non-Decorated
    // 1" — which prints VERBATIM on the customer Quote/Invoice/Receipt PDFs;
    // wreath/garland skip the wrapped-mini aggregation that would have hidden
    // it). Same structural fix as minis (insertAt = prefix.length) — the
    // prefix boundary here is just delimited by " – " instead of a bare
    // space, and it happens to also dodge the qty>1 "× N N" concern for free
    // (the number always lands before " – tier", never after "× qty").
    return { item, defaultLabel, amount, insertAt: productName.length };
  });
  const labels = numberDuplicateLabels(raw, overrides);
  return raw.map((r, i) => ({ label: labels[i], amount: r.amount, ...withIdentity(r.item) }));
}

// ─────────────────────────────────────────────────────────
// Garland calculation
// ─────────────────────────────────────────────────────────

const GARLAND_TYPE_LABELS: Record<GarlandType, string> = {
  noble: 'Noble',
};

function calculateGarland(inputs: QuoteInputs): LineItem[] {
  const overrides = inputs.labelOverrides;
  const raw = inputs.garland.map(item => {
    const qty = units(item.quantity);
    const price = BUSINESS_RULES.garlandPrices[item.type][item.length][item.tier];
    const amount = price * qty;
    const productName = `${item.length} ${GARLAND_TYPE_LABELS[item.type]} Garland`;
    const base = `${productName} – ${TIER_LABELS[item.tier]}`;
    const defaultLabel = qty === 1 ? base : `${base} × ${qty}`;
    // item-numbering-rename (fix round, technical-lens MED): same
    // product-name-segment insertion as calculateWreaths above, for the
    // identical reason (extractDecorDetail's tier capture would otherwise
    // swallow the digit into the customer-facing PDF `detail`).
    return { item, defaultLabel, amount, insertAt: productName.length };
  });
  const labels = numberDuplicateLabels(raw, overrides);
  return raw.map((r, i) => ({ label: labels[i], amount: r.amount, ...withIdentity(r.item) }));
}

// ─────────────────────────────────────────────────────────
// Standalone bows (#28)
// ─────────────────────────────────────────────────────────

// Flat per-bow price (currently $0 — see BUSINESS_RULES.standaloneBowPrice
// TODO). One input entry → one line item, so a design's drawn bows each get
// their own portal toggle (per-instance, like minis). Defensive: malformed
// entries are skipped, quantities floor to whole bows.
function calculateBows(inputs: QuoteInputs): LineItem[] {
  if (!Array.isArray(inputs.bows)) return [];
  const overrides = inputs.labelOverrides;
  const raw = inputs.bows
    .filter(
      (b) =>
        b &&
        typeof b.quantity === 'number' &&
        Number.isFinite(b.quantity) &&
        b.quantity >= 1,
    )
    .map((b) => {
      const qty = Math.floor(b.quantity);
      const defaultLabel = qty === 1 ? 'Bow' : `Bows × ${qty}`;
      return { item: b, defaultLabel, amount: qty * BUSINESS_RULES.standaloneBowPrice, insertAt: defaultLabel.length };
    });
  const labels = numberDuplicateLabels(raw, overrides);
  return raw.map((r, i) => ({ label: labels[i], amount: r.amount, ...withIdentity(r.item) }));
}

// ─────────────────────────────────────────────────────────
// Custom / manual line items (#27 escape hatch)
// ─────────────────────────────────────────────────────────

// Pass staff-entered custom items straight through as line items — no price-book
// lookup, the amount IS the price. Defensive: skip entries without a non-empty
// label or a finite, non-negative amount (a malformed entry never breaks a quote).
export function calculateCustomLineItems(inputs: QuoteInputs): LineItem[] {
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
      // Quantity defaults to 1; a missing/invalid/<1 value is treated as 1.
      const qty =
        typeof c.quantity === 'number' && Number.isFinite(c.quantity) && c.quantity >= 1
          ? Math.floor(c.quantity)
          : 1;
      const label = qty === 1 ? c.label.trim() : `${c.label.trim()} × ${qty}`;
      return { label, amount: c.amount * qty, ...(c.id ? { id: c.id } : {}) };
    });
}

// ─────────────────────────────────────────────────────────
// Per-quote line-item TOTAL overrides (#104)
// ─────────────────────────────────────────────────────────

// The override for a line id, or undefined. PRESENCE-keyed (`id in map`), NEVER
// truthiness — 0 is a valid, intentional override ("free spritzers"). A missing
// id, a non-finite, or a negative amount falls back to the computed price.
function overrideAmount(
  id: string | undefined,
  overrides: QuoteInputs['lineItemPriceOverrides'],
): number | undefined {
  if (!id || !overrides || !Object.prototype.hasOwnProperty.call(overrides, id)) return undefined;
  const a = overrides[id]?.amount;
  return typeof a === 'number' && Number.isFinite(a) && a >= 0 ? a : undefined;
}

// Replace each line's billed amount with its override (by stable id), if any.
export function applyLineOverrides(
  lines: LineItem[],
  overrides: QuoteInputs['lineItemPriceOverrides'],
): LineItem[] {
  if (!overrides) return lines;
  return lines.map((li) => {
    const a = overrideAmount(li.id, overrides);
    return a === undefined ? li : { ...li, amount: a };
  });
}

// A roofline TOTAL override targets the OPTION amount (both Santa's + Gingerbread
// are exposed to the portal from rooflineOptions; the billed line is then built
// from the overridden option, so the two stay consistent).
function applyRooflineOverrides(
  options: QuoteResult['rooflineOptions'],
  overrides: QuoteInputs['lineItemPriceOverrides'],
): QuoteResult['rooflineOptions'] {
  if (!overrides) return options;
  const santasAmt = overrideAmount('roofline-santas', overrides);
  const gingerAmt = overrideAmount('roofline-gingerbread', overrides);
  return {
    santas: options.santas && santasAmt !== undefined ? { ...options.santas, amount: santasAmt } : options.santas,
    gingerbread:
      options.gingerbread && gingerAmt !== undefined ? { ...options.gingerbread, amount: gingerAmt } : options.gingerbread,
  };
}

// ─────────────────────────────────────────────────────────
// Main quote calculator — add each category here as we build
// ─────────────────────────────────────────────────────────

export function calculateQuote(inputs: QuoteInputs): QuoteResult {
  // "Rest of the quote" — everything except the Santa's/Gingerbread choice
  // (C9/Winter Wonderland is independent and belongs here). Computed first so
  // the recommended roofline can be auto-picked relative to the $1,000 minimum.
  // #104: per-quote line-item TOTAL overrides (keyed by stable id) are applied to
  // the rest items + the roofline options up front, so restSubtotal, the roofline
  // auto-choice, the billed subtotal, tax/total/deposit, and the $1,000 gate all
  // reflect the overridden amounts consistently.
  const overrides = inputs.lineItemPriceOverrides;
  const restItems: LineItem[] = applyLineOverrides(
    [
      ...calculateWinterWonderland(inputs),
      ...calculateStakeLighting(inputs),
      ...calculateMiniLights(inputs),
      ...calculateSpritzers(inputs),
      ...calculateWreaths(inputs),
      ...calculateGarland(inputs),
      ...calculateBows(inputs),
      ...calculateCustomLineItems(inputs),
    ],
    overrides,
  );
  const restSubtotal = restItems.reduce((sum, item) => sum + item.amount, 0);

  // Both roofline options are exposed (so the builder + portal can show both),
  // but only the recommended one is billed — Santa's and Gingerbread are
  // mutually exclusive (#17). A per-quote roofline TOTAL override (#104) applies
  // to the option amount; the billed line is then built from the overridden option.
  const rooflineOptions = applyRooflineOverrides(rooflineOptionsFor(inputs), overrides);
  const rooflineChoice = resolveRooflineChoice(inputs, restSubtotal, rooflineOptions);

  // Recommended roofline first (keeps it at the top of the breakdown), then
  // the rest.
  const lineItems: LineItem[] = [
    ...rooflineLineItem(inputs, rooflineChoice, rooflineOptions),
    ...restItems,
  ];

  const subtotalBeforeDiscount = lineItems.reduce((sum, item) => sum + item.amount, 0);

  // Billed figures — priced on the SELECTED roofline.
  const tail = computeTotalsTail(subtotalBeforeDiscount, inputs);

  // The $1,000 minimum is NO LONGER auto-applied here: staff can intentionally
  // send a sub-$1,000 quote for niche cases. The minimum is enforced as a
  // customer-side approval gate on the portal instead (see lib/portal/adapter
  // `minimumOrderSubtotal` + SelectionContext). `minimumApplied` stays false to
  // preserve the home.works payload contract (downstream still reads the flag).
  const minimumApplied = false;

  // #107 "Full Yule" ceiling — swap the SELECTED roofline for the MOST-EXPENSIVE
  // one (Gingerbread if present, else Santa's) and re-run the identical
  // discount/fee/tax/deposit math. Additive: the billed figures above are
  // untouched; this only powers the operator builder's headline sticker.
  const selectedRooflineAmount =
    rooflineChoice === 'santas'
      ? rooflineOptions.santas?.amount ?? 0
      : rooflineChoice === 'gingerbread'
        ? rooflineOptions.gingerbread?.amount ?? 0
        : 0;
  // The true MAX — not just "gingerbread if present". Naturally gingerbread
  // (front + ridge + sides) ≥ santas (front), but a #104 per-quote override can
  // set either amount arbitrarily, so take the actual larger of the two.
  const maxRooflineAmount = Math.max(
    rooflineOptions.santas?.amount ?? 0,
    rooflineOptions.gingerbread?.amount ?? 0,
  );
  const fullSubtotalBeforeDiscount =
    subtotalBeforeDiscount - selectedRooflineAmount + maxRooflineAmount;
  const fullTail = computeTotalsTail(fullSubtotalBeforeDiscount, inputs);
  const fullYule: FullYuleTotals = {
    subtotalBeforeDiscount: fullSubtotalBeforeDiscount,
    ...fullTail,
  };

  return {
    lineItems,
    subtotalBeforeDiscount,
    discountAmount: tail.discountAmount,
    earlyInstallDiscountAmount: tail.earlyInstallDiscountAmount,
    subtotalAfterDiscount: tail.subtotalAfterDiscount,
    minimumApplied,
    rushFeeAmount: tail.rushFeeAmount,
    takedownAmount: tail.takedownAmount,
    taxableAmount: tail.taxableAmount,
    taxAmount: tail.taxAmount,
    total: tail.total,
    depositAmount: tail.depositAmount,
    balanceDue: tail.balanceDue,
    rooflineChoice,
    rooflineOptions,
    fullYule,
    // #177: freeze the effective rate this result was priced with.
    depositRate: effectiveDepositRate(inputs.depositPercent),
  };
}

// #177: the effective deposit rate (0-1) for a quote — a staff-set integer
// percent (1-100, inputs.depositPercent) overrides BUSINESS_RULES.depositPercentage.
// Validated here (not just at the write-path 400) so a malformed/legacy stored
// value degrades to the default instead of NaN-ing every downstream deposit
// calculation. Mirrors resolveRate's guard style.
export function effectiveDepositRate(depositPercent?: number): number {
  return Number.isInteger(depositPercent) && (depositPercent as number) >= 1 && (depositPercent as number) <= 100
    ? (depositPercent as number) / 100
    : BUSINESS_RULES.depositPercentage;
}

// #226 fix: the "is this an actual staff override" predicate effectiveDepositRate
// applies internally — exported so a caller that needs to COMPARE two raw
// depositPercent values (the #177 approval-freeze lock in /api/quote) can
// normalize both sides through the identical rule, instead of only checking
// `typeof === 'number'`. Without this, a stored explicit 0 (out of [1,100],
// so effectiveDepositRate already treats it as "no override") compared
// !== an incoming undefined even though they mean the same thing — bricking
// the freeze's own save path. Returns the valid percent, or undefined for
// anything effectiveDepositRate would fall through to the default for
// (undefined, 0, non-integers, out-of-range).
export function normalizedDepositOverride(depositPercent?: number): number | undefined {
  return Number.isInteger(depositPercent) && (depositPercent as number) >= 1 && (depositPercent as number) <= 100
    ? (depositPercent as number)
    : undefined;
}

// The subtotal → total tail: manual discount, early-install promo, rush + premium
// fees, tax, 50% deposit split. Pure fn of the pre-discount subtotal + the fee/
// discount inputs, so the SELECTED subtotal (billed) and the "Full Yule" ceiling
// subtotal (#107) run through ONE formula — the two computations can't drift apart
// in maintenance. (Each still rounds on its own input, so the outputs aren't a
// linear function of each other — that's expected.)
export function computeTotalsTail(
  subtotalBeforeDiscount: number,
  inputs: QuoteInputs,
): Omit<FullYuleTotals, 'subtotalBeforeDiscount'> {
  let discountAmount = 0;
  if (inputs.discount) {
    // Clamp the discount amount at 0 (mirrors the units()/overrideAmount guards):
    // a non-finite or NEGATIVE amount (e.g. a fat-fingered '-50') would otherwise
    // INFLATE the total — the portal + approve recompute ignore a negative discount,
    // so the stored/emailed/CRM figure would silently diverge from what the customer
    // sees and approves.
    const amount =
      Number.isFinite(inputs.discount.amount) && inputs.discount.amount > 0
        ? inputs.discount.amount
        : 0;
    discountAmount = inputs.discount.type === 'percentage'
      ? moneyTimesRate(subtotalBeforeDiscount, amount)
      : amount;
  }

  const postDiscount = subtotalBeforeDiscount - discountAmount;

  // Early-install promo (#40): Sep 15% / Oct 10% off the ITEM SUBTOTAL, mirroring
  // the portal's priceSelection (off the subtotal, before fees + tax). Absent or
  // 'none' → 0, so quotes priced before this field are unaffected.
  const earlyInstallRate =
    inputs.installTiming === 'september'
      ? BUSINESS_RULES.earlyInstallDiscounts.september
      : inputs.installTiming === 'october'
        ? BUSINESS_RULES.earlyInstallDiscounts.october
        : 0;
  const earlyInstallDiscountAmount =
    moneyTimesRate(subtotalBeforeDiscount, earlyInstallRate);

  // Clamp at 0: an over-large manual discount and/or early-install promo must
  // never drive the item subtotal — and therefore the total/deposit — negative.
  // Valid quotes are unaffected (postDiscount − earlyInstall is already >= 0).
  const subtotalAfterDiscount = Math.max(0, postDiscount - earlyInstallDiscountAmount);

  // Early-install and the rush-install fee are mutually exclusive (#40): an
  // early-install quote never also charges rush.
  const rushFeeAmount =
    inputs.rushFee && earlyInstallRate === 0 ? BUSINESS_RULES.rushFeeAmount : 0;
  const takedownAmount = inputs.takedown === 'premium' ? BUSINESS_RULES.premiumTakedownFee : 0;

  const taxableAmount = subtotalAfterDiscount + rushFeeAmount + takedownAmount;
  const taxAmount = moneyTimesRate(taxableAmount, BUSINESS_RULES.taxRate);
  const total = roundMoney(taxableAmount + taxAmount);
  const depositAmount = moneyTimesRate(total, effectiveDepositRate(inputs.depositPercent));
  const balanceDue = roundMoney(total - depositAmount);

  return {
    discountAmount,
    earlyInstallDiscountAmount,
    subtotalAfterDiscount,
    rushFeeAmount,
    takedownAmount,
    taxableAmount,
    taxAmount,
    total,
    depositAmount,
    balanceDue,
  };
}

// Row 409 — the NCE (barter/trade network) deposit rule's percent, in ONE place.
// #199 set this default when the NCE tag goes on; three call sites carried the
// bare literal 40 (the nce route, QuoteBuilder's prefill, and this rule's own
// description) which is how a rule number drifts. Nothing ENFORCES it — Jason
// ruled 2026-08-25 that a sent quote may legitimately sit off it (row 409) — so
// this is the number surfaces COMPARE against, not one they impose.
export const NCE_DEPOSIT_PERCENT = 40;

// Row 409 — the live (pre-approval) deposit rate a quote is actually charged
// at, resolved in ONE place so every surface that shows it agrees with the one
// that charges it by construction. Precedence is chargesFromResult's, which is
// what the portal and the approve route price from: a staff-set
// inputs.depositPercent wins, else the rate frozen into result at pricing time,
// else the business default. An APPROVED quote's frozen
// approval_snapshot.customerSelection.depositRate outranks all of this and is
// applied by the caller (see resolveQuoteDepositRate in src/lib/quotes.ts).
export function liveDepositRate(depositPercent?: number, resultRate?: number | null): number {
  return typeof depositPercent === 'number'
    ? effectiveDepositRate(depositPercent)
    : (resultRate ?? BUSINESS_RULES.depositPercentage);
}
