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

// ─── Test 1: Simple santas job, easy roofline ────────────────────────────────
const job1: QuoteInputs = {
  rooflineFootage: 120,
  rooflineDifficulty: 'easy',
  rooflinePackage: 'santas',
  miniLightItems: [],
  spritzers: [],
  wreaths: [],
  garland: [],
  takedown: 'included',
  rushFee: false,
};
// Expected: 120 × $8 × 1.0 = $960 → bumped to minimum $1,000
printQuote('Job 1: Santas / easy / 120ft (minimum applies)', calculateQuote(job1));

// ─── Test 2: Gingerbread, medium difficulty ───────────────────────────────────
const job2: QuoteInputs = {
  rooflineFootage: 120,
  rooflineDifficulty: 'medium',
  rooflinePackage: 'gingerbread',
  miniLightItems: [],
  spritzers: [],
  wreaths: [],
  garland: [],
  takedown: 'included',
  rushFee: false,
};
// Expected: 120 × $10 × 1.4 = $1,680
printQuote('Job 2: Gingerbread / medium / 120ft', calculateQuote(job2));

// ─── Test 3: Winter Wonderland, hard, with rush + premium takedown ────────────
const job3: QuoteInputs = {
  rooflineFootage: 150,
  rooflineDifficulty: 'hard',
  rooflinePackage: 'winterWonderland',
  miniLightItems: [],
  spritzers: [],
  wreaths: [],
  garland: [],
  takedown: 'premium',
  rushFee: true,
  discount: { type: 'percentage', amount: 0.10 },
};
// Expected roofline: 150 × $12 × 1.8 = $3,240
// Discount (10%): -$324 → $2,916
// + Rush $150 + Premium takedown $150 = taxable $3,216
// Tax: $3,216 × 0.08625 = $277.38
// Total: $3,493.38 | Deposit: $1,746.69 | Balance: $1,746.69
printQuote('Job 3: Winter Wonderland / hard / 150ft + rush + premium takedown + 10% off', calculateQuote(job3));

// ─── Test 4: Mini lights only — trees + bushes, no roofline ─────────────────
const job4: QuoteInputs = {
  rooflineFootage: 0,
  rooflineDifficulty: 'easy',
  rooflinePackage: 'santas',
  miniLightItems: [
    { type: 'tree', wrapStyle: 'trunk',  stringCount: 4 },  // $45 × 4 = $180
    { type: 'tree', wrapStyle: 'trunk',  stringCount: 3 },  // $45 × 3 = $135
    { type: 'bush', wrapStyle: 'canopy', stringCount: 2 },  // $35 × 2 = $70
    { type: 'bush', wrapStyle: 'canopy', stringCount: 2 },  // $35 × 2 = $70
    { type: 'bush', wrapStyle: 'canopy', stringCount: 2 },  // $35 × 2 = $70
  ],
  spritzers: [],
  wreaths: [],
  garland: [],
  takedown: 'included',
  rushFee: false,
};
// Expected: $180 + $135 + $70 + $70 + $70 = $525 → bumped to minimum $1,000
printQuote('Job 4: Trees + bushes only (minimum applies)', calculateQuote(job4));

// ─── Test 5: Combo — roofline + trees + columns ──────────────────────────────
const job5: QuoteInputs = {
  rooflineFootage: 100,
  rooflineDifficulty: 'medium',
  rooflinePackage: 'gingerbread',
  miniLightItems: [
    { type: 'tree',   wrapStyle: 'trunk',  stringCount: 5 },  // $45 × 5 = $225
    { type: 'column', wrapStyle: 'canopy', stringCount: 2 },  // $35 × 2 = $70
    { type: 'column', wrapStyle: 'canopy', stringCount: 2 },  // $35 × 2 = $70
  ],
  spritzers: [],
  wreaths: [],
  garland: [],
  takedown: 'included',
  rushFee: false,
};
// Expected: roofline 100 × $10 × 1.4 = $1,400
//           tree $225 + column $70 + column $70 = $365
//           subtotal $1,765
printQuote('Job 5: Gingerbread / medium / 100ft + 1 tree + 2 columns', calculateQuote(job5));

