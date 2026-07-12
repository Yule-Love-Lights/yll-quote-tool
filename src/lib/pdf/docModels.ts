// Ledger #87(a) — customer-facing PDF documents (quote / invoice / receipt).
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

function formatDate(d: Date): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(d);
}

export type PdfLineItem = { label: string; detail: string; amount: string };
export type PdfMoneyLine = { label: string; amount: string };

// ─── Quote ──────────────────────────────────────────────────────────────────

export type QuoteDocModel = {
  quoteNumber: string;
  date: string;
  customerName: string;
  customerAddress: string;
  packageName: string;
  lineItems: PdfLineItem[];
  total: string;
  depositDue: string;
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

  const selectedPackage = quote.packages.find((p) => p.id === approval.packageId);
  const includedIds =
    approval.selectedItemIds.length > 0
      ? new Set(approval.selectedItemIds)
      : selectedPackage
        ? new Set(selectedPackage.includedItemIds)
        : null; // no package context — show every line item on the quote

  const items = (includedIds ? quote.lineItems.filter((li) => includedIds.has(li.id)) : quote.lineItems).map(
    (li) => ({ label: li.label, detail: li.detail, amount: formatUsd(li.price) }),
  );

  return {
    quoteNumber: formatQuoteRef(quote.id),
    date: formatDate(new Date(approval.approvedAt)),
    customerName: quote.customer.fullName,
    customerAddress: quote.customer.address,
    packageName: approval.packageName,
    lineItems: items,
    total: formatUsd(approval.totalUsd),
    depositDue: formatUsd(approval.depositUsd),
  };
}

// ─── Invoice ────────────────────────────────────────────────────────────────

export type InvoiceDocModel = {
  invoiceNumber: string;
  date: string;
  paidDate: string | null;
  customerName: string;
  customerAddress: string;
  lines: PdfMoneyLine[];
  total: string;
  balanceDue: string;
  creditNote: string | null;
  status: InvoiceStatus;
};

/**
 * Build the customer/operator Invoice PDF's doc model from getInvoiceDetail.
 *
 * Fix-batch #87a MED finding #2: createInvoiceFromJob (src/lib/invoices.ts)
 * stores the FULL quote subtotal/discount/fees alongside the AGREED
 * (possibly partial) total/tax — on a partial approval (the DEFAULT for
 * permanent per-side packages) `total` is scaled down but `subtotal` isn't,
 * so a Subtotal/Discount/Fees/Tax itemization built from those columns
 * doesn't reconcile: the old "Rush/takedown fees" reconstruction
 * (total − (subtotal − discount + tax)) goes negative and gets silently
 * dropped, leaving a printed Subtotal that exceeds the printed Total with no
 * line explaining the gap. Don't print that itemization at all. Total,
 * Deposit applied, and Balance due always reconcile exactly — balance is
 * defined as round(max(0, total − deposit_applied)) from already-cents-
 * rounded figures (computeInvoiceTotals), so total − deposit_applied ===
 * balance to the cent, no rounding surprises — so those three (plus a
 * credit-note line for the rare overpayment case) are the only money lines
 * printed.
 */
export function buildInvoiceDocModel(detail: InvoiceDetail): InvoiceDocModel {
  const inv = detail.invoice;
  const money = (n: number) => formatUsd(n, { fraction: true });

  const lines: PdfMoneyLine[] = [
    { label: 'Total', amount: money(inv.total) },
    { label: 'Deposit applied', amount: `−${money(inv.deposit_applied)}` },
    { label: 'Balance due', amount: money(inv.balance) },
  ];
  if (inv.credit_note > 0) {
    lines.push({ label: 'Credit (overpaid — manual refund)', amount: money(inv.credit_note) });
  }

  return {
    invoiceNumber: inv.invoice_number != null ? String(inv.invoice_number) : inv.id.slice(0, 8).toUpperCase(),
    date: formatDate(new Date(inv.created_at)),
    paidDate: inv.paid_at ? formatDate(new Date(inv.paid_at)) : null,
    customerName: detail.customerName ?? '—',
    customerAddress: detail.customerAddress ?? '',
    lines,
    total: money(inv.total),
    balanceDue: money(inv.balance),
    creditNote: inv.credit_note > 0 ? money(inv.credit_note) : null,
    status: inv.status,
  };
}

// ─── Receipt ────────────────────────────────────────────────────────────────

export type ReceiptDocModel = {
  receiptNumber: string;
  customerName: string;
  customerAddress: string;
  depositPaid: { amount: string; date: string } | null;
  balancePaid: { amount: string; date: string } | null;
  totalPaid: string;
  valorReceiptUrl: string | null;
  status: InvoiceStatus;
};

/**
 * Build the Receipt PDF's doc model — what money actually changed hands.
 * `quoteRow` supplies deposit_paid_at (the quotes table column; not on the
 * invoice row) — pass the result of getQuoteRaw(quoteId).
 */
export function buildReceiptDocModel(
  detail: InvoiceDetail,
  quoteRow: { deposit_paid_at: string | null },
): ReceiptDocModel {
  const inv = detail.invoice;
  const money = (n: number) => formatUsd(n, { fraction: true });

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
  const balanceAmount = Math.max(0, Math.round((inv.total - inv.deposit_applied) * 100) / 100);
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
  const totalPaid =
    Math.round(((depositPaid ? inv.deposit_applied : 0) + (balancePaid ? balanceAmount : 0)) * 100) / 100;

  return {
    receiptNumber: inv.invoice_number != null ? String(inv.invoice_number) : inv.id.slice(0, 8).toUpperCase(),
    customerName: detail.customerName ?? '—',
    customerAddress: detail.customerAddress ?? '',
    depositPaid,
    balancePaid,
    totalPaid: money(totalPaid),
    valorReceiptUrl: inv.valor_receipt_url ?? null,
    status: inv.status,
  };
}
