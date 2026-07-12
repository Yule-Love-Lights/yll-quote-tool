// Ledger #87(a) — Invoice PDF. Renders an InvoiceDocModel ONLY — every figure
// is already a formatted string produced by buildInvoiceDocModel
// (src/lib/pdf/docModels.ts); this component does no math.

import { Document, Page, View, Text } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';
import { PdfHeader } from './PdfHeader';
import { PdfFooter } from './PdfFooter';
import type { InvoiceDocModel } from '@/lib/pdf/docModels';

type Props = {
  model: InvoiceDocModel;
  logo?: Buffer | null;
};

export function InvoicePdf({ model, logo }: Props) {
  return (
    <Document title={`Yule Love Lights Invoice ${model.invoiceNumber}`}>
      <Page size="LETTER" style={pdfStyles.page}>
        <PdfHeader logo={logo} docTitle="Invoice" docNumber={`#${model.invoiceNumber}`} docDate={model.date} />

        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionLabel}>Billed to</Text>
          <Text style={pdfStyles.customerName}>{model.customerName}</Text>
          {model.customerAddress ? <Text style={pdfStyles.customerLine}>{model.customerAddress}</Text> : null}
        </View>

        <View style={pdfStyles.table}>
          <View style={pdfStyles.tableHeaderRow}>
            <Text style={pdfStyles.tableHeaderLabel}>Line</Text>
            <Text style={pdfStyles.tableHeaderLabel}>Amount</Text>
          </View>
          {model.lines.map((line, i) => (
            <View
              key={`${line.label}-${i}`}
              style={i === model.lines.length - 1 ? { ...pdfStyles.row, ...pdfStyles.rowLast } : pdfStyles.row}
            >
              <Text style={pdfStyles.rowLabel}>{line.label}</Text>
              <Text style={pdfStyles.rowAmount}>{line.amount}</Text>
            </View>
          ))}
        </View>

        <View style={pdfStyles.totalsBlock}>
          <View style={pdfStyles.grandTotalRow}>
            <Text style={pdfStyles.grandTotalLabel}>Balance due</Text>
            <Text style={pdfStyles.grandTotalAmount}>{model.balanceDue}</Text>
          </View>
        </View>

        {model.creditNote && (
          <View style={pdfStyles.depositBanner}>
            <Text style={pdfStyles.depositLabel}>Overpaid — credit (manual refund)</Text>
            <Text style={pdfStyles.depositAmount}>{model.creditNote}</Text>
          </View>
        )}

        {model.paidDate && (
          <View style={pdfStyles.paidBanner}>
            <Text style={pdfStyles.paidLabel}>Paid</Text>
            <Text style={pdfStyles.paidDate}>{model.paidDate}</Text>
          </View>
        )}

        <PdfFooter />
      </Page>
    </Document>
  );
}
