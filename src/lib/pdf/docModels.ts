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
  isApproved: boolean;
};

/**
 * Build the customer Quote PDF's doc model.
 *
 * An APPROVED quote has a single frozen figure (quote.approval) — the exact
 * package/total/deposit/selection the customer signed — and that wins.
 *
 * A quote the customer hasn't approved yet has no persisted "current"
 * total: their live package pick on the portal is client-side session state
 * that's never written back until Approve. So an unapproved quote's PDF
 * mirrors what the portal itself opens on by default: the staff "Our
 * Recommendation" pick (packages[].recommended), falling back to the first
 * non-empty tier. Either way every dollar figure below (PortalPackage.total/
 * .deposit, or PortalApproval.totalUsd/.depositUsd) is read straight off
 * PortalQuote — nothing here is recomputed.
 */
export function buildQuoteDocModel(quote: PortalQuote, now: Date = new Date()): QuoteDocModel {
  const approval = quote.approval;
  const fallbackPackage =
    quote.packages.find((p) => p.recommended) ??
    quote.packages.find((p) => p.includedItemIds.length > 0);
  const selectedPackage = approval ? quote.packages.find((p) => p.id === approval.packageId) : fallbackPackage;

  const includedIds =
    approval && approval.selectedItemIds.length > 0
      ? new Set(approval.selectedItemIds)
      : selectedPackage
        ? new Set(selectedPackage.includedItemIds)
        : null; // no package context — show every line item on the quote

  const items = (includedIds ? quote.lineItems.filter((li) => includedIds.has(li.id)) : quote.lineItems).map(
    (li) => ({ label: li.label, detail: li.detail, amount: formatUsd(li.price) }),
  );

  const total = approval ? approval.totalUsd : (selectedPackage?.total ?? 0);
  const depositDue = approval ? approval.depositUsd : (selectedPackage?.deposit ?? 0);

  return {
    quoteNumber: formatQuoteRef(quote.id),
    date: formatDate(approval?.approvedAt ? new Date(approval.approvedAt) : now),
    customerName: quote.customer.fullName,
    customerAddress: quote.customer.address,
    packageName: approval?.packageName ?? selectedPackage?.name ?? 'Custom',
    lineItems: items,
    total: formatUsd(total),
    depositDue: formatUsd(depositDue),
    isApproved: !!approval,
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
};

/** Build the customer/operator Invoice PDF's doc model from getInvoiceDetail. */
export function buildInvoiceDocModel(detail: InvoiceDetail): InvoiceDocModel {
  const inv = detail.invoice;
  const money = (n: number) => formatUsd(n, { fraction: true });

  const lines: PdfMoneyLine[] = [{ label: 'Subtotal', amount: money(inv.subtotal) }];
  if (inv.discount > 0) lines.push({ label: 'Discount', amount: `−${money(inv.discount)}` });
  // Rush/takedown fees aren't a stored column on the invoice — reconstructed
  // with the SAME formula the operator invoice page already displays
  // (src/app/admin/invoices/[id]/page.tsx:244: total − (subtotal − discount +
  // tax)). Not new money math, just the existing display derivation reused.
  const fees = Math.round((inv.total - (inv.subtotal - inv.discount + inv.tax)) * 100) / 100;
  if (fees > 0) lines.push({ label: 'Rush / takedown fees', amount: money(fees) });
  lines.push({ label: inv.tax_overridden ? 'Tax (overridden)' : 'Tax', amount: money(inv.tax) });
  lines.push({ label: 'Total', amount: money(inv.total) });
  lines.push({ label: 'Deposit applied', amount: `−${money(inv.deposit_applied)}` });
  lines.push({ label: 'Balance due', amount: money(inv.balance) });

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

  // This system never accepts a partial balance payment (the balance is
  // collected in one shot — a Valor charge or an operator mark-paid), so a
  // paid invoice's total collected is the full total; short of that, only
  // the deposit has moved.
  const totalPaid = inv.status === 'paid' ? inv.total : inv.deposit_applied;

  return {
    receiptNumber: inv.invoice_number != null ? String(inv.invoice_number) : inv.id.slice(0, 8).toUpperCase(),
    customerName: detail.customerName ?? '—',
    customerAddress: detail.customerAddress ?? '',
    depositPaid,
    balancePaid,
    totalPaid: money(totalPaid),
    valorReceiptUrl: inv.valor_receipt_url ?? null,
  };
}
