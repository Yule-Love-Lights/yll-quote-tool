/* scripts/homeworks-migrate.ts — write one Homeworks record into the quote tool.
 *
 * Phase 3+ of the Homeworks migration. Records history; it does NOT simulate a
 * live sale. Nothing here messages a customer, moves a GoHighLevel card,
 * accrues referral credit or mints a referral code — the three side effects
 * convert-to-job would have fired are simply never invoked, because this writes
 * the end state directly rather than driving the booking route.
 *
 * Usage:
 *   npx tsx scripts/homeworks-migrate.ts --only "Rodney Smith"          # DRY RUN
 *   npx tsx scripts/homeworks-migrate.ts --only "Rodney Smith" --live   # writes
 *
 * MONEY RULE: every figure is taken verbatim from Homeworks and never
 * recomputed. Measured 2026-08-28: the pricing engine cannot reproduce the
 * charged tax on 8 of 14 invoices — Homeworks taxes PER LINE and rounds each
 * (Rodney's $2,650 line taxes to $2,881.87, half-cent rounded DOWN), three
 * invoices carry two different rates, and one rate is not recoverable from the
 * document at all. So the QuoteResult is built by hand with the charged
 * subtotal / tax / total, and `resolveAgreedTotal` reads `result.total` — the
 * exact Homeworks figure — as the agreed amount. staff-approve's snapshot
 * shape is mirrored (packageId 'D' + every billable line) but deliberately
 * carries no currentTotalUsd, so nothing overrides that number.
 *
 * The original Homeworks figures are stored under approval_snapshot.homeworks
 * so migrated revenue stays separable from money taken in this tool, and the
 * historical breakdown survives for good.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnvLocal(): void {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      if (process.env[m[1]]) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[m[1]] = val;
    }
  } catch {
    /* ambient env */
  }
}
loadEnvLocal();

import { saveQuote, type Customer } from '@/lib/quotes';
import { createJobFromQuote } from '@/lib/jobs';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { buildPortalLineItems, billableLineItemIds } from '@/lib/portal/adapter';
import type { QuoteInputs, QuoteResult, LineItem } from '@/lib/pricing/pricingEngine';
import type { ServiceType } from '@/lib/serviceType';

const LIVE = process.argv.includes('--live');
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

type Record = {
  name: string;
  serviceType: ServiceType;
  ghlContactId: string;
  customer: Customer;
  /** Verbatim from Homeworks — never recomputed. */
  hw: {
    doc: string;
    date: string;
    subtotal: number;
    discount: number;
    tax: number;
    lateFee: number;
    total: number;
    paid: number;
    due: number;
    installOwed: boolean;
  };
  lines: { label: string; amount: number }[];
};

const RECORDS: Record[] = [
  {
    name: 'Rodney Smith',
    serviceType: 'permanent_bistro',
    ghlContactId: 'Is8to3QZr3B1yolME1Ph',
    customer: {
      name: 'Rodney Smith',
      address: '72 Anndom Ct, NY',
      phone: '+15166607639',
      email: 'rsmith7@gmail.com',
    },
    hw: {
      doc: 'Homeworks invoice #10',
      date: '2026-06-07',
      subtotal: 7450.0,
      discount: 0.0,
      tax: 651.87,
      lateFee: 0.0,
      total: 8101.87,
      paid: 8101.87,
      due: 0.0,
      installOwed: false,
    },
    lines: [
      { label: 'Bistro Lights', amount: 4800.0 },
      { label: 'Landscape Lighting', amount: 2650.0 },
    ],
  },
];

/** A QuoteResult carrying the CHARGED figures. Nothing here is computed from a
 *  rate — see the money rule in this file's header. */
