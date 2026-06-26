// Run: npx tsx src/lib/pricing/test.ts
import { calculateQuote, QuoteInputs, QuoteResult } from './pricingEngine';

function printQuote(label: string, result: QuoteResult) {
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(52));
  result.lineItems.forEach(item =>
    console.log(`  ${item.label.padEnd(38)} $${item.amount.toLocaleString()}`)
  );
  console.log('─'.repeat(52));
  console.log(`  Subtotal                              $${result.subtotalBeforeDiscount.toLocaleString()}`);
  if (result.discountAmount > 0)
    console.log(`  Discount                             -$${result.discountAmount.toLocaleString()}`);
  if (result.minimumApplied)
    console.log(`  * Minimum quote applied ($1,000)`);
  if (result.rushFeeAmount > 0)
    console.log(`  Rush fee                              $${result.rushFeeAmount.toLocaleString()}`);
  if (result.takedownAmount > 0)
    console.log(`  Premium takedown                      $${result.takedownAmount.toLocaleString()}`);
  console.log(`  Tax (8.625% on $${result.taxableAmount.toLocaleString()})`.padEnd(42) + ` $${result.taxAmount.toFixed(2)}`);
  console.log(`  TOTAL                                 $${result.total.toFixed(2)}`);
  console.log(`  Deposit due now (50%)                 $${result.depositAmount.toFixed(2)}`);
  console.log(`  Balance at install                    $${result.balanceDue.toFixed(2)}`);
}

// ─── Test 1: Santas gutterline only, easy ────────────────────────────────────
const job1: QuoteInputs = {
  santasFootage: 120, santasDifficulty: 'easy',
  gingerbreadFootage: 0, gingerbreadDifficulty: 'medium',
  winterWonderlandFootage: 0, winterWonderlandDifficulty: 'medium',
  stakeLightingFootage: 0, stakeLightingDifficulty: 'medium',
  miniLightItems: [], spritzers: [], wreaths: [], garland: [],
  takedown: 'included', rushFee: false,
};
// Expected: 120 × $8 = $960 → minimum $1,000
printQuote('Job 1: Santas gutterline / easy / 120ft (minimum applies)', calculateQuote(job1));

// ─── Test 2: Gingerbread ridgeline only, medium ───────────────────────────────
const job2: QuoteInputs = {
  santasFootage: 0, santasDifficulty: 'medium',
  gingerbreadFootage: 120, gingerbreadDifficulty: 'medium',
  winterWonderlandFootage: 0, winterWonderlandDifficulty: 'medium',
  stakeLightingFootage: 0, stakeLightingDifficulty: 'medium',
  miniLightItems: [], spritzers: [], wreaths: [], garland: [],
  takedown: 'included', rushFee: false,
};
// Expected: 120 × $10 = $1,200
printQuote('Job 2: Gingerbread ridge / medium / 120ft', calculateQuote(job2));

// ─── Test 3: Winter Wonderland, hard, with rush + premium takedown ────────────
const job3: QuoteInputs = {
  santasFootage: 0, santasDifficulty: 'medium',
  gingerbreadFootage: 0, gingerbreadDifficulty: 'medium',
  winterWonderlandFootage: 150, winterWonderlandDifficulty: 'hard',
  stakeLightingFootage: 0, stakeLightingDifficulty: 'medium',
  miniLightItems: [], spritzers: [], wreaths: [], garland: [],
  takedown: 'premium', rushFee: true,
  discount: { type: 'percentage', amount: 0.10 },
};
// Expected: 150 × $12 = $1,800 → 10% off = -$180 → $1,620
// + rush $150 + premium takedown $150 = taxable $1,920
// Tax: $1,920 × 0.08625 = $165.60
// Total: $2,085.60 | Deposit: $1,042.80 | Balance: $1,042.80
printQuote('Job 3: Winter Wonderland / hard / 150ft + rush + premium takedown + 10% off', calculateQuote(job3));

// ─── Test 4: Mini lights only — trees + bushes, no roofline ─────────────────
const job4: QuoteInputs = {
  santasFootage: 0, santasDifficulty: 'easy',
  gingerbreadFootage: 0, gingerbreadDifficulty: 'easy',
  winterWonderlandFootage: 0, winterWonderlandDifficulty: 'easy',
  stakeLightingFootage: 0, stakeLightingDifficulty: 'medium',
  miniLightItems: [
    { type: 'tree', wrapStyle: 'trunk',  stringCount: 4 },  // $45 × 4 = $180
    { type: 'tree', wrapStyle: 'trunk',  stringCount: 3 },  // $45 × 3 = $135
    { type: 'bush', wrapStyle: 'canopy', stringCount: 2 },  // $35 × 2 = $70
    { type: 'bush', wrapStyle: 'canopy', stringCount: 2 },  // $35 × 2 = $70
    { type: 'bush', wrapStyle: 'canopy', stringCount: 2 },  // $35 × 2 = $70
  ],
  spritzers: [], wreaths: [], garland: [],
  takedown: 'included', rushFee: false,
};
// Expected: $180 + $135 + $70 + $70 + $70 = $525 → minimum $1,000
printQuote('Job 4: Trees + bushes only (minimum applies)', calculateQuote(job4));

