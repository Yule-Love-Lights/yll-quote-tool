// Yule Love Lights — Pricing Engine
// Pure TypeScript: takes a house description, returns a price.

// ─────────────────────────────────────────────────────────
// Business rules — the ONLY place adjustable numbers live
// ─────────────────────────────────────────────────────────

export const BUSINESS_RULES = {
  minimumQuoteAmount: 1000,
  rushFeeAmount: 150,
  premiumTakedownFee: 150,
  taxRate: 0.08625,
  depositPercentage: 0.50,

  rooflineRates: {
    easy: 8,
    medium: 10,
    hard: 12,
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

  wreathPrices: {
    '24noble':  { labor: 210, bow: 230, fullDecor: 275 },
    '30noble':  { labor: 285, bow: 305, fullDecor: 355 },
    '36noble':  { labor: 315, bow: 350, fullDecor: 400 },
    '48noble':  { labor: 548, bow: 605, fullDecor: 705 },
    '36oregon': { labor: 298, bow: 330, fullDecor: 380 },
  },

  garlandPrices: {
    noble: {
      '9ft':   { labor: 165, bow: 195, fullDecor: 250 },
      '4.5ft': { labor: 135, bow: 0,   fullDecor: 210 },  // TODO: 'bow' tier price still TBD — Naldo to confirm (currently silently prices $0)
    },
  },
} as const;

// ─────────────────────────────────────────────────────────
// Input types — what a quote needs to know about the house
// ─────────────────────────────────────────────────────────

export type RooflineDifficulty = 'easy' | 'medium' | 'hard';

export type MiniLightItem = {
  type: 'tree' | 'bush' | 'column';
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
  | '36oregon';

export type DecorTier = 'labor' | 'bow' | 'fullDecor';

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

export type Takedown = 'included' | 'premium';

export type Discount = {
  type: 'percentage' | 'flat';
  amount: number;
};

// Custom / manual line item (Option-2 escape hatch, #27): a staff-typed name +
// price (+ optional description) for off-design items the design can't represent
// (~5% of niche quotes). NOT tied to the scene — it's an ordinary line item on
// the quote + portal. Priced exactly as entered (no price-book lookup).
export type CustomLineItem = {
  label: string;
  amount: number;
  description?: string;
};

// Santa's (front roofline) and Gingerbread (front + ridge + sides) are
// MUTUALLY EXCLUSIVE — the customer picks one on the portal (or none). #17.
export type RooflineChoice = 'santas' | 'gingerbread' | 'none';

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
  // The roofline the quote defaults to (operator's pick). When omitted the
  // engine infers it from footage (Gingerbread if there's ridge/sides, else
  // Santa's, else none); the portal can switch it — see QuoteResult.rooflineOptions.
  rooflineChoice?: RooflineChoice;

  miniLightItems: MiniLightItem[];
  spritzers: Spritzer[];
  wreaths: Wreath[];
  garland: GarlandItem[];
  // Custom / manual line items (#27 — the Option-2 escape hatch). Optional for
  // back-compat: quotes priced before this field stay valid.
  customLineItems?: CustomLineItem[];

  takedown: Takedown;
  rushFee: boolean;
  discount?: Discount;
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

function rooflineCost(footage: number, difficulty: RooflineDifficulty): number {
  return Math.round(footage * BUSINESS_RULES.rooflineRates[difficulty]);
}

// Both mutually-exclusive roofline options, priced from the captured footage.
// Santa's = front only (exists when there's front footage). Gingerbread =
// front + ridge + sides — only a DISTINCT option when there's ridge/sides
// footage to add (otherwise it would be identical to Santa's). Each component
// is priced at its own difficulty (Gingerbread = the front cost + the
// ridge/sides cost). The portal shows both; only the recommended one is billed.
function rooflineOptionsFor(inputs: QuoteInputs): QuoteResult['rooflineOptions'] {
  const frontCost = rooflineCost(inputs.santasFootage, inputs.santasDifficulty);
  const ridgeSidesCost = rooflineCost(inputs.gingerbreadFootage, inputs.gingerbreadDifficulty);

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
        label: `Santa's Roofline – ${inputs.santasFootage}ft (${inputs.santasDifficulty})`,
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
  if (inputs.winterWonderlandFootage <= 0) return [];
  return [
    {
      label: `Winter Wonderland – ${inputs.winterWonderlandFootage}ft (${inputs.winterWonderlandDifficulty})`,
      amount: rooflineCost(inputs.winterWonderlandFootage, inputs.winterWonderlandDifficulty),
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
};

function calculateMiniLights(inputs: QuoteInputs): LineItem[] {
  return inputs.miniLightItems.map(item => {
    const rate = BUSINESS_RULES.miniLightRates[item.wrapStyle];
    const amount = item.stringCount * rate;
    const strings = item.stringCount === 1 ? '1 string' : `${item.stringCount} strings`;
    const label = `${MINI_LIGHT_TYPE_LABELS[item.type]} – ${item.wrapStyle} wrap, ${strings}`;
    return { label, amount };
  });
}

// ─────────────────────────────────────────────────────────
// Spritzers calculation
// ─────────────────────────────────────────────────────────

function calculateSpritzers(inputs: QuoteInputs): LineItem[] {
  return inputs.spritzers.map(item => {
    const rate = BUSINESS_RULES.spritzerRates[item.size];
    const amount = item.quantity * rate;
    const label = item.quantity === 1
      ? `${item.size}" Spritzer`
      : `${item.size}" Spritzers × ${item.quantity}`;
    return { label, amount };
  });
}

// ─────────────────────────────────────────────────────────
// Wreaths calculation
// ─────────────────────────────────────────────────────────

const WREATH_SIZE_LABELS: Record<WreathSize, string> = {
  '24noble':  '24" Noble',
  '30noble':  '30" Noble',
  '36noble':  '36" Noble',
  '48noble':  '48" Noble',
  '36oregon': '36" Oregon',
};

const TIER_LABELS: Record<DecorTier, string> = {
  labor:    'Labor Only',
  bow:      'With Bow',
  fullDecor: 'Full Decor',
};

function calculateWreaths(inputs: QuoteInputs): LineItem[] {
  return inputs.wreaths.map(item => {
    const price = BUSINESS_RULES.wreathPrices[item.size][item.tier];
    const amount = price * item.quantity;
    const base = `${WREATH_SIZE_LABELS[item.size]} Wreath – ${TIER_LABELS[item.tier]}`;
    const label = item.quantity === 1 ? base : `${base} × ${item.quantity}`;
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
    const price = BUSINESS_RULES.garlandPrices[item.type][item.length][item.tier];
    const amount = price * item.quantity;
    const base = `${item.length} ${GARLAND_TYPE_LABELS[item.type]} Garland – ${TIER_LABELS[item.tier]}`;
    const label = item.quantity === 1 ? base : `${base} × ${item.quantity}`;
    return { label, amount };
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
    .map((c) => ({ label: c.label.trim(), amount: c.amount }));
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
    ...calculateMiniLights(inputs),
    ...calculateSpritzers(inputs),
    ...calculateWreaths(inputs),
    ...calculateGarland(inputs),
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
  // The $1,000 minimum is NO LONGER auto-applied here: staff can intentionally
  // send a sub-$1,000 quote for niche cases. The minimum is enforced as a
  // customer-side approval gate on the portal instead (see lib/portal/adapter
  // `minimumOrderSubtotal` + SelectionContext). `minimumApplied` stays false to
  // preserve the home.works payload contract (downstream still reads the flag).
  const minimumApplied = false;
  const subtotalAfterDiscount = postDiscount;

  const rushFeeAmount = inputs.rushFee ? BUSINESS_RULES.rushFeeAmount : 0;
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
