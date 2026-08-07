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
// #110 W1-064: the EPSILON-nudged + finite-guarded round-to-cents lives in one
// place now (was copy-pasted here / amend.ts / balanceCollection.ts). Aliased to
// `round2` so the call sites are byte-identical.
import { roundMoneyGuarded as round2 } from './money';
import { resolveAgreedTotal, type AgreedTotalSnapshot } from './agreedTotal';

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
  // #170(b): charge records retired when an amend reopened a PAID invoice —
  // the live txn slot clears for the new charge cycle, the old txn stays here
  // for Valor reconciliation. Entries: { txnId, receiptUrl, settledAt, retiredAt, reason }.
  valor_txn_log: RetiredTxnEntry[] | null;
  // #170(d): how this customer settles the balance. 'cash_check' replaces the
  // one-click card charge with an explicit override (never charge a card the
  // customer said they'd settle in cash). null = unset (no gating).
  payment_preference: PaymentPreference | null;
  // #199: how a MANUALLY-settled invoice (mark-paid, not a Valor charge) was
  // actually collected. null covers both a legacy manual mark-paid (predates
  // this column) and a Valor-settled invoice (never written by the balance
  // webhook / charge-balance route) — see migrations/2026-08-07-invoices-
  // manual-payment-method.sql. Optional: the column ships migration-first, so
  // a pre-migration select simply omits the key rather than erroring.
  paid_method?: PaidMethod | null;
  // #199: the NCE trade-system payment reference number. Required at NCE
  // mark-paid time (app-enforced, not a DB constraint); editable afterward
  // for a typo fix. Optional for the same pre-migration-tolerant reason.
  payment_reference?: string | null;
  created_at: string;
  paid_at: string | null;
  updated_at: string;
};

export type PaymentPreference = 'card_on_file' | 'cash_check';

// #199: how a manually-settled (mark-paid) invoice was actually collected.
export type PaidMethod = 'cash_check' | 'nce';

export type RetiredTxnEntry = {
  txnId: string;
  receiptUrl: string | null;
  settledAt: string | null;
  retiredAt: string;
  reason: string;
};

const INVOICE_SELECT =
  'id, invoice_number, job_id, quote_id, customer_id, subtotal, discount, tax, total, ' +
  'deposit_applied, balance, credit_note, tax_overridden, status, valor_balance_txn_id, ' +
  'valor_receipt_url, valor_txn_log, payment_preference, paid_method, payment_reference, ' +
  'created_at, paid_at, updated_at';

// ─── Pure totals math ───────────────────────────────────────────────────────

// The subset of a priced QuoteResult the invoice needs. Accepting a subset (not
// the full QuoteResult) keeps the math testable + decoupled; the real
// QuoteResult satisfies it structurally.
export type InvoicePricingInput = {
  subtotalBeforeDiscount?: number;
  discountAmount?: number;
  earlyInstallDiscountAmount?: number;
  // B4 fix: rush install + premium takedown fees are part of the total but were
  // previously omitted from the breakdown, causing Subtotal − Discount + Tax ≠ Total.
  rushFeeAmount?: number;
  takedownAmount?: number;
  taxAmount?: number;
  total: number;
};

export type InvoiceTotals = {
  subtotal: number;
  discount: number;
  /** Combined rush-install + premium-takedown fees (0 when neither applies). */
  fees: number;
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
  // B4 fix: rush install + premium takedown fees are added to taxableAmount by the
  // pricing engine (pricingEngine.ts:753) and therefore included in the total. They
  // must appear in the breakdown so Subtotal − Discount + Fees + Tax === Total.
  const fees = round2((pricing.rushFeeAmount ?? 0) + (pricing.takedownAmount ?? 0));
  const tax = overridden ? 0 : fullTax;
  // Overriding tax removes exactly the tax line from the total.
  const total = round2(overridden ? round2(pricing.total) - fullTax : pricing.total);

  const deposit_applied = round2(Math.max(0, depositPaidUsd));
  const balance = round2(Math.max(0, total - deposit_applied));
  const credit_note = round2(Math.max(0, deposit_applied - total));

  return { subtotal, discount, fees, tax, total, deposit_applied, balance, credit_note };
}

// ─── Money reconciliation ────────────────────────────────────────────────────

