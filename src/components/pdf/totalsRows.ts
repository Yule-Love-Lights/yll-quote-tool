// Ledger #87(a) Jobber-format redesign — shared row-builder for the optional
// itemized Subtotal/Discount/Fees/Sales-Tax block that QuotePdf and InvoicePdf
// both print (when docModels.ts could prove it reconciles; omitted entirely
// otherwise). Pure layout glue — no math, just turns already-formatted
// strings into PdfTotalsStack rows.

import type { PdfMoneyLine } from '@/lib/pdf/docModels';
import type { PdfTotalsRow } from './PdfTotalsStack';

export function itemizedRows(input: {
  subtotal: string | null;
  discount: PdfMoneyLine | null;
  fees: PdfMoneyLine | null;
  taxLabel: string | null;
  tax: string | null;
}): PdfTotalsRow[] {
  const rows: PdfTotalsRow[] = [];
  if (input.subtotal != null) rows.push({ label: 'Subtotal', amount: input.subtotal });
  if (input.discount) rows.push({ label: input.discount.label, amount: input.discount.amount });
  if (input.fees) rows.push({ label: input.fees.label, amount: input.fees.amount });
  if (input.taxLabel != null && input.tax != null) rows.push({ label: input.taxLabel, amount: input.tax });
  return rows;
}
