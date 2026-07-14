// Ledger #87(a) — customer-facing PDF documents (quote / invoice / receipt),
// redesigned to match the company's Jobber invoice format.
//
// PURE, money-safe builders. Each function takes an ALREADY-priced/stored
// shape — PortalQuote (from loadPortalQuote, the exact data the portal
// renders) or InvoiceDetail (from getInvoiceDetail, the exact data the
// operator invoice page renders) — and returns a plain object of pre-
// formatted display strings. No dollar figure is computed here beyond
// reusing formulas the app already ships elsewhere (each cited inline); the
// React-PDF components in src/components/pdf/*.tsx only render these models
// and do zero math of their own.
//
// This file has no 'server-only' / Supabase imports so it stays unit-testable
// (see docModels.test.ts — the money gate for this ledger item).

import { formatUsd, formatQuoteRef } from '@/components/portal/format';
import type { PortalQuote } from '@/components/portal/types';
import type { InvoiceDetail } from '@/lib/invoices';
import type { InvoiceStatus } from '@/lib/invoiceStatus';
import { roundMoney } from '@/lib/money';
import { SERVICE_TYPE_LABELS, DEFAULT_SERVICE_TYPE } from '@/lib/serviceType';

function formatDate(d: Date): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(d);
}

function money(n: number): string {
  return formatUsd(n, { fraction: true });
}

