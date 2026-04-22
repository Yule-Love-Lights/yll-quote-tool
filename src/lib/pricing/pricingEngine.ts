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
      '4.5ft': { labor: 0,   bow: 0,   fullDecor: 0   },  // TODO: prices TBD
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

export interface QuoteInputs {
  santasFootage: number;
  santasDifficulty: RooflineDifficulty;
  gingerbreadFootage: number;
  gingerbreadDifficulty: RooflineDifficulty;
  winterWonderlandFootage: number;
  winterWonderlandDifficulty: RooflineDifficulty;

  miniLightItems: MiniLightItem[];
  spritzers: Spritzer[];
  wreaths: Wreath[];
  garland: GarlandItem[];

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
}

// ─────────────────────────────────────────────────────────
// Roofline calculation — three independent line items
// ─────────────────────────────────────────────────────────

function calculateRooflineItems(inputs: QuoteInputs): LineItem[] {
  const items: LineItem[] = [];

  if (inputs.santasFootage > 0) {
    const rate = BUSINESS_RULES.rooflineRates[inputs.santasDifficulty];
    items.push({
      label: `Santa's Roofline – ${inputs.santasFootage}ft (${inputs.santasDifficulty})`,
      amount: Math.round(inputs.santasFootage * rate),
    });
  }

  if (inputs.gingerbreadFootage > 0) {
    const rate = BUSINESS_RULES.rooflineRates[inputs.gingerbreadDifficulty];
    items.push({
      label: `Gingerbread Ridge – ${inputs.gingerbreadFootage}ft (${inputs.gingerbreadDifficulty})`,
      amount: Math.round(inputs.gingerbreadFootage * rate),
    });
  }

  if (inputs.winterWonderlandFootage > 0) {
    const rate = BUSINESS_RULES.rooflineRates[inputs.winterWonderlandDifficulty];
    items.push({
      label: `Winter Wonderland – ${inputs.winterWonderlandFootage}ft (${inputs.winterWonderlandDifficulty})`,
      amount: Math.round(inputs.winterWonderlandFootage * rate),
    });
  }

  return items;
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
// Main quote calculator — add each category here as we build
// ─────────────────────────────────────────────────────────

export function calculateQuote(inputs: QuoteInputs): QuoteResult {
  const lineItems: LineItem[] = [];

  lineItems.push(...calculateRooflineItems(inputs));

  lineItems.push(...calculateMiniLights(inputs));

  lineItems.push(...calculateSpritzers(inputs));

  lineItems.push(...calculateWreaths(inputs));
  lineItems.push(...calculateGarland(inputs));

  const subtotalBeforeDiscount = lineItems.reduce((sum, item) => sum + item.amount, 0);

  let discountAmount = 0;
  if (inputs.discount) {
    discountAmount = inputs.discount.type === 'percentage'
      ? Math.round(subtotalBeforeDiscount * inputs.discount.amount)
      : inputs.discount.amount;
  }

  const postDiscount = subtotalBeforeDiscount - discountAmount;
  const minimumApplied = postDiscount > 0 && postDiscount < BUSINESS_RULES.minimumQuoteAmount;
  const subtotalAfterDiscount = minimumApplied ? BUSINESS_RULES.minimumQuoteAmount : postDiscount;

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
  };
}