export type InvoiceReconciliation = {
  /** The invoiced total (= quoted amount). */
  quoted: number;
  /** The deposit actually applied (from the stored deposit_applied column). */
  depositApplied: number;
  /** The balance still due (= invoice.balance). */
  balanceDue: number;
  /** Overpayment surfaced as a credit note (> 0 means a Valor refund is needed). */
  creditNote: number;
  /** True when the invoice status is 'paid'. */
  paid: boolean;
  /**
   * Actionable flags for the operator — zero or more of:
   *   'overpaid'            — credit_note > 0; a Valor refund is required.
   *   'short-deposit'       — deposit > 0 and short of what was actually INTENDED
   *                           (fat-finger / partial-auth). #177: per-quote deposit
   *                           percent means "40% of quoted" is no longer a safe
   *                           universal proxy for "intended" — see reconcileInvoice.
   *                           Not evaluated on a cancelled invoice (see reconcileInvoice).
   *   'balance-outstanding' — not paid and balance > 0 (informational).
   *                           Not evaluated on a cancelled invoice (see reconcileInvoice).
   *   'inconsistent'        — paid status but balance > 0 (data integrity error).
   */
  flags: string[];
};

/**
 * Derive a money-reconciliation summary from a stored InvoiceRow. PURE — no IO.
 *
 * Flags are additive: any combination can fire simultaneously.
 *
 * #177: short-deposit now compares the applied deposit against the quote's
 * OWN intended deposit (`intendedDepositUsd` — the linked quote's stamped
 * deposit_amount_usd, the actual amount that was supposed to be charged at
 * this quote's own deposit percent), not a blanket 50%-assumption threshold.
 * A tolerance of 80% of intended (not exactly 100%) still absorbs minor
 * rounding, mirroring the old 40%-of-50% ( = 80%-of-intended) spirit. When
 * intendedDepositUsd is unavailable (no linked quote, or a legacy quote
 * predating the deposit_amount_usd column), falls back to the old blanket
 * "< 40% of quoted" heuristic so a pre-#177 invoice keeps its existing behavior.
 *
 * WT-20 fix: setInvoiceStatus never zeroes the balance when an invoice is
 * cancelled, so a cancelled invoice keeps its original nonzero balance. The
 * collection-oriented flags ('balance-outstanding', 'short-deposit') are
 * skipped for a cancelled invoice so it doesn't read as "still owed" — the
 * only real action on a cancelled order is a manual refund, which the
 * 'overpaid' flag already covers when a credit_note exists.
 */
