/* scripts/homeworks-migrate-all.ts — write the Homeworks records into the tool.
 *
 * Reads the gated record set (hw_records.json), which was assembled from the
 * Homeworks PDFs and checked to sum to $34,874.00 billed / $26,467.85 collected
 * / $8,406.15 outstanding, plus the five accepted-but-uninvoiced estimates.
 *
 * Usage:
 *   npx tsx scripts/homeworks-migrate-all.ts                 # DRY RUN
 *   npx tsx scripts/homeworks-migrate-all.ts --live          # writes
 *   npx tsx scripts/homeworks-migrate-all.ts --only inv6     # one record by key
 *
 * WHAT IT DOES NOT DO. It never drives the send / approve / book routes, so the
 * GoHighLevel card move, referral accrual and referral-code mint that
 * convert-to-job fires are never invoked at all. No customer is messaged.
 *
 * MONEY RULE. Every figure is Homeworks', verbatim. The pricing engine cannot
 * reproduce the charged tax on 8 of 14 invoices (per-line rounding, two rates
 * on one invoice, one rate absent from the document), so the QuoteResult is
 * built by hand and `resolveAgreedTotal` reads result.total as the agreed
 * amount. The original figures are also stored under approval_snapshot.homeworks
 * so migrated revenue stays separable and the breakdown survives.
 *
 * THREE PATHS.
 *   create  — no quote exists yet (saveQuote, then stamp the lifecycle)
 *   update  — a draft/approved quote exists; its money and lifecycle are set
 *   settled — Asharib #1000 only: a COMPLETED job whose invoice is already
 *             paid. Jason ruled 2026-08-28 to correct it down to the Homeworks
 *             figure ($1,783.50 -> $1,658.92); the invoice is corrected in the
 *             same pass so quote and invoice cannot disagree, and both prior
 *             values are recorded on the quote before they change.
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
import { createJobFromQuote, setJobStatus } from '@/lib/jobs';
import { createInvoiceFromJob, setInvoiceStatus } from '@/lib/invoices';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { buildPortalLineItems, billableLineItemIds } from '@/lib/portal/adapter';
import type { QuoteInputs, QuoteResult, LineItem } from '@/lib/pricing/pricingEngine';
import type { ServiceType } from '@/lib/serviceType';

const LIVE = process.argv.includes('--live');
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

const RECORDS_PATH =
  'C:/Users/Jason/AppData/Local/Temp/claude/' +
  'C--Users-Jason-Desktop-YuleLoveLights-yll-quote-tool/' +
  '072eb17d-559f-4c7c-a104-90d43e049dd8/scratchpad/hw_records.json';

type Rec = {
  key: string;
  name: string;
  serviceType: ServiceType;
  ghlContactId: string;
  customer: Customer;
  existingQuoteNumber: number | null;
  installOwed: boolean;
  isNce: boolean;
  hw: {
    doc: string; date: string; subtotal: number; discount: number; tax: number;
    lateFee: number; total: number; paid: number; due: number; note?: string;
  };
  lines: { label: string; amount: number }[];
};

const r2 = (n: number) => Math.round((n + 1e-9) * 100) / 100;

function buildResult(rec: Rec): QuoteResult {
  const lineItems: LineItem[] = rec.lines.map((l, i) => ({
    label: l.label,
    amount: l.amount,
    id: `hw-${rec.key}-${i + 1}`,
  }));
  const afterDiscount = r2(rec.hw.subtotal - rec.hw.discount);
  return {
    lineItems,
    subtotalBeforeDiscount: rec.hw.subtotal,
    discountAmount: rec.hw.discount,
    earlyInstallDiscountAmount: 0,
    subtotalAfterDiscount: afterDiscount,
    minimumApplied: false,
    rushFeeAmount: 0,
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

const buildInputs = (rec: Rec): QuoteInputs =>
  ({
    customLineItems: rec.lines.map((l, i) => ({ id: `hw-${i + 1}`, label: l.label, amount: l.amount })),
    takedown: 'none',
    rushFee: false,
  } as unknown as QuoteInputs);

function checkArithmetic(rec: Rec) {
  const h = rec.hw;
  if (Math.abs(r2(h.subtotal - h.discount + h.tax + h.lateFee) - h.total) > 0.005) {
    throw new Error(`${rec.key}: does not close`);
  }
  if (Math.abs(r2(h.paid + h.due) - h.total) > 0.005) throw new Error(`${rec.key}: paid+due != total`);
  const s = r2(rec.lines.reduce((a, l) => a + l.amount, 0));
  if (Math.abs(s - h.subtotal) > 0.005) throw new Error(`${rec.key}: lines != subtotal`);
}

async function migrate(rec: Rec) {
  checkArithmetic(rec);
  const h = rec.hw;
  const mode = rec.existingQuoteNumber ? `update #${rec.existingQuoteNumber}` : 'create';
  const close = rec.installOwed ? 'install owed' : 'CLOSE OUT (install done)';
  console.log(
    `${rec.key.padEnd(13)} ${rec.name.padEnd(17)} ${mode.padEnd(13)} ${rec.serviceType.padEnd(16)}` +
      ` total ${h.total.toFixed(2).padStart(9)}  paid ${h.paid.toFixed(2).padStart(9)}` +
      `  due ${h.due.toFixed(2).padStart(8)}  ${rec.isNce ? 'NCE ' : ''}${close}`,
  );

  if (!LIVE) return;

  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service client not configured');
  const result = buildResult(rec);
  const inputs = buildInputs(rec);
  const stamp = new Date(`${h.date}T12:00:00Z`).toISOString();

  let quoteId: string;
  let prior: Record<string, unknown> | null = null;

  if (rec.existingQuoteNumber) {
    const { data: existing, error: readErr } = await sb
      .from('quotes')
      .select('id, total, deposit_amount_usd, status, service_type, highlevel_contact_id, approval_snapshot')
      .eq('quote_number', rec.existingQuoteNumber)
      .maybeSingle();
    if (readErr || !existing) throw new Error(`${rec.key}: quote #${rec.existingQuoteNumber} not found`);
    quoteId = (existing as { id: string }).id;
    // Prior values kept so a correction is never silent and is reversible by hand.
    prior = {
      total: (existing as { total: number | null }).total,
      depositAmountUsd: (existing as { deposit_amount_usd: number | null }).deposit_amount_usd,
      status: (existing as { status: string }).status,
      serviceType: (existing as { service_type: string }).service_type,
    };
  } else {
    const saved = await saveQuote(
      rec.customer, inputs, result, rec.serviceType, false, null, null, rec.ghlContactId,
    );
    const id = (saved as { id?: string } | null)?.id;
    if (!id) throw new Error(`${rec.key}: saveQuote returned no id`);
    quoteId = id;
  }

  const portal = buildPortalLineItems(result);
  const selectedItemIds = portal ? billableLineItemIds(portal.lineItems, portal.roofline) : [];
  const snapshot = {
    staffApproved: { at: stamp, by: 'homeworks-migration' },
    ...(selectedItemIds.length ? { customerSelection: { packageId: 'D' as const, selectedItemIds } } : {}),
    homeworks: { ...h, key: rec.key, migratedAt: new Date().toISOString(), ...(prior ? { priorTool: prior } : {}) },
  };

  const update: Record<string, unknown> = {
    inputs,
    result,
    total: h.total,
    service_type: rec.serviceType,
    quote_sent_at: stamp,
    customer_approved_at: stamp,
    deposit_paid_at: stamp,
    deposit_amount_usd: h.paid,
    status: 'booked',
    approval_snapshot: snapshot,
    customer_name: rec.customer.name,
    customer_email: rec.customer.email,
    customer_phone: rec.customer.phone,
    customer_address: rec.customer.address,
  };
  if (rec.isNce) update.is_nce = true;
  if (rec.existingQuoteNumber) update.highlevel_contact_id = rec.ghlContactId;

  const { error: upErr } = await sb.from('quotes').update(update).eq('id', quoteId);
  if (upErr) throw new Error(`${rec.key}: quote update failed — ${upErr.message}`);

  const job = await createJobFromQuote(quoteId);
  if (!job) throw new Error(`${rec.key}: job not created`);

  // ── Close out a job whose install is already done ────────────────────────
  if (!rec.installOwed) {
    let j = job;
    if (j.status === 'to_schedule' || j.status === 'scheduled') {
      j = (await setJobStatus(j.id, 'installed')) ?? j;
    }
    if (j.status === 'installed') j = (await setJobStatus(j.id, 'requires_invoicing')) ?? j;

    const invoice = await createInvoiceFromJob(j.id);
    if (!invoice) throw new Error(`${rec.key}: invoice not created`);

    // Asharib #1000 arrives with an invoice that predates this migration and is
    // already settled at the OLD figure. createInvoiceFromJob is idempotent and
    // returns it untouched, so correct it here, in the same pass as the quote.
    const wantTotal = h.total;
    if (Math.abs(Number(invoice.total) - wantTotal) > 0.005) {
      const { error: invErr } = await sb
        .from('invoices')
        .update({
          subtotal: h.subtotal,
          discount: h.discount,
          tax: h.tax,
          total: wantTotal,
          deposit_applied: h.paid,
          balance: h.due,
        })
        .eq('id', invoice.id);
      if (invErr) throw new Error(`${rec.key}: invoice correction failed — ${invErr.message}`);
      console.log(`    corrected invoice ${invoice.invoice_number}: ${invoice.total} -> ${wantTotal.toFixed(2)}`);
    }

    if (h.due <= 0.005) {
      // Asharib #1000 arrives already settled and already done: the lifecycle
      // helpers reject a same-state transition (paid -> paid), which aborted
      // the first run AFTER his invoice had been corrected. Only advance what
      // is actually behind.
      if (invoice.status !== 'paid') await setInvoiceStatus(invoice.id, 'paid');
      if (j.status !== 'done') await setJobStatus(j.id, 'done');
      console.log(`    closed: invoice ${invoice.invoice_number} paid, job done`);
    } else {
      console.log(`    invoice ${invoice.invoice_number} raised, balance ${h.due.toFixed(2)} outstanding`);
    }
  }

  const { data: check } = await sb
    .from('quotes')
    .select('quote_number, status, total, deposit_amount_usd')
    .eq('id', quoteId)
    .maybeSingle();
  console.log(`    -> ${JSON.stringify(check)}`);
}

async function main() {
  const all: Rec[] = JSON.parse(readFileSync(RECORDS_PATH, 'utf8'));
  const todo = ONLY ? all.filter((r) => r.key === ONLY) : all;
  if (!todo.length) throw new Error(`no record matches --only "${ONLY}"`);

  console.log(LIVE ? '*** LIVE — PROD WRITES ***\n' : 'DRY RUN — nothing will be written\n');
  for (const rec of todo) await migrate(rec);

  const t = (f: 'total' | 'paid' | 'due') => r2(todo.reduce((a, r) => a + r.hw[f], 0));
  console.log(`\n${todo.length} records · contracted ${t('total').toFixed(2)} · collected ${t('paid').toFixed(2)} · outstanding ${t('due').toFixed(2)}`);
  if (!LIVE) console.log('\nRe-run with --live to apply.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