// "8.625%" / "6.25%" / "5%" — trims trailing zeros without ever emitting the
// bare rate as a decimal fraction.
function formatTaxPercent(rate: number): string {
  const pct = (rate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return `${pct}%`;
}

export type PdfLineItem = {
  label: string; // Product/Service
  detail: string; // Description
  qty: number; // Qty. — always 1: each PortalLineItem is already one priced unit, not a per-unit rate
  unitPrice: string; // Unit Price
  amount: string; // Total (== unitPrice, since qty is always 1)
};
export type PdfMoneyLine = { label: string; amount: string };

// The RECIPIENT + SERVICE ADDRESS block. Our business has one address per
// job (no separate billing-office concept), so billingAddress and
// serviceAddress are the same real customer_address value on both docs —
// not two independently-sourced fields we'd risk drifting.
export type PdfRecipient = {
  name: string;
  billingAddress: string;
  phone: string | null;
  serviceAddress: string;
};

const RECONCILE_EPSILON = 0.02;

// ─── Agreed line items (shared across all three docs) ──────────────────────

export type AgreedItems = {
  items: PdfLineItem[];
  subtotal: number; // dollars — sum of the agreed items' prices
  fees: number; // dollars — rush/takedown fees actually selected at approval
  feesLabel: string | null;
};

/**
 * Resolve the line items the customer actually AGREED to (and their real
 * dollar subtotal), from a quote's frozen approval — the same selection
 * buildQuoteDocModel has always rendered from (fix-batch #87a HIGH #1: the
 * frozen approval.selectedItemIds, never a live/guessed selection). Shared so
 * the invoice/receipt itemized breakdown is sourced from the identical,
 * already-tested filter instead of a second implementation that could drift.
 *
 * Returns null when the quote has no approval snapshot (nothing agreed to
 * read) — callers must fall back to a non-itemized rendering, never guess.
 */
export function resolveAgreedLineItems(quote: PortalQuote): AgreedItems | null {
  const approval = quote.approval;
  if (!approval) return null;

  const selectedPackage = quote.packages.find((p) => p.id === approval.packageId);
  const includedIds =
    approval.selectedItemIds.length > 0
      ? new Set(approval.selectedItemIds)
      : selectedPackage
        ? new Set(selectedPackage.includedItemIds)
        : null; // no package context — the whole quote's line items are what was agreed to

  const filtered = includedIds ? quote.lineItems.filter((li) => includedIds.has(li.id)) : quote.lineItems;

  const items: PdfLineItem[] = filtered.map((li) => ({
    label: li.label,
    detail: li.detail,
    qty: 1,
    unitPrice: money(li.price),
    amount: money(li.price),
  }));

  const subtotal = roundMoney(filtered.reduce((sum, li) => sum + li.price, 0));

  // Rush/premium-takedown fees the customer selected, at the amounts staff
  // configured for this job (PortalCharges) — real, not fabricated.
  const feeParts: string[] = [];
  let fees = 0;
  if (approval.rushSelected && quote.charges.rush.amount > 0) {
    fees += quote.charges.rush.amount;
    feeParts.push('Rush install fee');
  }
  if (approval.takedownSelected && quote.charges.takedown.amount > 0) {
    fees += quote.charges.takedown.amount;
    feeParts.push('Premium takedown fee');
  }

  return { items, subtotal, fees: roundMoney(fees), feesLabel: feeParts.length ? feeParts.join(' + ') : null };
}

// ─── The itemized breakdown (Subtotal / Discount / Fees / Sales Tax) ───────

export type ReconcilingBreakdown = {
  subtotal: string;
  discount: PdfMoneyLine | null; // omitted (null) when 0
  fees: PdfMoneyLine | null; // omitted (null) when 0
  taxLabel: string;
  tax: string;
};

/**
 * Build the itemized Subtotal→Discount→Fees→Sales-Tax breakdown so it
 * reconciles EXACTLY to `total`, or return null when it can't be proven to.
 *
 * `subtotal` and `fees` are real (sum of agreed line items; known selected
 * fee amounts). `taxable` is derived as `total − taxAmount` (both real). Any
 * gap between `subtotal + fees` and `taxable` is attributed to `discount` —
 * this is a DERIVED figure (installment/manual discounts aren't individually
 * threaded through the approval snapshot), but deriving it this way can never
 * misstate the total: Subtotal − Discount + Fees + Tax === Total by
 * construction. If the derived discount would be NEGATIVE (subtotal + fees
 * fall short of the taxable amount — e.g. a post-approval amendment moved the
 * price in a way this quote snapshot doesn't reflect), that would require
 * inventing a phantom fee/surcharge to explain the gap — refuse instead
 * (return null) and let the caller fall back to the minimal always-reconciling
 * set (Total / Deposit / Balance). Correctness beats completeness (#87a scope).
 */
function buildReconcilingBreakdown(params: {
  subtotal: number;
  fees: number;
  feesLabel: string | null;
  taxAmount: number;
  taxRate: number;
  total: number;
}): ReconcilingBreakdown | null {
  const { subtotal, fees, feesLabel, taxAmount, taxRate, total } = params;
  const taxable = roundMoney(total - taxAmount);
  const rawDiscount = roundMoney(subtotal + fees - taxable);
  if (rawDiscount < -RECONCILE_EPSILON) return null;

  // The agreed line-item Subtotal is exact, but taxAmount is an independently
  // rounded column (the invoice's proportionally-scaled tax, or the quote's
  // total-derived tax), so `rawDiscount` can be a ±1c rounding artifact rather
  // than a real discount. Treat anything within the reconcile band as noise:
  // only a discount ABOVE the band is a genuine one worth printing.
  const discount = rawDiscount > RECONCILE_EPSILON ? rawDiscount : 0;

  // Derive the displayed tax so the printed stack sums to Total EXACTLY, for
  // every case: Subtotal − Discount + Fees + Tax === Total. When `discount` is
  // the real derived discount this equals taxAmount to the cent; when the
  // discount was rounding noise (dropped to 0), the ≤2c residual is absorbed
  // into the tax line instead of leaving the stack a cent short or printing a
  // spurious ~1c "Discount". Total/Deposit/Balance stay verbatim + load-bearing.
  const tax = roundMoney(total - subtotal - fees + discount);

  return {
    subtotal: money(subtotal),
    // A plain ASCII hyphen, not the typographic minus (U+2212): react-pdf's
    // standard Helvetica font has no glyph for U+2212 and silently drops it,
    // rendering the amount with no sign at all — verified against an actual
    // rendered PDF while building this feature.
    discount: discount > 0.004 ? { label: 'Discount', amount: `-${money(discount)}` } : null,
    fees: fees > 0.004 ? { label: feesLabel ?? 'Fees', amount: money(fees) } : null,
    taxLabel: `Sales Tax (${formatTaxPercent(taxRate)})`,
    tax: money(tax),
  };
}

// A quote's approval snapshot freezes the tax-inclusive TOTAL, not a separate
// tax line — unlike an invoice row, there is no stored tax figure to read
// verbatim. Derive it as the exact algebraic inverse of the pricing engine's
// own forward formula (taxable × (1+rate) = total), so it is a real
// consequence of the frozen total + this quote's tax rate, not an invented
// number. Used for DISPLAY only — approval.totalUsd/depositUsd remain the
// only load-bearing figures.
function deriveTaxFromTotal(total: number, rate: number): number {
  if (!(rate > 0)) return 0;
  const taxable = roundMoney(total / (1 + rate));
  return roundMoney(total - taxable);
}

// ─── Quote ──────────────────────────────────────────────────────────────────

export type QuoteDocModel = {
  quoteNumber: string;
  date: string; // Issued
  recipient: PdfRecipient;
  serviceType: string; // "Holiday" / "Permanent" / "Event" / "Bistro"
  packageName: string;
  lineItems: PdfLineItem[];
  subtotal: string | null; // null ⇒ itemized breakdown unavailable, render Total/Deposit only
  discount: PdfMoneyLine | null;
  fees: PdfMoneyLine | null;
  taxLabel: string | null;
  tax: string | null;
  total: string;
  depositDue: string;
  status: 'cancelled' | null; // for the diagonal watermark
};

/**
 * Build the customer Quote PDF's doc model.
 *
 * APPROVED-ONLY (adversarial review #87a fix-batch, HIGH finding #1): before
 * approval the customer's live package pick is client-side session state
 * that's never written back to the DB, so there is no persisted "current"
 * total to read — the old unapproved fallback (first .recommended package,
 * else first non-empty tier) guessed a package/total that's flat-out WRONG
 * on permanent/event quotes, where no package is ever .recommended. An
 * approved quote has a single frozen figure (quote.approval) — the exact
 * package/total/deposit/selection the customer signed — and that's the ONLY
 * source this function will ever render from. Throws if the quote isn't
 * approved; the route (src/app/api/quotes/[id]/pdf/route.tsx) already gates
 * on `quote.approval` before calling this, so the throw is a defense-in-depth
 * backstop, not a normal-path outcome — it can never emit a wrong document.
 */
export function buildQuoteDocModel(quote: PortalQuote): QuoteDocModel {
  const approval = quote.approval;
  if (!approval) {
    throw new Error('buildQuoteDocModel: quote is not approved — the Quote PDF is approved-only');
  }

  const agreed = resolveAgreedLineItems(quote);
  const breakdown = agreed
    ? buildReconcilingBreakdown({
        subtotal: agreed.subtotal,
        fees: agreed.fees,
        feesLabel: agreed.feesLabel,
        taxAmount: deriveTaxFromTotal(approval.totalUsd, quote.charges.taxRate),
        taxRate: quote.charges.taxRate,
        total: approval.totalUsd,
      })
    : null;

  return {
    quoteNumber: formatQuoteRef(quote.id),
    date: formatDate(new Date(approval.approvedAt)),
    recipient: {
      name: quote.customer.fullName,
      billingAddress: quote.customer.address,
      phone: quote.customer.phone || null,
      serviceAddress: quote.customer.address,
    },
    serviceType: SERVICE_TYPE_LABELS[quote.serviceType ?? DEFAULT_SERVICE_TYPE],
    packageName: approval.packageName,
    lineItems: agreed?.items ?? [],
    subtotal: breakdown?.subtotal ?? null,
    discount: breakdown?.discount ?? null,
    fees: breakdown?.fees ?? null,
    taxLabel: breakdown?.taxLabel ?? null,
    tax: breakdown?.tax ?? null,
    total: formatUsd(approval.totalUsd),
    depositDue: formatUsd(approval.depositUsd),
    // A quote can be cancelled post-approval (order cancelled before install);
    // never print a clean-looking quote for a dead order.
    status: quote.quoteStatus === 'cancelled' ? 'cancelled' : null,
  };
}

// ─── Invoice ────────────────────────────────────────────────────────────────

export type InvoiceDocModel = {
  invoiceNumber: string;
  date: string; // Issued
  dueDate: string; // Due — always the Issued date (contract terms: due upon receipt)
  paidDate: string | null; // Paid
  recipient: PdfRecipient;
  serviceType: string;
  lineItems: PdfLineItem[];
  subtotal: string | null;
  discount: PdfMoneyLine | null;
  fees: PdfMoneyLine | null;
  taxLabel: string | null;
  tax: string | null;
  total: string;
  depositCollected: string;
  paidTowardBalance: string; // the "Paid" row — amount collected beyond the deposit ("$0.00" when none)
  creditNote: string | null;
  invoiceBalance: string;
  accountBalance: string; // mirrors invoiceBalance — see comment below
  status: InvoiceStatus;
};

/**
 * Build the customer/operator Invoice PDF's doc model from getInvoiceDetail
 * (+ the source quote's portal shape, for the itemized breakdown).
 *
 * Fix-batch #87a MED finding #2 (Jobber-format redesign): createInvoiceFromJob
 * stores the FULL quote subtotal alongside the AGREED (possibly partial)
 * total/tax — on a partial approval (the DEFAULT for permanent per-side
 * packages) `total` is scaled down but the invoice row's own `subtotal`
 * column isn't, so an itemization built from THOSE columns doesn't reconcile.
 * This redesign sources the itemized Subtotal from the AGREED line items
 * instead (resolveAgreedLineItems, reading the SAME frozen selection the
 * Quote PDF has always used) and derives Discount so the printed stack always
 * reconciles (buildReconcilingBreakdown) — or omits the itemized block
 * entirely (subtotal/discount/fees/tax all null) when it can't.
 *
 * Independent of that itemized block, Total → Deposit collected → Paid →
 * (Credit, if any) → Invoice balance is ALWAYS present and ALWAYS reconciles:
 * total − deposit_applied − paidTowardBalance + creditNote === balance for
 * every status (verified below), because `balance`/`credit_note` are already
 * the clamp/overflow of the SAME subtraction (computeInvoiceTotals) and
 * paidTowardBalance is reconstructed with that identical clamp. This is the
 * minimal always-reconciling fallback the itemized block sits on top of.
 */
export function buildInvoiceDocModel(detail: InvoiceDetail, portalQuote: PortalQuote | null): InvoiceDocModel {
  const inv = detail.invoice;

  const agreed = portalQuote ? resolveAgreedLineItems(portalQuote) : null;
  const breakdown = agreed
    ? buildReconcilingBreakdown({
        subtotal: agreed.subtotal,
        fees: agreed.fees,
        feesLabel: agreed.feesLabel,
        taxAmount: inv.tax,
        taxRate: portalQuote!.charges.taxRate,
        total: inv.total,
      })
    : null;

  // A PAID invoice's own `balance` column is already zeroed by settlement
  // (markInvoicePaidManually / the Valor balance webhook), so the amount
  // actually collected toward the balance (beyond the deposit) is
  // reconstructed with the SAME clamp formula computeInvoiceTotals uses
  // (src/lib/invoices.ts:121 — max(0, total − deposit_applied)), not a new
  // computation. Mirrors buildReceiptDocModel's balancePaid reconstruction.
  const preSettlementBalance = roundMoney(Math.max(0, inv.total - inv.deposit_applied));
  const paidTowardBalance = inv.status === 'paid' ? preSettlementBalance : 0;

  const issuedDate = formatDate(new Date(inv.created_at));

  return {
    invoiceNumber: inv.invoice_number != null ? String(inv.invoice_number) : inv.id.slice(0, 8).toUpperCase(),
    date: issuedDate,
    dueDate: issuedDate,
    paidDate: inv.paid_at ? formatDate(new Date(inv.paid_at)) : null,
    recipient: {
      name: detail.customerName ?? '—',
      billingAddress: detail.customerAddress ?? '',
      phone: detail.customerPhone,
      serviceAddress: detail.customerAddress ?? '',
    },
    serviceType: SERVICE_TYPE_LABELS[portalQuote?.serviceType ?? DEFAULT_SERVICE_TYPE],
    lineItems: agreed?.items ?? [],
    subtotal: breakdown?.subtotal ?? null,
    discount: breakdown?.discount ?? null,
    fees: breakdown?.fees ?? null,
    taxLabel: breakdown?.taxLabel ?? null,
    tax: breakdown?.tax ?? null,
    total: money(inv.total),
    depositCollected: money(inv.deposit_applied),
    paidTowardBalance: money(paidTowardBalance),
    creditNote: inv.credit_note > 0 ? money(inv.credit_note) : null,
    invoiceBalance: money(inv.balance),
    // Jobber's "Account Balance" is the customer's running AR balance across
    // every invoice; this app has no multi-invoice ledger (one invoice per
    // quote — getInvoiceByQuote's one-row contract), so the only honest value
    // to print is this same invoice's own balance, not a fabricated separate
    // figure.
    accountBalance: money(inv.balance),
    status: inv.status,
  };
}

// ─── Receipt ────────────────────────────────────────────────────────────────

export type ReceiptDocModel = {
  receiptNumber: string;
  date: string; // Issued
  paidDate: string | null;
  recipient: PdfRecipient;
  serviceType: string;
  lineItems: PdfLineItem[];
  depositPaid: { amount: string; date: string } | null;
  balancePaid: { amount: string; date: string } | null;
  totalPaid: string;
  valorReceiptUrl: string | null;
  status: InvoiceStatus;
};

/**
 * Build the Receipt PDF's doc model — what money actually changed hands.
 * `quoteRow` supplies deposit_paid_at (the quotes table column; not on the
 * invoice row) — pass the result of getQuoteRaw(quoteId). `portalQuote`
 * (loadPortalQuote(quoteId)) supplies the agreed line items + service type;
 * null degrades to an empty item list / the default "Holiday" label rather
 * than failing the receipt — the payment figures below never depend on it.
 */
export function buildReceiptDocModel(
  detail: InvoiceDetail,
  quoteRow: { deposit_paid_at: string | null },
  portalQuote: PortalQuote | null,
): ReceiptDocModel {
  const inv = detail.invoice;

  const depositPaid =
    inv.deposit_applied > 0 && quoteRow.deposit_paid_at
      ? { amount: money(inv.deposit_applied), date: formatDate(new Date(quoteRow.deposit_paid_at)) }
      : null;

  // A PAID invoice's own `balance` column is already zeroed by settlement
  // (markInvoicePaidManually / the Valor balance webhook), so the amount
  // actually collected for the balance is reconstructed with the SAME clamp
  // formula computeInvoiceTotals uses (src/lib/invoices.ts:121 — max(0,
  // total − deposit_applied)). This is the value invoice.balance held right
  // before settlement, not a new computation.
  const balanceAmount = roundMoney(Math.max(0, inv.total - inv.deposit_applied));
  const balancePaid =
    inv.status === 'paid' && inv.paid_at && balanceAmount > 0
      ? { amount: money(balanceAmount), date: formatDate(new Date(inv.paid_at)) }
      : null;

  // Fix-batch #87a MED finding #3: totalPaid must be the SUM of the actual
  // collected pieces above, never a status-derived shortcut. The old
  // `status === 'paid' ? total : deposit_applied` over/under-stated whenever
  // an amend-down auto-promotes an invoice to 'paid' with no balance ever
  // collected (deposit_applied ≥ the reduced total — the customer only ever
  // paid the deposit). depositPaid/balancePaid above are already the exact
  // collected pieces; balancePaid contributes 0 when null.
  const totalPaid = roundMoney((depositPaid ? inv.deposit_applied : 0) + (balancePaid ? balanceAmount : 0));

  const agreed = portalQuote ? resolveAgreedLineItems(portalQuote) : null;

  return {
    receiptNumber: inv.invoice_number != null ? String(inv.invoice_number) : inv.id.slice(0, 8).toUpperCase(),
    date: formatDate(new Date(inv.created_at)),
    paidDate: balancePaid?.date ?? depositPaid?.date ?? null,
    recipient: {
      name: detail.customerName ?? '—',
      billingAddress: detail.customerAddress ?? '',
      phone: detail.customerPhone,
      serviceAddress: detail.customerAddress ?? '',
    },
    serviceType: SERVICE_TYPE_LABELS[portalQuote?.serviceType ?? DEFAULT_SERVICE_TYPE],
    lineItems: agreed?.items ?? [],
    depositPaid,
    balancePaid,
    totalPaid: money(totalPaid),
    valorReceiptUrl: inv.valor_receipt_url ?? null,
    status: inv.status,
  };
}