export function reconcileInvoice(inv: InvoiceRow, intendedDepositUsd?: number | null): InvoiceReconciliation {
  const quoted = inv.total;
  const depositApplied = inv.deposit_applied;
  const balanceDue = inv.balance;
  const creditNote = inv.credit_note;
  const paid = inv.status === 'paid';
  const cancelled = inv.status === 'cancelled';

  const flags: string[] = [];

  const intended = typeof intendedDepositUsd === 'number' ? intendedDepositUsd : null;
  const shortDeposit =
    depositApplied > 0 &&
    (intended != null && intended > 0
      ? depositApplied < intended * 0.8
      : depositApplied < 0.4 * quoted);

  if (creditNote > 0) flags.push('overpaid');
  if (!cancelled && shortDeposit) flags.push('short-deposit');
  if (!cancelled && !paid && balanceDue > 0) flags.push('balance-outstanding');
  if (paid && balanceDue > 0) flags.push('inconsistent');

  return { quoted, depositApplied, balanceDue, creditNote, paid, flags };
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

// The single invoice for a quote, if one has been created (a quote only ever
// links to one job, so this mirrors getInvoiceByJob's one-row contract). Ledger
// #87(a): the customer PDF route only knows the QUOTE id (the portal's
// capability token), so this is the quote→invoice resolution it needs.
export async function getInvoiceByQuote(quoteId: string): Promise<InvoiceRow | null> {
  const db = sb();
  if (!db) return null;
  const { data, error } = await db
    .from('invoices')
    .select(INVOICE_SELECT)
    .eq('quote_id', quoteId)
    .maybeSingle();
  if (error) {
    console.error('getInvoiceByQuote error:', error);
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

/**
 * PURE: merge invoice lists (e.g. one matched by customer_id, one by quote_id)
 * into a single de-duplicated, newest-first list. No IO — exported for direct
 * unit tests.
 */
export function mergeInvoicesNewestFirst(...lists: InvoiceRow[][]): InvoiceRow[] {
  const byId = new Map<string, InvoiceRow>();
  for (const list of lists) {
    for (const inv of list) byId.set(inv.id, inv);
  }
  return [...byId.values()].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

/**
 * Invoices belonging to a customer (the customer detail page, #58): matched by
 * EITHER the invoice's own customer_id OR its quote_id being one of the
 * customer's known quotes (the page's Quote history) — the second leg covers
 * legacy invoices whose customer_id is still null pre-backfill, mirroring
 * matchesCustomerRoute's dual match. Two queries + merge-dedupe
 * (mergeInvoicesNewestFirst) rather than a hand-built PostgREST `.or()` filter.
 * Returns [] when Supabase isn't configured or neither a customerId nor any
 * quoteIds are given.
 */
export async function listInvoicesForCustomer(
  customerId: string | null,
  quoteIds: string[],
): Promise<InvoiceRow[]> {
  const db = sb();
  if (!db) return [];
  if (!customerId && quoteIds.length === 0) return [];

  let byCustomer: InvoiceRow[] = [];
  if (customerId) {
    const { data, error } = await db.from('invoices').select(INVOICE_SELECT).eq('customer_id', customerId);
    if (error) console.error('listInvoicesForCustomer: customer_id query error:', error);
    else byCustomer = (data ?? []) as unknown as InvoiceRow[];
  }

  let byQuote: InvoiceRow[] = [];
  if (quoteIds.length) {
    const { data, error } = await db.from('invoices').select(INVOICE_SELECT).in('quote_id', quoteIds);
    if (error) console.error('listInvoicesForCustomer: quote_id query error:', error);
    else byQuote = (data ?? []) as unknown as InvoiceRow[];
  }

  return mergeInvoicesNewestFirst(byCustomer, byQuote);
}

// A billing-board row for the operator /admin/invoices list, with the linked
// quote's customer identity + is_test joined on. Test invoices stay VISIBLE here
// (badged) — only dashboard metrics exclude test data (#93).
export type InvoiceAdminCard = {
  id: string;
  invoiceNumber: number | null;
  jobId: string | null;
  quoteId: string | null;
  customerName: string | null;
  customerAddress: string | null;
  isTest: boolean;
  // #199: the linked quote's NCE tag — drives the NceBadge on the list row.
  isNce: boolean;
  total: number;
  depositApplied: number;
  balance: number;
  status: InvoiceStatus;
  createdAt: string;
  paidAt: string | null;
  // Customer detail-page route id fields (same precedence as QuoteListItem /
  // src/lib/dashboard/customers.ts customerRouteId: highlevel_contact_id, else
  // customer_id) — lets /admin/invoices link a customer name to their profile.
  // customerId prefers the invoice's OWN customer_id over the linked quote's,
  // mirroring JobAdminCard's precedence.
  highlevelContactId: string | null;
  customerId: string | null;
};

/**
 * The invoices list for the operator billing view (/admin/invoices) — every
 * invoice (newest first) with each linked quote's customer name/address +
 * is_test/is_nce joined. Returns [] when Supabase isn't configured.
 */
export async function listInvoicesForAdmin(limit = 500): Promise<InvoiceAdminCard[]> {
  const db = sb();
  if (!db) return [];

  const invoices = await listInvoices(limit);
  if (!invoices.length) return [];

  const quoteIds = [...new Set(invoices.map((i) => i.quote_id).filter((x): x is string => !!x))];
  const byQuote = new Map<
    string,
    { name: string | null; address: string | null; isTest: boolean; isNce: boolean; highlevelContactId: string | null; customerId: string | null }
  >();
  if (quoteIds.length) {
    const { data } = await db
      .from('quotes')
      .select('id, customer_name, customer_address, is_test, is_nce, highlevel_contact_id, customer_id')
      .in('id', quoteIds);
    for (const q of (data ?? []) as {
      id: string;
      customer_name: string | null;
      customer_address: string | null;
      is_test: boolean | null;
      is_nce: boolean | null;
      highlevel_contact_id: string | null;
      customer_id: string | null;
    }[]) {
      byQuote.set(q.id, {
        name: q.customer_name ?? null,
        address: q.customer_address ?? null,
        isTest: !!q.is_test,
        isNce: !!q.is_nce,
        highlevelContactId: q.highlevel_contact_id ?? null,
        customerId: q.customer_id ?? null,
      });
    }
  }

  return invoices.map((inv) => {
    const c = inv.quote_id ? byQuote.get(inv.quote_id) : undefined;
    return {
      id: inv.id,
      invoiceNumber: inv.invoice_number,
      jobId: inv.job_id,
      quoteId: inv.quote_id,
      customerName: c?.name ?? null,
      customerAddress: c?.address ?? null,
      isTest: c?.isTest ?? false,
      isNce: c?.isNce ?? false,
      total: inv.total,
      depositApplied: inv.deposit_applied,
      balance: inv.balance,
      status: inv.status,
      createdAt: inv.created_at,
      paidAt: inv.paid_at,
      highlevelContactId: c?.highlevelContactId ?? null,
      customerId: inv.customer_id ?? c?.customerId ?? null,
    };
  });
}

// The full billing detail for one invoice (/admin/invoices/[id]): the invoice, the
// linked quote's customer identity + is_test/is_nce, and the linked job's number/status.
export type InvoiceDetail = {
  invoice: InvoiceRow;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  isTest: boolean;
  // #199: the linked quote's NCE tag — gates the charge-button/send-balance-
  // link UI and the "Mark paid — NCE" affordance on the invoice detail page.
  isNce: boolean;
  jobNumber: number | null;
  jobStatus: string | null;
  // #177 fix 4: the linked quote's stamped deposit_amount_usd — the deposit
  // actually INTENDED to be collected at this quote's own deposit percent.
  // Fed into reconcileInvoice so 'short-deposit' compares against the real
  // intended amount instead of a blanket 40%-of-total heuristic. null when
  // there's no linked quote or the quote predates the column (legacy).
  // Optional for back-compat with any other hand-built InvoiceDetail fixture.
  intendedDepositUsd?: number | null;
};

/**
 * The billing detail for one invoice — the invoice + the linked quote's customer
 * identity + is_test/is_nce + the linked job's number/status. Returns null when
 * Supabase isn't configured or the invoice is missing.
 */
export async function getInvoiceDetail(id: string): Promise<InvoiceDetail | null> {
  const db = sb();
  if (!db) return null;

  const invoice = await getInvoice(id);
  if (!invoice) return null;

  let customerName: string | null = null;
  let customerEmail: string | null = null;
  let customerPhone: string | null = null;
  let customerAddress: string | null = null;
  let isTest = false;
  let isNce = false;
  let intendedDepositUsd: number | null = null;
  if (invoice.quote_id) {
    const { data } = await db
      .from('quotes')
      .select('customer_name, customer_email, customer_phone, customer_address, is_test, is_nce, deposit_amount_usd')
      .eq('id', invoice.quote_id)
      .maybeSingle<{
        customer_name: string | null;
        customer_email: string | null;
        customer_phone: string | null;
        customer_address: string | null;
        is_test: boolean | null;
        is_nce: boolean | null;
        deposit_amount_usd: number | null;
      }>();
    if (data) {
      customerName = data.customer_name ?? null;
      customerEmail = data.customer_email ?? null;
      customerPhone = data.customer_phone ?? null;
      customerAddress = data.customer_address ?? null;
      isTest = !!data.is_test;
      isNce = !!data.is_nce;
      intendedDepositUsd = data.deposit_amount_usd ?? null;
    }
  }

  let jobNumber: number | null = null;
  let jobStatus: string | null = null;
  if (invoice.job_id) {
    const { data } = await db
      .from('jobs')
      .select('job_number, status')
      .eq('id', invoice.job_id)
      .maybeSingle<{ job_number: number | null; status: string | null }>();
    if (data) {
      jobNumber = data.job_number ?? null;
      jobStatus = data.status ?? null;
    }
  }

  return {
    invoice,
    customerName,
    customerEmail,
    customerPhone,
    customerAddress,
    isTest,
    isNce,
    jobNumber,
    jobStatus,
    intendedDepositUsd,
  };
}

// The minimal shapes createInvoiceFromJob reads.
type JobForInvoice = { id: string; quote_id: string | null; customer_id: string | null };
type QuoteForInvoice = {
  id: string;
  result: (InvoicePricingInput & { depositAmount?: number }) | null;
  deposit_amount_usd: number | null;
  deposit_paid_at: string | null;
  // W1-001: the approved SELECTION total (+ any amendment) — the AGREED figure to
  // bill, which can diverge from result.total. Null on legacy/never-approved rows.
  approval_snapshot: AgreedTotalSnapshot;
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
    .select('id, result, deposit_amount_usd, deposit_paid_at, approval_snapshot')
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

  // W1-001: bill the AGREED total the customer actually consented to, NOT the
  // full quote.result.total. The customer approves a SELECTION on the portal
  // (deselecting items, picking a cheaper roofline tier, toggling rush/takedown),
  // so the agreed figure lives in approval_snapshot.customerSelection.currentTotalUsd
  // (later superseded by an amendment's new_total) — resolveAgreedTotal walks that
  // precedence, falling back to result.total only for a legacy/never-approved row.
  // The breakdown lines (subtotal/discount/fees/tax) stay from result for display
  // continuity; the load-bearing figures (total/balance/credit_note) use the agreed
  // total. The job.line_items snapshot is a booking-time fulfillment reference, NOT
  // a pricing source.
  const result = quote.result ?? { total: 0 };
  const agreedTotal = resolveAgreedTotal(quote.approval_snapshot, result);
  // Scale the whole-quote tax to the AGREED (possibly partial) selection so the
  // invoice's tax line matches what was approved — mirrors setInvoiceTaxOverride so
  // the two write paths stamp the same tax for a partial selection (exact under the
  // flat rate: total = taxable × (1+rate), so agreed/fullTotal = taxable ratio).
  const fullTotal = result.total ?? 0;
  const scaledTax =
    fullTotal > 0 ? round2((result.taxAmount ?? 0) * (agreedTotal / fullTotal)) : (result.taxAmount ?? 0);
  const pricing: InvoicePricingInput = { ...result, taxAmount: scaledTax, total: agreedTotal };
  // The deposit ACTUALLY applied: the durable charged amount when the deposit was
  // confirmed paid; the computed 50% only as a legacy fallback; 0 if never paid.
  const depositPaid = quote.deposit_paid_at
    ? quote.deposit_amount_usd ?? result.depositAmount ?? 0
    : 0;

  const totals = computeInvoiceTotals(pricing, depositPaid, { taxOverridden: false });

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
    // Lost a concurrent insert race (the partial unique index on job_id fired)?
    // Converge on the winner's invoice instead of a spurious null, so the
    // creator is self-sufficiently idempotent.
    if ((error as { code?: string }).code === '23505') {
      const winner = await getInvoiceByJob(jobId);
      if (winner) return winner;
    }
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
 *
 * W1-023: the read-then-canTransition check is advisory only — the UPDATE carries
 * `.eq('status', current.status)` so it is a compare-and-swap. A concurrent
 * transition that moved the row between our read and this write (e.g. an
 * order-cancel flipping the invoice to cancelled while a complete is settling it)
 * matches 0 rows; we treat that as a lost race (re-read once — return the fresh row
 * if someone else already applied the same target, else null) rather than writing
 * the requested status over the winner's.
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
    .eq('status', current.status)
    .select(INVOICE_SELECT)
    .single();
  if (error) {
    // 0 rows OR a real error. Lost-race disambiguation (W1-023): re-read once. If
    // the row already reached the target (a concurrent request applied the same
    // transition), return it as an idempotent success; otherwise the race was
    // divergent (or the row is gone) → null, matching the existing "couldn't apply"
    // contract the callers already handle.
    const fresh = await getInvoice(id);
    if (fresh && fresh.status === to) return fresh;
    console.error('setInvoiceStatus error:', error);
    return null;
  }
  return data as unknown as InvoiceRow;
}

// #199 (F2, wrap-review HIGH): a typed throw so callers can tell WHY
// markInvoicePaidManually refused, instead of pattern-matching a message
// string. `cancelled` mirrors the pre-existing throw exactly (message
// unchanged, so the mark-paid route's existing generic catch — which never
// inspected the error — keeps its EXACT prior behavior for that case).
// `nce-mismatch` is new: see the gate below.
export class InvoiceSettleError extends Error {
  code: 'cancelled' | 'nce-mismatch';
  constructor(code: 'cancelled' | 'nce-mismatch', message: string) {
    super(message);
    this.name = 'InvoiceSettleError';
    this.code = code;
  }
}

/**
 * Manually mark an invoice paid — an operator recording an offline/external
 * payment (cash / check / NCE trade / paid in the Valor terminal). Atomic
 * claim mirroring the Valor balance webhook: status='paid', balance=0,
 * paid_at=now (+ #199's paid_method/payment_reference). Idempotent (a paid
 * invoice is a no-op — its EXISTING method/reference are left untouched, not
 * overwritten by this call's params). Throws on a cancelled invoice. Does NOT
 * touch the job — closing the job is the caller's concern (the close route /
 * collect-then-close flow).
 *
 * #199: `method`/`reference` default to 'cash_check'/null — every EXISTING
 * caller (the mark-paid route's back-compat body-less request, the job-close
 * force-settle) keeps writing exactly what it always wrote, now just also
 * labelled. Validating `reference` (required + non-empty for 'nce') is the
 * CALLER's job (the mark-paid route) — this is a thin, unconditional write.
 *
 * #199 (F2, wrap-review HIGH): ONE positive gate here, not N patches at every
 * caller — an invoice whose linked quote is_nce can ONLY ever settle with
 * method:'nce'. Without this, EITHER of this function's two call sites
 * (job-close's bare force-settle; the mark-paid route, itself reachable from
 * BOTH the dedicated NCE panel AND PipelineActionsMenu's generic
 * "collect-payment"/"close" actions, which POST an empty body) would silently
 * settle an NCE invoice as cash_check — and that mislabel is UNRECOVERABLE in
 * the UI (updateInvoicePaymentReference refuses anything that isn't already
 * paid_method==='nce'). Skipped when the invoice has no linked quote (nothing
 * to check against — same permissive default as every other quote_id-gated
 * lookup in this file).
 *
 * W1-022: the claim excludes BOTH 'paid' AND 'cancelled'. The cancelled pre-check
 * above is read-then-write, so a concurrent order-cancel that flips the invoice to
 * cancelled between that read and this UPDATE would otherwise be resurrected to
 * paid (a bare `.neq('status','paid')` claim still matches a cancelled row).
 * Excluding cancelled in the write itself closes that TOCTOU — the same terminal-
 * status guard the balance webhook gets from `.in('status',['draft','awaiting_payment'])`.
 */
export async function markInvoicePaidManually(
  id: string,
  method: PaidMethod = 'cash_check',
  reference: string | null = null,
): Promise<InvoiceRow | null> {
  const db = sb();
  if (!db) return null;
  const current = await getInvoice(id);
  if (!current) return null;
  if (current.status === 'cancelled') {
    throw new InvoiceSettleError('cancelled', `markInvoicePaidManually: invoice ${id} is cancelled`);
  }
  if (current.status === 'paid') return current; // idempotent no-op

  if (method !== 'nce' && current.quote_id) {
    const { data: quoteRow } = await db
      .from('quotes')
      .select('is_nce')
      .eq('id', current.quote_id)
      .maybeSingle<{ is_nce: boolean }>();
    if (quoteRow?.is_nce) {
      throw new InvoiceSettleError(
        'nce-mismatch',
        `markInvoicePaidManually: invoice ${id}'s quote is NCE — refusing a ${method} settle`,
      );
    }
  }

  const paidAt = new Date().toISOString();
  const { data, error } = await db
    .from('invoices')
    .update({ status: 'paid', balance: 0, paid_at: paidAt, paid_method: method, payment_reference: reference })
    .eq('id', id)
    .neq('status', 'paid')
    .neq('status', 'cancelled')
    .select(INVOICE_SELECT);
  if (error) {
    console.error('markInvoicePaidManually error:', error);
    return null;
  }
  if (!data || (Array.isArray(data) && data.length === 0)) return await getInvoice(id); // raced
  return (Array.isArray(data) ? data[0] : data) as unknown as InvoiceRow;
}

/**
 * Edit the NCE payment reference on an already-paid NCE invoice (a typo fix
 * after mark-paid, #199) — a correction to an existing NCE settlement record,
 * never a way to backdate a reference onto an unpaid or cash-settled invoice.
 * Refuses (returns null) unless the invoice is status==='paid' AND
 * paid_method==='nce'. `reference` must be non-empty after trimming (the
 * caller — the mark-paid route — is expected to have already validated this,
 * but the guard holds regardless of caller). Mirrors setInvoicePaymentPreference's
 * shape: a plain update+select, null on error/not-found/refused.
 */
export async function updateInvoicePaymentReference(
  id: string,
  reference: string,
): Promise<InvoiceRow | null> {
  const db = sb();
  if (!db) return null;
  const trimmed = reference.trim();
  if (!trimmed) return null;
  const current = await getInvoice(id);
  if (!current) return null;
  if (current.status !== 'paid' || current.paid_method !== 'nce') return null;
  const { data, error } = await db
    .from('invoices')
    .update({ payment_reference: trimmed })
    .eq('id', id)
    .select(INVOICE_SELECT)
    .maybeSingle();
  if (error) {
    console.error('updateInvoicePaymentReference error:', error);
    return null;
  }
  return (data as unknown as InvoiceRow | null) ?? null;
}

/**
 * #170(b)/(a): append a retired charge record to invoices.valor_txn_log with a
 * compare-and-swap on the log's prior value (+2 retries), so the two writers —
 * the amend-reopen rotation and the charge-balance double-charge stash — can
 * never lose each other's entry to a read-modify-write race (#640 review MED).
 * opts.clearLive additionally retires the LIVE slot (valor_balance_txn_id /
 * valor_receipt_url → null), CAS'd on the exact txn id being retired so a
 * concurrent writer can't be clobbered. Returns false (with a loud log) when
 * the CAS never lands — the entry still exists at Valor + in the alert email.
 */
export async function appendRetiredTxn(
  id: string,
  entry: RetiredTxnEntry,
  opts?: { clearLive?: { expectTxnId: string } },
): Promise<boolean> {
  const db = sb();
  if (!db) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await getInvoice(id);
    if (!current) return false;
    if (opts?.clearLive && current.valor_balance_txn_id !== opts.clearLive.expectTxnId) {
      // The live slot moved under us — retiring it now would clobber a newer
      // record. Log-append only would double-record later; bail loudly.
      console.error(
        `appendRetiredTxn: live txn changed for invoice ${id} (expected ${opts.clearLive.expectTxnId}, saw ${current.valor_balance_txn_id}) — rotation skipped:`,
        entry,
      );
      return false;
    }
    const log = Array.isArray(current.valor_txn_log) ? current.valor_txn_log : null;
    let q = db
      .from('invoices')
      .update({
        valor_txn_log: [...(log ?? []), entry],
        ...(opts?.clearLive ? { valor_balance_txn_id: null, valor_receipt_url: null } : {}),
      })
      .eq('id', id);
    q = log === null ? q.is('valor_txn_log', null) : q.eq('valor_txn_log', JSON.stringify(log));
    if (opts?.clearLive) q = q.eq('valor_balance_txn_id', opts.clearLive.expectTxnId);
    const { data, error } = await q.select('id');
    if (error) {
      console.error('appendRetiredTxn error:', error);
      return false;
    }
    if (data && (data as unknown[]).length > 0) return true;
  }
  console.error(`appendRetiredTxn: lost the CAS 3× for invoice ${id} — entry NOT recorded:`, entry);
  return false;
}

/**
 * #170(d): record how this customer settles the balance. Pass null to unset.
 * Display/gating metadata only — never touches money fields or status.
 */
export async function setInvoicePaymentPreference(
  id: string,
  preference: PaymentPreference | null,
): Promise<InvoiceRow | null> {
  const db = sb();
  if (!db) return null;
  const { data, error } = await db
    .from('invoices')
    .update({ payment_preference: preference })
    .eq('id', id)
    .select(INVOICE_SELECT)
    .maybeSingle();
  if (error) {
    console.error('setInvoicePaymentPreference error:', error);
    return null;
  }
  return (data as unknown as InvoiceRow | null) ?? null;
}

/**
 * Toggle the manual tax-override on an invoice (SPEC §4.3 — rare exemptions). When
 * ON, the tax line is dropped from the total; OFF restores it. RE-PRICES from the
 * source quote.result (not the invoice's possibly-already-zeroed stored values) so
 * toggling back ON restores the original tax, then re-applies the actual paid
 * deposit → balance. Also reconciles the invoice STATUS to the new balance (an
 * exemption that clears the balance settles it paid; restoring tax reopens it),
 * mirroring the amend re-sync. Returns null if Supabase isn't configured or the
 * invoice is missing.
 *
 * #7 fix: re-pricing REQUIRES the source quote.result — there is no safe fallback
 * to the invoice's own stored subtotal/tax/total. Those stored fields can already
 * be a PARTIAL (agreed) breakdown from creation or a later amend, and the stored
 * `tax` is not guaranteed to be in the same ratio as the stored `total` (e.g. the
 * amend re-sync can write the quote's full-quote tax against an amended, partial
 * total). Treating those as the "full, un-overridden" breakdown risks removing
 * MORE tax than the invoice's own basis justifies — a silent under-bill. So when
 * the quote or its priced result can't be read, this throws instead of guessing.
 */
export async function setInvoiceTaxOverride(
  id: string,
  overridden: boolean,
): Promise<InvoiceRow | null> {
  const db = sb();
  if (!db) return null;

  const invoice = await getInvoice(id);
  if (!invoice) return null;

  // B3 fix: a PAID invoice's balance has already been collected — re-pricing
  // cannot retroactively change what was charged. Applying a tax exemption to a
  // paid invoice would require a refund in Valor, which must be handled manually.
  // Refuse here so a paid invoice is never resurrected to 'awaiting_payment' with
  // a bogus positive balance.
  if (invoice.status === 'paid') {
    throw new Error(
      'Cannot change the tax override on an already-paid invoice. ' +
        'A tax exemption on a collected balance requires a manual refund in Valor.',
    );
  }

  // Re-price from the source quote.result (full, un-overridden breakdown) but with
  // the AGREED total (W1-001) — same source createInvoiceFromJob bills from, so
  // toggling the override can't silently re-bill the full quote.result.total for a
  // diverged selection.
  let pricing: InvoicePricingInput | null = null;
  if (invoice.quote_id) {
    const { data: quote } = await db
      .from('quotes')
      .select('result, approval_snapshot')
      .eq('id', invoice.quote_id)
      .maybeSingle<{ result: InvoicePricingInput | null; approval_snapshot: AgreedTotalSnapshot }>();
    if (quote?.result) {
      const agreed = resolveAgreedTotal(quote.approval_snapshot, quote.result);
      const fullTotal = quote.result.total ?? 0;
      // The agreed total may be a PARTIAL selection (e.g. a per-side permanent
      // package A/B/C, the default for permanent). quote.result.taxAmount is the
      // WHOLE-quote tax, so a tax exemption would subtract the full-quote tax from a
      // partial total and UNDER-BILL. Scale the removable tax to the agreed basis so
      // computeInvoiceTotals removes only the tax embedded in what was approved.
      const scaledTax =
        fullTotal > 0
          ? round2((quote.result.taxAmount ?? 0) * (agreed / fullTotal))
          : (quote.result.taxAmount ?? 0);
      pricing = { ...quote.result, taxAmount: scaledTax, total: agreed };
    }
  }

  // #7 fix: no quote/result means no verified basis to re-price from. Refuse
  // rather than falling back to the invoice's own stored tax/total — those can
  // be mismatched (see the docstring above) and silently under-bill the customer.
  if (!pricing) {
    throw new Error(
      `Cannot change the tax override on invoice ${id}: its source quote's priced result is ` +
        'unavailable, so the pre-tax basis cannot be safely reconstructed. Re-link the quote ' +
        'or apply the exemption manually.',
    );
  }

  const totals = computeInvoiceTotals(pricing, invoice.deposit_applied, { taxOverridden: overridden });
  // At this point invoice.status is 'draft' | 'awaiting_payment' | 'cancelled'
  // (the 'paid' case is refused above). An exemption that clears the balance
  // settles the invoice to paid; otherwise the status is left unchanged.
  const reconciledStatus: InvoiceStatus =
    invoice.status === 'cancelled'
      ? 'cancelled'
      : totals.balance <= 0
        ? 'paid'
        : invoice.status;

  const patch: Record<string, unknown> = {
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total,
    deposit_applied: totals.deposit_applied,
    balance: totals.balance,
    credit_note: totals.credit_note,
    tax_overridden: overridden,
    status: reconciledStatus,
  };
  // Stamp paid_at when an exemption zeroes the balance and settles the invoice.
  if (reconciledStatus === 'paid') {
    patch.paid_at = new Date().toISOString();
  }

  // TOCTOU fix (audit HIGH): the invoice was read at the top of this function,
  // then this write happens after an async round-trip to the source quote. A
  // concurrent write (e.g. the Valor balance webhook settling this invoice to
  // 'paid') could land in that gap. Without a precondition the write below
  // would clobber it — resurrecting a paid invoice to `reconciledStatus` with
  // a phantom positive balance. Make it a CAS on the freshly-read status,
  // mirroring setInvoiceStatus's `.eq('status', current.status)`: if the row
  // moved since our read, 0 rows match and we abort rather than overwrite.
  const { data, error } = await db
    .from('invoices')
    .update(patch)
    .eq('id', id)
    .eq('status', invoice.status)
    .select(INVOICE_SELECT)
    .single();
  if (error) {
    console.error('setInvoiceTaxOverride error:', error);
    return null;
  }
  return data as unknown as InvoiceRow;
}
