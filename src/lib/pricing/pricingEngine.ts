// Yule Love Lights — Pricing Engine
// Pure TypeScript: takes a house description, returns a price.

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
} as const;

// ─────────────────────────────────────────────────────────
// Input types — what a quote needs to know about the house
// ─────────────────────────────────────────────────────────

export type RooflineDifficulty = 'easy' | 'medium' | 'hard';

export type MiniLightItem = {
  type: 'tree' | 'bush' | 'column' | 'railing' | 'curtain';
  wrapStyle: 'canopy' | 'trunk';
  stringCount: number;
};

export type SpritzerSize = '16' | '24' | '32';
export type Spritzer = {
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

export type Wreath = {
  size: WreathSize;
  tier: DecorTier;
  quantity: number;
};

export type GarlandLength = '4.5ft' | '9ft';
export type GarlandType = 'noble';

export type GarlandItem = {
  length: GarlandLength;
  type: GarlandType;
  tier: DecorTier;
  quantity: number;
};

// Standalone bow (#28) — bills flat per bow (no size/tier; the drawn size on a
// design is visual-only, like every per-unit item).
export type BowLineInput = {
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
  label: string;
  amount: number; // unit price
  quantity?: number; // default 1
  description?: string;
  // Staff-set "advised for this home" flag (#12). Pre-selects this custom item
  // on the customer portal + shows a "Recommended" label. Default false.
  // Pricing ignores it; it only rides along to the portal via the adapter.
  recommended?: boolean;
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
  // Early-install promo (#40). When 'september'/'october', a percentage discount
  // (BUSINESS_RULES.earlyInstallDiscounts) comes off the item subtotal and the
  // rush-install fee is suppressed (mutually exclusive). Absent/'none' = no promo.
  installTiming?: EarlyInstallTiming;
}

// ─────────────────────────────────────────────────────────
// Output types — what the customer portal displays
// ─────────────────────────────────────────────────────────

export type LineItem = {
  label: string;
  amount: number;
};

// One mutually-exclusive roofline option (Santa's or Gingerbread): the total
// footage it covers and its dollar amount.
export type RooflineOption = { footage: number; amount: number };

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
function resolveRooflineChoice(
  inputs: QuoteInputs,
  restSubtotal: number,
  options: QuoteResult['rooflineOptions'],
): RooflineChoice {
  if (inputs.rooflineChoice) return inputs.rooflineChoice;
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
      },
    ];
  }
  if (choice === 'gingerbread' && options.gingerbread) {
    return [
      {
        label: `Gingerbread – ${options.gingerbread.footage}ft (front + ridge + sides)`,
        amount: options.gingerbread.amount,
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

function calculateMiniLights(inputs: QuoteInputs): LineItem[] {
  return inputs.miniLightItems.map(item => {
    const count = units(item.stringCount);
    const strings = count === 1 ? '1 string' : `${count} strings`;
    if (NO_WRAP_STYLE_TYPES.has(item.type)) {
      return {
        label: `${MINI_LIGHT_TYPE_LABELS[item.type]} – ${strings}`,
        amount: count * BUSINESS_RULES.miniLightRates.canopy,
      };
    }
    const rate = BUSINESS_RULES.miniLightRates[item.wrapStyle];
    const amount = count * rate;
    const label = `${MINI_LIGHT_TYPE_LABELS[item.type]} – ${item.wrapStyle} wrap, ${strings}`;
    return { label, amount };
  });
}

// ─────────────────────────────────────────────────────────
// Spritzers calculation
// ─────────────────────────────────────────────────────────

function calculateSpritzers(inputs: QuoteInputs): LineItem[] {
  return inputs.spritzers.map(item => {
    const qty = units(item.quantity);
    const rate = BUSINESS_RULES.spritzerRates[item.size];
    const amount = qty * rate;
    const label = qty === 1
      ? `${item.size}" Spritzer`
      : `${item.size}" Spritzers × ${qty}`;
    return { label, amount };
  });
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
  return inputs.wreaths.map(item => {
    const qty = units(item.quantity);
    const price = BUSINESS_RULES.wreathPrices[item.size][item.tier];
    const amount = price * qty;
    const base = `${WREATH_SIZE_LABELS[item.size]} Wreath – ${TIER_LABELS[item.tier]}`;
    const label = qty === 1 ? base : `${base} × ${qty}`;
    return { label, amount };
  });
}

// ─────────────────────────────────────────────────────────
// Garland calculation
// ─────────────────────────────────────────────────────────

const GARLAND_TYPE_LABELS: Record<GarlandType, string> = {
  noble: 'Noble',
};

function calculateGarland(inputs: QuoteInputs): LineItem[] {
  return inputs.garland.map(item => {
    const qty = units(item.quantity);
    const price = BUSINESS_RULES.garlandPrices[item.type][item.length][item.tier];
    const amount = price * qty;
    const base = `${item.length} ${GARLAND_TYPE_LABELS[item.type]} Garland – ${TIER_LABELS[item.tier]}`;
    const label = qty === 1 ? base : `${base} × ${qty}`;
    return { label, amount };
  });
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
  return inputs.bows
    .filter(
      (b) =>
        b &&
        typeof b.quantity === 'number' &&
        Number.isFinite(b.quantity) &&
        b.quantity >= 1,
    )
    .map((b) => {
      const qty = Math.floor(b.quantity);
      return {
        label: qty === 1 ? 'Bow' : `Bows × ${qty}`,
        amount: qty * BUSINESS_RULES.standaloneBowPrice,
      };
    });
}

// ─────────────────────────────────────────────────────────
// Custom / manual line items (#27 escape hatch)
// ─────────────────────────────────────────────────────────

// Pass staff-entered custom items straight through as line items — no price-book
// lookup, the amount IS the price. Defensive: skip entries without a non-empty
// label or a finite, non-negative amount (a malformed entry never breaks a quote).
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
      // Quantity defaults to 1; a missing/invalid/<1 value is treated as 1.
      const qty =
        typeof c.quantity === 'number' && Number.isFinite(c.quantity) && c.quantity >= 1
          ? Math.floor(c.quantity)
          : 1;
      const label = qty === 1 ? c.label.trim() : `${c.label.trim()} × ${qty}`;
      return { label, amount: c.amount * qty };
    });
}

