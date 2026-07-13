// Ledger #87(a) — Receipt PDF: what money actually changed hands, redesigned
// to match the company's Jobber invoice format. Renders a ReceiptDocModel
// ONLY — every figure is already a formatted string produced by
// buildReceiptDocModel (src/lib/pdf/docModels.ts); this component does no
// math. Per Naldo's #87a scope, the receipt emphasizes what was PAID (no
// Subtotal/Discount/Fees/Tax breakdown — that's the invoice's job).

import { Document, Page, View, Text, Link } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';
import { PdfHeader } from './PdfHeader';
import { PdfFooter } from './PdfFooter';
import { PdfWatermark } from './PdfWatermark';
import { PdfRecipientBlock } from './PdfRecipientBlock';
import { PdfMetaCard } from './PdfMetaCard';
import { PdfLineItemsTable } from './PdfLineItemsTable';
import { PdfTotalsStack, type PdfTotalsRow } from './PdfTotalsStack';
import type { ReceiptDocModel } from '@/lib/pdf/docModels';

type Props = {
  model: ReceiptDocModel;
  logo?: Buffer | null;
};

export function ReceiptPdf({ model, logo }: Props) {
  const cancelled = model.status === 'cancelled';
  const watermarkStatus = cancelled ? 'cancelled' : model.status === 'paid' ? 'paid' : null;

  const rows: PdfTotalsRow[] = [];
  if (model.depositPaid) rows.push({ label: `Deposit paid (${model.depositPaid.date})`, amount: model.depositPaid.amount });
  if (model.balancePaid) rows.push({ label: `Remaining balance paid (${model.balancePaid.date})`, amount: model.balancePaid.amount });
  rows.push({ label: 'Total paid', amount: model.totalPaid, bold: true });

  const dateRows = [
    { label: 'Issued', value: model.date },
    ...(model.paidDate ? [{ label: 'Paid', value: model.paidDate }] : []),
  ];

  return (
    <Document title={`Yule Love Lights Receipt ${model.receiptNumber}`}>
      <Page size="LETTER" style={pdfStyles.page}>
        <PdfWatermark status={watermarkStatus} />
        <PdfHeader logo={logo} />

        <View style={pdfStyles.metaRow}>
          <PdfRecipientBlock recipient={model.recipient} />
          <PdfMetaCard
            title={`Receipt #${model.receiptNumber}`}
            dateRows={dateRows}
            totalLabel="Total paid"
            totalValue={model.totalPaid}
          />
        </View>

        {cancelled && (
          <Text style={{ fontSize: 10, fontFamily: 'Helvetica-Bold', color: '#b91c1c', marginBottom: 12 }}>
            This order was cancelled — reference only.
          </Text>
        )}

        <Text style={pdfStyles.docSectionTitle}>For Yule Love Lights {model.serviceType} Installation</Text>

        <PdfLineItemsTable items={model.lineItems} />
        <PdfTotalsStack rows={rows} />

        {model.valorReceiptUrl && (
          <View style={{ marginTop: 16 }}>
            <Text style={pdfStyles.sectionLabel}>PAYMENT PROCESSOR RECEIPT</Text>
            <Link src={model.valorReceiptUrl} style={{ fontSize: 9, color: '#1f6f43', textDecoration: 'underline' }}>
              {model.valorReceiptUrl}
            </Link>
          </View>
        )}

        <PdfFooter />
      </Page>
    </Document>
  );
}
