// Ledger #87(a) Jobber-format redesign — the bottom-right totals stack
// (Subtotal / Discount / Fees / Sales Tax / Total / Deposit collected / Paid /
// Invoice balance / Account balance, or whichever subset a given doc prints).
// Each caller (QuotePdf/InvoicePdf/ReceiptPdf) assembles its own row list from
// its doc-model's ALREADY-reconciling figures — this component only lays them
// out, it does no math.

import { View, Text } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';

export type PdfTotalsRow = { label: string; amount: string; bold?: boolean };

type Props = {
  rows: PdfTotalsRow[];
};

export function PdfTotalsStack({ rows }: Props) {
  return (
    <View style={pdfStyles.totalsBlock} wrap={false}>
      {rows.map((row, i) => {
        const isLast = i === rows.length - 1;
        const base = row.bold ? pdfStyles.totalsRowBold : pdfStyles.totalsRow;
        return (
          <View key={`${row.label}-${i}`} style={isLast ? { ...base, ...pdfStyles.totalsRowLast } : base}>
            <Text style={row.bold ? pdfStyles.totalsLabelBold : pdfStyles.totalsLabel}>{row.label}</Text>
            <Text style={row.bold ? pdfStyles.totalsAmountBold : pdfStyles.totalsAmount}>{row.amount}</Text>
          </View>
        );
      })}
    </View>
  );
}
