// Invoices data layer — the money tail of the Jobber-flow (ledger #83, Phase 3).
//
// An invoice is auto-created when a job is marked installed/complete. It is the
// FULL total with the ALREADY-PAID deposit applied as a payment →
// balance = max(0, total − deposit). The deposit applied is the actual amount
// charged at booking (quotes.deposit_amount_usd) — NOT a recomputed 50% — so an
// amended order (Phase 4) invoices correctly and consistently with that phase's
// `new_balance = max(0, new_total − deposit_paid)`.
//
// SPEC §4.3 + PLAN Phase 3. Migration: migrations/2026-06-27-invoices.sql.
//
// The totals math (computeInvoiceTotals) is PURE and unit-tested. The DB helpers
// are thin; createInvoiceFromJob is idempotent on job_id (in-code guard + the
// partial unique index backstop), mirroring createJobFromQuote.
//
// ⚠️ NOT here: the balance COLLECTION (auto-charge the vault card vs send a
// portal pay-link). That moves real money, is gated on #81, and the auto-charge
// mechanism is an open decision (the current Valor integration does deposits via
// Passage.js / hosted-page and explicitly builds "no auto-charge" — a
// server-side card-on-file sale needs a Valor MIT capability + Jason's
// integration). src/lib/balanceCollection.ts encodes only the pure ROUTING
// (which path applies); execution is deferred.

import { getSupabaseServiceClient, getSupabaseClient } from './supabase';
import { allocateNumber } from './displayId';
import { canTransition, type InvoiceStatus } from './invoiceStatus';

export type InvoiceRow = {
  id: string;
  invoice_number: number | null;
  job_id: string | null;
  quote_id: string | null;
  customer_id: string | null;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  deposit_applied: number;
  balance: number;
  credit_note: number;
  tax_overridden: boolean;
  status: InvoiceStatus;
  valor_balance_txn_id: string | null;
  valor_receipt_url: string | null;
  created_at: string;
  paid_at: string | null;
  updated_at: string;
};

const INVOICE_SELECT =
  'id, invoice_number, job_id, quote_id, customer_id, subtotal, discount, tax, total, ' +
  'deposit_applied, balance, credit_note, tax_overridden, status, valor_balance_txn_id, ' +
  'valor_receipt_url, created_at, paid_at, updated_at';

// ─── Pure totals math ───────────────────────────────────────────────────────

// Round to cents — money never carries float dust into a stored balance (mirrors
// Phase 4's amend rounding). Non-finite coerces to 0 so a malformed legacy result
// can't write NaN.
function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// The subset of a priced QuoteResult the invoice needs. Accepting a subset (not
// the full QuoteResult) keeps the math testable + decoupled; the real
// QuoteResult satisfies it structurally.
export type InvoicePricingInput = {
  subtotalBeforeDiscount?: number;
  discountAmount?: number;
  earlyInstallDiscountAmount?: number;
  taxAmount?: number;
  total: number;
};

export type InvoiceTotals = {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  deposit_applied: number;
  balance: number;
  credit_note: number;
};

/**
 * Compute an invoice's money breakdown from a priced quote result + the deposit
 * ACTUALLY paid. PURE.
 *
 *   total          = the quote total (minus the tax line when tax_overridden)
 *   deposit_applied = the actual deposit paid (clamped ≥ 0)
 *   balance        = max(0, total − deposit_applied)
 *   credit_note    = max(0, deposit_applied − total)   (overpayment → manual refund)
 *
 * The balance is CLAMPED at ≥ 0: if the deposit already covers (or exceeds) the
 * total — e.g. an amended-down order — the balance is 0 and the overpayment
 * surfaces as a credit_note for a manual Valor refund (no refund integration).
 */
export function computeInvoiceTotals(
  pricing: InvoicePricingInput,
  depositPaidUsd: number,
  opts: { taxOverridden?: boolean } = {},
): InvoiceTotals {
  const overridden = opts.taxOverridden === true;
  const fullTax = round2(pricing.taxAmount ?? 0);

  const subtotal = round2(pricing.subtotalBeforeDiscount ?? 0);
  const discount = round2((pricing.discountAmount ?? 0) + (pricing.earlyInstallDiscountAmount ?? 0));
  const tax = overridden ? 0 : fullTax;
  // Overriding tax removes exactly the tax line from the total.
  const total = round2(overridden ? round2(pricing.total) - fullTax : pricing.total);

  const deposit_applied = round2(Math.max(0, depositPaidUsd));
  const balance = round2(Math.max(0, total - deposit_applied));
  const credit_note = round2(Math.max(0, deposit_applied - total));

  return { subtotal, discount, tax, total, deposit_applied, balance, credit_note };
}

// ─── DB helpers ─────────────────────────────────────────────────────────────

function sb() {
  return getSupabaseServiceClient() ?? getSupabaseClient();
}

export async function getInvoice(id: string): Promise<InvoiceRow | null> {
  const db = sb();
  if (!db) return null;
  const { data, error } = await db.from('invoices').select(INVOICE_SELECT).eq('id', id).maybeSingle();
  if (error) {
    console.error('getInvoice error:', error);
    return null;
  }
  return (data as InvoiceRow | null) ?? null;
}

