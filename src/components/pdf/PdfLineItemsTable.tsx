// Ledger #87(a) Jobber-format redesign — the coral-headed line-items table:
// Product/Service | Description | Qty. | Unit Price | Total. Renders a
// PdfLineItem[] ONLY (already-formatted strings from docModels.ts) — no math.

import { View, Text } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';
import type { PdfLineItem } from '@/lib/pdf/docModels';

type Props = {
  items: PdfLineItem[];
};

export function PdfLineItemsTable({ items }: Props) {
  return (
    <View style={pdfStyles.table}>
      <View style={pdfStyles.tableHeaderRow}>
        <Text style={[pdfStyles.tableHeaderLabel, pdfStyles.colProduct]}>Product/Service</Text>
        <Text style={[pdfStyles.tableHeaderLabel, pdfStyles.colDescription]}>Description</Text>
        <Text style={[pdfStyles.tableHeaderLabel, pdfStyles.colQty]}>Qty.</Text>
        <Text style={[pdfStyles.tableHeaderLabel, pdfStyles.colUnitPrice]}>Unit Price</Text>
        <Text style={[pdfStyles.tableHeaderLabel, pdfStyles.colTotal]}>Total</Text>
      </View>
      {items.length === 0 ? (
        <Text style={pdfStyles.emptyNote}>No line items on this order yet.</Text>
      ) : (
        items.map((li, i) => (
          <View key={`${li.label}-${i}`} style={pdfStyles.tableRow} wrap={false}>
            <Text style={[pdfStyles.productLabel, pdfStyles.colProduct]}>{li.label}</Text>
            <Text style={[pdfStyles.descriptionText, pdfStyles.colDescription]}>{li.detail}</Text>
            <Text style={[pdfStyles.cellText, pdfStyles.colQty]}>{li.qty}</Text>
            <Text style={[pdfStyles.cellText, pdfStyles.colUnitPrice]}>{li.unitPrice}</Text>
            <Text style={[pdfStyles.cellText, pdfStyles.colTotal]}>{li.amount}</Text>
          </View>
        ))
      )}
    </View>
  );
}
