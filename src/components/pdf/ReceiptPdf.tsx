// Ledger #87(a) — Receipt PDF: what money actually changed hands. Renders a
// ReceiptDocModel ONLY — every figure is already a formatted string produced
// by buildReceiptDocModel (src/lib/pdf/docModels.ts); this component does no
// math.

import { Document, Page, View, Text, Link } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';
import { PdfHeader } from './PdfHeader';
import { PdfFooter } from './PdfFooter';
import type { ReceiptDocModel } from '@/lib/pdf/docModels';

type Props = {
  model: ReceiptDocModel;
  logo?: Buffer | null;
};

export function ReceiptPdf({ model, logo }: Props) {
  const cancelled = model.status === 'cancelled';

  return (
    <Document title={`Yule Love Lights Receipt ${model.receiptNumber}`}>
      <Page size="LETTER" style={pdfStyles.page}>
        <PdfHeader
          logo={logo}
          docTitle="Receipt"
          docNumber={`#${model.receiptNumber}`}
          statusLabel={cancelled ? 'CANCELLED' : null}
        />

        {/* #87(a) fix-batch MED #4 — a cancelled order's receipt must never
            look like a valid record of a payable/current document. */}
        {cancelled && (
          <View style={pdfStyles.cancelledBanner}>
            <Text style={pdfStyles.cancelledLabel}>This order was cancelled</Text>
            <Text style={pdfStyles.cancelledText}>Reference only</Text>
          </View>
        )}

        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionLabel}>Received from</Text>
          <Text style={pdfStyles.customerName}>{model.customerName}</Text>
          {model.customerAddress ? <Text style={pdfStyles.customerLine}>{model.customerAddress}</Text> : null}
        </View>

        <View style={pdfStyles.table}>
          <View style={pdfStyles.tableHeaderRow}>
            <Text style={pdfStyles.tableHeaderLabel}>Payment</Text>
            <Text style={pdfStyles.tableHeaderLabel}>Amount</Text>
          </View>
          {model.depositPaid && (
            <View style={pdfStyles.row}>
              <View>
                <Text style={pdfStyles.rowLabel}>Deposit</Text>
                <Text style={pdfStyles.rowDetail}>Paid {model.depositPaid.date}</Text>
              </View>
              <Text style={pdfStyles.rowAmount}>{model.depositPaid.amount}</Text>
            </View>
          )}
          {model.balancePaid && (
            <View style={{ ...pdfStyles.row, ...pdfStyles.rowLast }}>
              <View>
                <Text style={pdfStyles.rowLabel}>Remaining balance</Text>
                <Text style={pdfStyles.rowDetail}>Paid {model.balancePaid.date}</Text>
              </View>
              <Text style={pdfStyles.rowAmount}>{model.balancePaid.amount}</Text>
            </View>
          )}
          {!model.depositPaid && !model.balancePaid && (
            <Text style={pdfStyles.emptyNote}>No payment recorded yet.</Text>
          )}
        </View>

        <View style={pdfStyles.paidBanner}>
          <Text style={pdfStyles.paidLabel}>Total paid</Text>
          <Text style={pdfStyles.paidAmount}>{model.totalPaid}</Text>
        </View>

        {model.valorReceiptUrl && (
          <View style={pdfStyles.section}>
            <Text style={pdfStyles.sectionLabel}>Payment processor receipt</Text>
            <Link src={model.valorReceiptUrl} style={pdfStyles.link}>
              {model.valorReceiptUrl}
            </Link>
          </View>
        )}

        <PdfFooter />
      </Page>
    </Document>
  );
}