/** The single invoice for a job, if one has been created. */
export async function getInvoiceByJob(jobId: string): Promise<InvoiceRow | null> {
  const db = sb();
  if (!db) return null;
  const { data, error } = await db
    .from('invoices')
    .select(INVOICE_SELECT)
    .eq('job_id', jobId)
    .maybeSingle();
  if (error) {
    console.error('getInvoiceByJob error:', error);
    return null;
  }
  return (data as InvoiceRow | null) ?? null;
}

export async function listInvoices(limit = 500): Promise<InvoiceRow[]> {
  const db = sb();
  if (!db) return [];
  const { data, error } = await db
    .from('invoices')
    .select(INVOICE_SELECT)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('listInvoices error:', error);
    return [];
  }
  return (data ?? []) as unknown as InvoiceRow[];
}

// The minimal shapes createInvoiceFromJob reads.
type JobForInvoice = { id: string; quote_id: string | null; customer_id: string | null };
type QuoteForInvoice = {
  id: string;
  result: (InvoicePricingInput & { depositAmount?: number }) | null;
  deposit_amount_usd: number | null;
  deposit_paid_at: string | null;
};

/**
 * Auto-create an invoice from a completed job. IDEMPOTENT: returns the existing
 * invoice if one already exists for the job (the partial unique index on job_id
 * is the DB backstop). Returns null if Supabase isn't configured, the job/quote
 * doesn't exist, or the job has no quote.
 *
 * Snapshots the money breakdown from the quote's priced result with the actual
 * paid deposit applied (quotes.deposit_amount_usd; falls back to the computed
 * 50% only for a legacy row missing it; 0 if the deposit was never paid).
 * Allocates an invoice_number (best-effort) and starts at `draft`.
 */
export async function createInvoiceFromJob(jobId: string): Promise<InvoiceRow | null> {
  const db = sb();
  if (!db) return null;

  const existing = await getInvoiceByJob(jobId);
  if (existing) return existing;

  const { data: job, error: jErr } = await db
    .from('jobs')
    .select('id, quote_id, customer_id')
    .eq('id', jobId)
    .maybeSingle<JobForInvoice>();
  if (jErr) {
    console.error('createInvoiceFromJob: job read error:', jErr);
    return null;
  }
  if (!job) {
    console.warn(`createInvoiceFromJob: no job ${jobId}`);
    return null;
  }
  if (!job.quote_id) {
    console.warn(`createInvoiceFromJob: job ${jobId} has no quote`);
    return null;
  }

  const { data: quote, error: qErr } = await db
    .from('quotes')
    .select('id, result, deposit_amount_usd, deposit_paid_at')
    .eq('id', job.quote_id)
    .maybeSingle<QuoteForInvoice>();
  if (qErr) {
    console.error('createInvoiceFromJob: quote read error:', qErr);
    return null;
  }
  if (!quote) {
    console.warn(`createInvoiceFromJob: no quote ${job.quote_id}`);
    return null;
  }

  const result = quote.result ?? { total: 0 };
  // The deposit ACTUALLY applied: the durable charged amount when the deposit was
  // confirmed paid; the computed 50% only as a legacy fallback; 0 if never paid.
  const depositPaid = quote.deposit_paid_at
    ? quote.deposit_amount_usd ?? result.depositAmount ?? 0
    : 0;

  const totals = computeInvoiceTotals(result, depositPaid, { taxOverridden: false });

  // Best-effort display number — a failed allocation (sequence missing
  // pre-migration) must NOT block the invoice; the column is nullable.
  let invoiceNumber: number | null = null;
  try {
    invoiceNumber = await allocateNumber('invoice_number_seq');
  } catch (err) {
    console.warn('createInvoiceFromJob: invoice_number allocation skipped:', err);
  }

  const { data, error } = await db
    .from('invoices')
    .insert({
      job_id: job.id,
      quote_id: job.quote_id,
      customer_id: job.customer_id ?? null,
      subtotal: totals.subtotal,
      discount: totals.discount,
      tax: totals.tax,
      total: totals.total,
      deposit_applied: totals.deposit_applied,
      balance: totals.balance,
      credit_note: totals.credit_note,
      tax_overridden: false,
      status: 'draft' satisfies InvoiceStatus,
      ...(invoiceNumber != null ? { invoice_number: invoiceNumber } : {}),
    })
    .select(INVOICE_SELECT)
    .single();

  if (error) {
    console.error('createInvoiceFromJob: insert error:', error);
    return null;
  }
  return data as unknown as InvoiceRow;
}

/**
 * Move an invoice to a new status, guarded by the legal-transition table
 * (src/lib/invoiceStatus.ts). Throws on an illegal transition (a programmer/UI
 * error). Stamps `paid_at` when reaching `paid`. Returns null if Supabase isn't
 * configured or the invoice doesn't exist.
 */
export async function setInvoiceStatus(id: string, to: InvoiceStatus): Promise<InvoiceRow | null> {
  const db = sb();
  if (!db) return null;

  const current = await getInvoice(id);
  if (!current) return null;

  if (!canTransition(current.status, to)) {
    throw new Error(`setInvoiceStatus: illegal transition ${current.status} → ${to} (invoice ${id})`);
  }

  const patch: Record<string, unknown> = { status: to };
  if (to === 'paid') patch.paid_at = new Date().toISOString();

  const { data, error } = await db
    .from('invoices')
    .update(patch)
    .eq('id', id)
    .select(INVOICE_SELECT)
    .single();
  if (error) {
    console.error('setInvoiceStatus error:', error);
    return null;
  }
  return data as unknown as InvoiceRow;
}