function buildResult(rec: Record): QuoteResult {
  const lineItems: LineItem[] = rec.lines.map((l, i) => ({
    label: l.label,
    amount: l.amount,
    id: `hw-${rec.hw.doc.replace(/\D/g, '')}-${i + 1}`,
  }));
  const afterDiscount = round2(rec.hw.subtotal - rec.hw.discount);
  return {
    lineItems,
    subtotalBeforeDiscount: rec.hw.subtotal,
    discountAmount: rec.hw.discount,
    earlyInstallDiscountAmount: 0,
    subtotalAfterDiscount: afterDiscount,
    minimumApplied: false,
    rushFeeAmount: 0,
    // The late fee is real money on the invoice and has nowhere else to live in
    // this shape; it rides as a takedown-slot amount ONLY when non-zero, and is
    // recorded verbatim under approval_snapshot.homeworks either way.
    takedownAmount: rec.hw.lateFee,
    taxableAmount: afterDiscount,
    taxAmount: rec.hw.tax,
    total: rec.hw.total,
    depositAmount: rec.hw.paid,
    balanceDue: rec.hw.due,
    rooflineChoice: 'none',
    rooflineOptions: { santas: null, gingerbread: null },
  } as QuoteResult;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildInputs(rec: Record): QuoteInputs {
  return {
    customLineItems: rec.lines.map((l, i) => ({
      id: `hw-${i + 1}`,
      label: l.label,
      amount: l.amount,
    })),
    takedown: 'none',
    rushFee: false,
  } as unknown as QuoteInputs;
}

async function migrate(rec: Record) {
  const result = buildResult(rec);
  const inputs = buildInputs(rec);

  console.log(`\n─── ${rec.name} — ${rec.hw.doc} ───`);
  console.log(`  service type      ${rec.serviceType}`);
  console.log(`  subtotal          ${rec.hw.subtotal.toFixed(2)}`);
  console.log(`  discount          ${rec.hw.discount.toFixed(2)}`);
  console.log(`  tax               ${rec.hw.tax.toFixed(2)}`);
  console.log(`  late fee          ${rec.hw.lateFee.toFixed(2)}`);
  console.log(`  TOTAL             ${rec.hw.total.toFixed(2)}`);
  console.log(`  deposit recorded  ${rec.hw.paid.toFixed(2)}`);
  console.log(`  balance           ${rec.hw.due.toFixed(2)}`);
  console.log(`  lines             ${rec.lines.map((l) => `${l.label} $${l.amount.toFixed(2)}`).join(' · ')}`);

  // Arithmetic gate — refuse to write a record that does not close.
  const closes = round2(rec.hw.subtotal - rec.hw.discount + rec.hw.tax + rec.hw.lateFee);
  if (Math.abs(closes - rec.hw.total) > 0.005) {
    throw new Error(`${rec.name}: ${closes.toFixed(2)} != total ${rec.hw.total.toFixed(2)}`);
  }
  if (Math.abs(round2(rec.hw.paid + rec.hw.due) - rec.hw.total) > 0.005) {
    throw new Error(`${rec.name}: paid + due != total`);
  }
  const lineSum = round2(rec.lines.reduce((a, l) => a + l.amount, 0));
  if (Math.abs(lineSum - rec.hw.subtotal) > 0.005) {
    throw new Error(`${rec.name}: line items ${lineSum.toFixed(2)} != subtotal ${rec.hw.subtotal.toFixed(2)}`);
  }
  console.log('  ✓ arithmetic closes');

  if (!LIVE) {
    console.log('  (dry run — nothing written)');
    return;
  }

  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service client not configured');

  const saved = await saveQuote(
    rec.customer,
    inputs,
    result,
    rec.serviceType,
    false,
    null,
    null,
    rec.ghlContactId,
  );
  const quoteId = (saved as { id?: string } | null)?.id;
  if (!quoteId) throw new Error(`${rec.name}: saveQuote returned no id`);
  console.log(`  created quote ${quoteId}`);

  // The lifecycle stamps, written directly rather than through mark-sent /
  // staff-approve / convert-to-job. Same end state, none of the side effects.
  const portal = buildPortalLineItems(result);
  const selectedItemIds = portal ? billableLineItemIds(portal.lineItems, portal.roofline) : [];
  const stamp = new Date(`${rec.hw.date}T12:00:00Z`).toISOString();
  const snapshot = {
    staffApproved: { at: stamp, by: 'homeworks-migration' },
    ...(selectedItemIds.length ? { customerSelection: { packageId: 'D' as const, selectedItemIds } } : {}),
    homeworks: { ...rec.hw, migratedAt: new Date().toISOString() },
  };

  const { error } = await sb
    .from('quotes')
    .update({
      quote_sent_at: stamp,
      customer_approved_at: stamp,
      deposit_paid_at: stamp,
      deposit_amount_usd: rec.hw.paid,
      status: 'booked',
      approval_snapshot: snapshot,
    })
    .eq('id', quoteId);
  if (error) throw new Error(`${rec.name}: lifecycle update failed — ${error.message}`);
  console.log('  stamped sent / approved / booked');

  const job = await createJobFromQuote(quoteId);
  console.log(job ? `  created job ${job.id} (status ${job.status})` : '  ⚠ job not created');

  const { data: check } = await sb
    .from('quotes')
    .select('quote_number, status, total, deposit_amount_usd, customer_approved_at, deposit_paid_at')
    .eq('id', quoteId)
    .maybeSingle();
  console.log('  read back:', JSON.stringify(check));
}

async function main() {
  console.log(LIVE ? '*** LIVE — PROD WRITES ***' : 'DRY RUN — nothing will be written');
  const todo = ONLY ? RECORDS.filter((r) => r.name === ONLY) : RECORDS;
  if (!todo.length) throw new Error(`no record matches --only "${ONLY}"`);
  for (const rec of todo) await migrate(rec);
  if (!LIVE) console.log('\nRe-run with --live to apply.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