// ─── Test 5: Santas + gingerbread together (independent footage) ──────────────
const job5: QuoteInputs = {
  santasFootage: 100, santasDifficulty: 'medium',      // 100 × $10 = $1,000
  gingerbreadFootage: 60, gingerbreadDifficulty: 'medium', // 60 × $10 = $600
  winterWonderlandFootage: 0, winterWonderlandDifficulty: 'medium',
  stakeLightingFootage: 0, stakeLightingDifficulty: 'medium',
  miniLightItems: [
    { type: 'tree',   wrapStyle: 'trunk',  stringCount: 5 },  // $225
    { type: 'column', wrapStyle: 'canopy', stringCount: 2 },  // $70
    { type: 'column', wrapStyle: 'canopy', stringCount: 2 },  // $70
  ],
  spritzers: [], wreaths: [], garland: [],
  takedown: 'included', rushFee: false,
};
// Expected: santas $1,000 + gingerbread $600 + tree $225 + 2×column $140 = $1,965
printQuote('Job 5: Santas + Gingerbread independent + tree + 2 columns', calculateQuote(job5));

// ─── Test 6: Spritzers only ───────────────────────────────────────────────────
const job6: QuoteInputs = {
  santasFootage: 0, santasDifficulty: 'easy',
  gingerbreadFootage: 0, gingerbreadDifficulty: 'easy',
  winterWonderlandFootage: 0, winterWonderlandDifficulty: 'easy',
  stakeLightingFootage: 0, stakeLightingDifficulty: 'medium',
  miniLightItems: [],
  spritzers: [
    { size: '16', quantity: 1 },   // $85 × 1 = $85
    { size: '24', quantity: 3 },   // $95 × 3 = $285
    { size: '32', quantity: 2 },   // $105 × 2 = $210
  ],
  wreaths: [], garland: [],
  takedown: 'included', rushFee: false,
};
// Expected: $85 + $285 + $210 = $580 → minimum $1,000
printQuote('Job 6: Spritzers only (minimum applies)', calculateQuote(job6));

// ─── Test 7: Santas + mini lights + spritzers ─────────────────────────────────
const job7: QuoteInputs = {
  santasFootage: 80, santasDifficulty: 'medium',
  gingerbreadFootage: 0, gingerbreadDifficulty: 'medium',
  winterWonderlandFootage: 0, winterWonderlandDifficulty: 'medium',
  stakeLightingFootage: 0, stakeLightingDifficulty: 'medium',
  miniLightItems: [
    { type: 'tree', wrapStyle: 'trunk', stringCount: 4 },   // $180
    { type: 'bush', wrapStyle: 'canopy', stringCount: 2 },  // $70
  ],
  spritzers: [{ size: '24', quantity: 2 }],  // $190
  wreaths: [], garland: [],
  takedown: 'included', rushFee: false,
};
// Expected: santas 80 × $10 = $800 + tree $180 + bush $70 + spritzers $190 = $1,240
printQuote('Job 7: Santas / medium / 80ft + tree + bush + 2×24" spritzers', calculateQuote(job7));

// ─── Test 8: Wreaths only ────────────────────────────────────────────────────
const job8: QuoteInputs = {
  santasFootage: 0, santasDifficulty: 'easy',
  gingerbreadFootage: 0, gingerbreadDifficulty: 'easy',
  winterWonderlandFootage: 0, winterWonderlandDifficulty: 'easy',
  stakeLightingFootage: 0, stakeLightingDifficulty: 'medium',
  miniLightItems: [], spritzers: [],
  wreaths: [
    { size: '24noble', tier: 'bow',       quantity: 2 },  // $200 × 2 = $400
    { size: '36noble', tier: 'fullDecor', quantity: 1 },  // $400 × 1 = $400
    { size: '60noble', tier: 'bow',       quantity: 1 },  // $885 × 1 = $885
  ],
  garland: [],
  takedown: 'included', rushFee: false,
};
// Expected: $400 + $400 + $885 = $1,685
printQuote('Job 8: Wreaths only', calculateQuote(job8));

// ─── Test 9: Garland only ────────────────────────────────────────────────────
const job9: QuoteInputs = {
  santasFootage: 0, santasDifficulty: 'easy',
  gingerbreadFootage: 0, gingerbreadDifficulty: 'easy',
  winterWonderlandFootage: 0, winterWonderlandDifficulty: 'easy',
  stakeLightingFootage: 0, stakeLightingDifficulty: 'medium',
  miniLightItems: [], spritzers: [], wreaths: [],
  garland: [
    { length: '9ft', type: 'noble', tier: 'bow',       quantity: 3 },  // $195 × 3 = $585
    { length: '9ft', type: 'noble', tier: 'fullDecor', quantity: 1 },  // $250 × 1 = $250
  ],
  takedown: 'included', rushFee: false,
};
// Expected: $585 + $250 = $835 → minimum $1,000
printQuote('Job 9: Garland only (minimum applies)', calculateQuote(job9));

// ─── Test 10: Full kitchen-sink — all three roofline types ───────────────────
const job10: QuoteInputs = {
  santasFootage: 130, santasDifficulty: 'medium',       // 130 × $10 = $1,300
  gingerbreadFootage: 80, gingerbreadDifficulty: 'easy', //  80 × $8  = $640
  winterWonderlandFootage: 0, winterWonderlandDifficulty: 'medium',
  stakeLightingFootage: 0, stakeLightingDifficulty: 'medium',
  miniLightItems: [
    { type: 'tree', wrapStyle: 'trunk',  stringCount: 4 },  // $180
    { type: 'bush', wrapStyle: 'canopy', stringCount: 2 },  // $70
  ],
  spritzers: [{ size: '24', quantity: 2 }],              // $190
  wreaths: [{ size: '30noble', tier: 'bow', quantity: 2 }],  // $610
  garland: [{ length: '9ft', type: 'noble', tier: 'fullDecor', quantity: 2 }],  // $500
  takedown: 'included', rushFee: false,
};
// Expected: $1,300 + $640 + $180 + $70 + $190 + $610 + $500 = $3,490
printQuote('Job 10: Kitchen-sink (all three roofline types)', calculateQuote(job10));

console.log('\n');