// ─────────────────────────────────────────────────────────
// Main quote calculator — add each category here as we build
// ─────────────────────────────────────────────────────────

export function calculateQuote(inputs: QuoteInputs): QuoteResult {
  // "Rest of the quote" — everything except the Santa's/Gingerbread choice
  // (C9/Winter Wonderland is independent and belongs here). Computed first so
  // the recommended roofline can be auto-picked relative to the $1,000 minimum.
  const restItems: LineItem[] = [
    ...calculateWinterWonderland(inputs),
    ...calculateStakeLighting(inputs),
    ...calculateMiniLights(inputs),
    ...calculateSpritzers(inputs),
    ...calculateWreaths(inputs),
    ...calculateGarland(inputs),
    ...calculateBows(inputs),
    ...calculateCustomLineItems(inputs),
  ];
  const restSubtotal = restItems.reduce((sum, item) => sum + item.amount, 0);

  // Both roofline options are exposed (so the builder + portal can show both),
  // but only the recommended one is billed — Santa's and Gingerbread are
  // mutually exclusive (#17).
  const rooflineOptions = rooflineOptionsFor(inputs);
  const rooflineChoice = resolveRooflineChoice(inputs, restSubtotal, rooflineOptions);

  // Recommended roofline first (keeps it at the top of the breakdown), then
  // the rest.
  const lineItems: LineItem[] = [
    ...rooflineLineItem(inputs, rooflineChoice, rooflineOptions),
    ...restItems,
  ];

  const subtotalBeforeDiscount = lineItems.reduce((sum, item) => sum + item.amount, 0);

  let discountAmount = 0;
  if (inputs.discount) {
    discountAmount = inputs.discount.type === 'percentage'
      ? Math.round(subtotalBeforeDiscount * inputs.discount.amount)
      : inputs.discount.amount;
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
    Math.round(subtotalBeforeDiscount * earlyInstallRate * 100) / 100;

  // The $1,000 minimum is NO LONGER auto-applied here: staff can intentionally
  // send a sub-$1,000 quote for niche cases. The minimum is enforced as a
  // customer-side approval gate on the portal instead (see lib/portal/adapter
  // `minimumOrderSubtotal` + SelectionContext). `minimumApplied` stays false to
  // preserve the home.works payload contract (downstream still reads the flag).
  const minimumApplied = false;
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
  const taxAmount = Math.round(taxableAmount * BUSINESS_RULES.taxRate * 100) / 100;
  const total = Math.round((taxableAmount + taxAmount) * 100) / 100;
  const depositAmount = Math.round(total * BUSINESS_RULES.depositPercentage * 100) / 100;
  const balanceDue = Math.round((total - depositAmount) * 100) / 100;

  return {
    lineItems,
    subtotalBeforeDiscount,
    discountAmount,
    earlyInstallDiscountAmount,
    subtotalAfterDiscount,
    minimumApplied,
    rushFeeAmount,
    takedownAmount,
    taxableAmount,
    taxAmount,
    total,
    depositAmount,
    balanceDue,
    rooflineChoice,
    rooflineOptions,
  };
}
