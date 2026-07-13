// Ledger #87(a) — Invoice PDF, redesigned to match the company's Jobber
// invoice format. Renders an InvoiceDocModel ONLY — every figure is already a
// formatted string produced by buildInvoiceDocModel (src/lib/pdf/docModels.ts);
// this component does no math, including the +/- signs below (they mirror
// the model's own reconciling identity: Total - Deposit - Paid + Credit ===
// Invoice balance, documented on buildInvoiceDocModel). Plain ASCII hyphens,
// not the typographic minus (U+2212) — react-pdf's standard Helvetica font
// has no glyph for U+2212 and silently drops it, rendering the amount with
// no sign at all (verified against an actual rendered PDF).

import { Document, Page, View, Text } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';
import { PdfHeader } from './PdfHeader';
import { PdfFooter } from './PdfFooter';
import { PdfWatermark } from './PdfWatermark';
import { PdfRecipientBlock } from './PdfRecipientBlock';
import { PdfMetaCard } from './PdfMetaCard';
import { PdfLineItemsTable } from './PdfLineItemsTable';
import { PdfTotalsStack, type PdfTotalsRow } from './PdfTotalsStack';
import { PdfContractTerms } from './PdfContractTerms';
import { itemizedRows } from './totalsRows';
import type { InvoiceDocModel } from '@/lib/pdf/docModels';

type Props = {
  model: InvoiceDocModel;
  logo?: Buffer | null;
};

// A $0.00 deduction line shouldn't print as the odd-looking "-$0.00" — only
// sign amounts that are actually nonzero.
function asDeduction(amount: string): string {
  return amount === '$0.00' ? amount : `-${amount}`;
}

export function InvoicePdf({ model, logo }: Props) {
  const cancelled = model.status === 'cancelled';
  const watermarkStatus = cancelled ? 'cancelled' : model.status === 'paid' ? 'paid' : null;

  const rows: PdfTotalsRow[] = [
    ...itemizedRows(model),
    { label: 'Total', amount: model.total, bold: true },
    { label: 'Deposit collected', amount: asDeduction(model.depositCollected) },
    { label: 'Paid', amount: asDeduction(model.paidTowardBalance) },
  ];
  if (model.creditNote) {
    rows.push({ label: 'Credit (overpaid — manual refund)', amount: `+${model.creditNote}` });
  }
  rows.push({ label: 'Invoice balance', amount: model.invoiceBalance, bold: true });
  rows.push({ label: 'Account balance', amount: model.accountBalance });

  const dateRows = [
    { label: 'Issued', value: model.date },
    { label: 'Due', value: model.dueDate },
    ...(model.paidDate ? [{ label: 'Paid', value: model.paidDate }] : []),
  ];

  return (
    <Document title={`Yule Love Lights Invoice ${model.invoiceNumber}`}>
      <Page size="LETTER" style={pdfStyles.page}>
        <PdfWatermark status={watermarkStatus} />
        <PdfHeader logo={logo} />

        <View style={pdfStyles.metaRow}>
          <PdfRecipientBlock recipient={model.recipient} />
          <PdfMetaCard
            title={`Invoice #${model.invoiceNumber}`}
            dateRows={dateRows}
            totalLabel="Total"
            totalValue={model.total}
            accountBalance={model.accountBalance}
          />
        </View>

        {cancelled && (
          <Text style={{ fontSize: 10, fontFamily: 'Helvetica-Bold', color: '#b91c1c', marginBottom: 12 }}>
            This order was cancelled — not payable.
          </Text>
        )}

        <Text style={pdfStyles.docSectionTitle}>For Yule Love Lights {model.serviceType} Installation</Text>

        <PdfLineItemsTable items={model.lineItems} />
        <PdfTotalsStack rows={rows} />
        <PdfContractTerms />

        <PdfFooter />
      </Page>
    </Document>
  );
}
