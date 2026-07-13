// Ledger #87(a) — customer Quote PDF, redesigned to match the company's
// Jobber invoice format. Renders a QuoteDocModel ONLY — every figure on the
// page is already a formatted string produced by buildQuoteDocModel
// (src/lib/pdf/docModels.ts); this component does no math.

import { Document, Page, View, Text } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';
import { PdfHeader } from './PdfHeader';
import { PdfFooter } from './PdfFooter';
import { PdfWatermark } from './PdfWatermark';
import { PdfRecipientBlock } from './PdfRecipientBlock';
import { PdfMetaCard } from './PdfMetaCard';
import { PdfLineItemsTable } from './PdfLineItemsTable';
import { PdfTotalsStack } from './PdfTotalsStack';
import { PdfContractTerms } from './PdfContractTerms';
import { itemizedRows } from './totalsRows';
import type { QuoteDocModel } from '@/lib/pdf/docModels';

type Props = {
  model: QuoteDocModel;
  logo?: Buffer | null;
};

export function QuotePdf({ model, logo }: Props) {
  const rows = [...itemizedRows(model), { label: 'Total', amount: model.total, bold: true }, { label: 'Deposit due', amount: model.depositDue }];

  return (
    <Document title={`Yule Love Lights Quote ${model.quoteNumber}`}>
      <Page size="LETTER" style={pdfStyles.page}>
        <PdfWatermark status={model.status} />
        <PdfHeader logo={logo} />

        <View style={pdfStyles.metaRow}>
          <PdfRecipientBlock recipient={model.recipient} />
          <PdfMetaCard
            title={`Quote ${model.quoteNumber}`}
            dateRows={[{ label: 'Issued', value: model.date }]}
            totalLabel="Total"
            totalValue={model.total}
          />
        </View>

        <Text style={pdfStyles.docSectionTitle}>For Yule Love Lights {model.serviceType} Installation</Text>

        <PdfLineItemsTable items={model.lineItems} />
        <PdfTotalsStack rows={rows} />
        <PdfContractTerms />

        <PdfFooter />
      </Page>
    </Document>
  );
}
