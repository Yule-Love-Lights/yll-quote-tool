// Ledger #87(a) — customer Quote PDF. Renders a QuoteDocModel ONLY — every
// figure on the page is already a formatted string produced by
// buildQuoteDocModel (src/lib/pdf/docModels.ts); this component does no math.

import { Document, Page, View, Text } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';
import { PdfHeader } from './PdfHeader';
import { PdfFooter } from './PdfFooter';
import type { QuoteDocModel } from '@/lib/pdf/docModels';

type Props = {
  model: QuoteDocModel;
  logo?: Buffer | null;
};

export function QuotePdf({ model, logo }: Props) {
  return (
    <Document title={`Yule Love Lights Quote ${model.quoteNumber}`}>
      <Page size="LETTER" style={pdfStyles.page}>
        <PdfHeader
          logo={logo}
          docTitle={model.isApproved ? 'Quote (Approved)' : 'Quote'}
          docNumber={model.quoteNumber}
          docDate={model.date}
        />

        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionLabel}>Prepared for</Text>
          <Text style={pdfStyles.customerName}>{model.customerName}</Text>
          {model.customerAddress ? <Text style={pdfStyles.customerLine}>{model.customerAddress}</Text> : null}
        </View>

        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionLabel}>{model.packageName}</Text>
          <View style={pdfStyles.table}>
            <View style={pdfStyles.tableHeaderRow}>
              <Text style={pdfStyles.tableHeaderLabel}>Item</Text>
              <Text style={pdfStyles.tableHeaderLabel}>Price</Text>
            </View>
            {model.lineItems.length === 0 ? (
              <Text style={pdfStyles.emptyNote}>No line items on this quote yet.</Text>
            ) : (
              model.lineItems.map((li, i) => (
                <View
                  key={`${li.label}-${i}`}
                  style={i === model.lineItems.length - 1 ? { ...pdfStyles.row, ...pdfStyles.rowLast } : pdfStyles.row}
                >
                  <View>
                    <Text style={pdfStyles.rowLabel}>{li.label}</Text>
                    {li.detail ? <Text style={pdfStyles.rowDetail}>{li.detail}</Text> : null}
                  </View>
                  <Text style={pdfStyles.rowAmount}>{li.amount}</Text>
                </View>
              ))
            )}
          </View>
        </View>

        <View style={pdfStyles.totalsBlock}>
          <View style={pdfStyles.grandTotalRow}>
            <Text style={pdfStyles.grandTotalLabel}>Total</Text>
            <Text style={pdfStyles.grandTotalAmount}>{model.total}</Text>
          </View>
        </View>

        <View style={pdfStyles.depositBanner}>
          <Text style={pdfStyles.depositLabel}>{model.isApproved ? 'Deposit paid at approval' : 'Deposit due to book'}</Text>
          <Text style={pdfStyles.depositAmount}>{model.depositDue}</Text>
        </View>

        <PdfFooter />
      </Page>
    </Document>
  );
}