// ─── Test 6: Spritzers only ───────────────────────────────────────────────────
const job6: QuoteInputs = {
  rooflineFootage: 0,
  rooflineDifficulty: 'easy',
  rooflinePackage: 'santas',
  miniLightItems: [],
  spritzers: [
    { size: '16', quantity: 1 },   // $85 × 1 = $85   (singular label)
    { size: '24', quantity: 3 },   // $95 × 3 = $285
    { size: '32', quantity: 2 },   // $105 × 2 = $210
  ],
  wreaths: [],
  garland: [],
  takedown: 'included',
  rushFee: false,
};
// Expected: $85 + $285 + $210 = $580 → minimum $1,000
printQuote('Job 6: Spritzers only (minimum applies)', calculateQuote(job6));

// ─── Test 7: Roofline + mini lights + spritzers ───────────────────────────────
const job7: QuoteInputs = {
  rooflineFootage: 80,
  rooflineDifficulty: 'medium',
  rooflinePackage: 'santas',
  miniLightItems: [
    { type: 'tree', wrapStyle: 'trunk', stringCount: 4 },   // $45 × 4 = $180
    { type: 'bush', wrapStyle: 'canopy', stringCount: 2 },  // $35 × 2 = $70
  ],
  spritzers: [
    { size: '24', quantity: 2 },  // $95 × 2 = $190
  ],
  wreaths: [],
  garland: [],
  takedown: 'included',
  rushFee: false,
};
// Expected: roofline 80 × $10 × 1.0 = $800
//           tree $180 + bush $70 = $250
//           spritzers $190
//           subtotal $1,240
printQuote('Job 7: Santas / medium / 80ft + tree + bush + 2×24" spritzers', calculateQuote(job7));

// ─── Test 8: Wreaths only ────────────────────────────────────────────────────
const job8: QuoteInputs = {
  rooflineFootage: 0,
  rooflineDifficulty: 'easy',
  rooflinePackage: 'santas',
  miniLightItems: [],
  spritzers: [],
  wreaths: [
    { size: '24noble',  tier: 'bow',      quantity: 2 },  // $230 × 2 = $460
    { size: '36noble',  tier: 'fullDecor', quantity: 1 },  // $400 × 1 = $400
    { size: '36oregon', tier: 'labor',    quantity: 1 },  // $298 × 1 = $298
  ],
  garland: [],
  takedown: 'included',
  rushFee: false,
};
// Expected: $460 + $400 + $298 = $1,158
printQuote('Job 8: Wreaths only', calculateQuote(job8));

// ─── Test 9: Garland only ────────────────────────────────────────────────────
const job9: QuoteInputs = {
  rooflineFootage: 0,
  rooflineDifficulty: 'easy',
  rooflinePackage: 'santas',
  miniLightItems: [],
  spritzers: [],
  wreaths: [],
  garland: [
    { length: '9ft', type: 'noble', tier: 'bow',      quantity: 3 },  // $195 × 3 = $585
    { length: '9ft', type: 'noble', tier: 'fullDecor', quantity: 1 },  // $250 × 1 = $250
  ],
  takedown: 'included',
  rushFee: false,
};
// Expected: $585 + $250 = $835 → minimum $1,000
printQuote('Job 9: Garland only (minimum applies)', calculateQuote(job9));

// ─── Test 10: Full kitchen-sink job ─────────────────────────────────────────
const job10: QuoteInputs = {
  rooflineFootage: 130,
  rooflineDifficulty: 'medium',
  rooflinePackage: 'gingerbread',
  miniLightItems: [
    { type: 'tree', wrapStyle: 'trunk',  stringCount: 4 },  // $45 × 4 = $180
    { type: 'bush', wrapStyle: 'canopy', stringCount: 2 },  // $35 × 2 = $70
  ],
  spritzers: [
    { size: '24', quantity: 2 },  // $95 × 2 = $190
  ],
  wreaths: [
    { size: '30noble', tier: 'bow', quantity: 2 },  // $305 × 2 = $610
  ],
  garland: [
    { length: '9ft', type: 'noble', tier: 'fullDecor', quantity: 2 },  // $250 × 2 = $500
  ],
  takedown: 'included',
  rushFee: false,
};
// Expected: roofline 130 × $10 × 1.4 = $1,820
//           tree $180 + bush $70 = $250
//           spritzers $190
//           wreaths $610
//           garland $500
//           subtotal $3,370
printQuote('Job 10: Full kitchen-sink (all categories)', calculateQuote(job10));

console.log('\n');
